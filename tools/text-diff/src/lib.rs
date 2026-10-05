//! Bounded line differencing for Turen agent tools.
//!
//! Computes added and removed line counts and a unified patch between two
//! byte strings. The patch is byte-compatible with the `diff` npm package's
//! `createTwoFilesPatch` (the format Turen's edit tools and review tab already
//! consume): an optional `Index:` line, a 67-character `=` rule, `---`/`+++`
//! names, hunks whose counts are always printed, removals before additions,
//! and `\ No newline at end of file` after a final line that lacks one.
//!
//! The wrapper is deterministic and offline: no filesystem, network,
//! environment, clock, or subprocess access. There is deliberately no
//! wall-clock deadline, because a deadline would make the result depend on
//! timing. Work is bounded by a budget instead: Myers is O((n+m)·D) with
//! D <= n+m, so a region is diffed exactly while its (n+m)^2 fits what is left
//! of `WORK_BUDGET`. A larger region is split at lines that occur once on each
//! side, and a gap that still does not fit is reported as one replaced block.
//! Either way the result says `approximate`: the patch is valid and its counts
//! are accurate for it, but it is not guaranteed to be a minimal diff.

use serde::Deserialize;
use similar::{capture_diff_slices, group_diff_ops, Algorithm, DiffOp};
use std::borrow::Cow;
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_OPTIONS_BYTES: usize = 4096;
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_NAME_BYTES: usize = 1024;
const MAX_CONTEXT: usize = 64;
const DEFAULT_CONTEXT: usize = 4;
/// Total Myers work, counted as (old+new lines)^2 per region diffed, shared by the whole request. A single
/// region of about 28,000 differing lines is exact; the worst case is about 8e8 steps, a second or two.
const WORK_BUDGET: usize = 800_000_000;
const RULE: &str = "===================================================================";
const NO_NEWLINE: &str = "\\ No newline at end of file\n";

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    old_name: Option<String>,
    new_name: Option<String>,
    context: Option<usize>,
    /// Counts only when false; skips building the patch text.
    patch: Option<bool>,
}

/// Diffs two files line by line.
///
/// `options_json` is `{"oldName"?, "newName"?, "context"?, "patch"?}`. Always returns JSON: a result with
/// `schema_version`, `binary`, `additions`, `deletions`, `approximate`, `lossy`, `patch` and `patchTruncated`,
/// or `{"schema_version":1,"error":"<code>","message":"<detail>"}`.
#[wasm_bindgen]
pub fn diff_text(before: &[u8], after: &[u8], options_json: &str) -> String {
    match run(before, after, options_json) {
        Ok(output) => output,
        Err((code, message)) => error(code, &message),
    }
}

fn run(before: &[u8], after: &[u8], options_json: &str) -> Result<String, (&'static str, String)> {
    if options_json.len() > MAX_OPTIONS_BYTES {
        return Err(("options_too_large", format!("options exceed {MAX_OPTIONS_BYTES} bytes")));
    }
    let options: Options = if options_json.trim().is_empty() {
        Options::default()
    } else {
        serde_json::from_str(options_json).map_err(|cause| ("options_invalid", cause.to_string()))?
    };
    if before.len() > MAX_INPUT_BYTES || after.len() > MAX_INPUT_BYTES {
        return Err(("input_too_large", format!("each input is limited to {MAX_INPUT_BYTES} bytes")));
    }
    let old_name = options.old_name.unwrap_or_else(|| "a".into());
    let new_name = options.new_name.unwrap_or_else(|| "b".into());
    if old_name.len() > MAX_NAME_BYTES || new_name.len() > MAX_NAME_BYTES {
        return Err(("options_invalid", format!("names are limited to {MAX_NAME_BYTES} bytes")));
    }
    // git's own rule for "binary": a NUL byte. Counts are reported as zero, like `git diff --numstat`'s `-`.
    if before.contains(&0) || after.contains(&0) {
        return Ok(document(true, 0, 0, false, false, None, false));
    }
    let (old_text, new_text) = (String::from_utf8_lossy(before), String::from_utf8_lossy(after));
    let lossy = matches!(old_text, Cow::Owned(_)) || matches!(new_text, Cow::Owned(_));
    let old: Vec<&str> = old_text.split_inclusive('\n').collect();
    let new: Vec<&str> = new_text.split_inclusive('\n').collect();

    let (ops, approximate) = line_ops(&old, &new);
    let counts = count(&ops);
    let context = options.context.unwrap_or(DEFAULT_CONTEXT).min(MAX_CONTEXT);
    let patch = if options.patch == Some(false) {
        None
    } else {
        Some(render(&old, &new, &ops, context, &old_name, &new_name))
    };
    let (patch, truncated) = match patch {
        Some(Some(text)) => (Some(text), false),
        Some(None) => (None, true),
        None => (None, false),
    };
    Ok(document(false, counts.0, counts.1, approximate, lossy, patch, truncated))
}

/// The edit script, and whether it is only guaranteed valid rather than minimal.
fn line_ops(old: &[&str], new: &[&str]) -> (Vec<DiffOp>, bool) {
    let mut budget = WORK_BUDGET;
    let mut ops = Vec::new();
    let mut approximate = false;
    segment(old, new, 0, 0, &mut budget, &mut approximate, true, &mut ops);
    // Hunks are cut by the length of a single `Equal` op, so a run of unchanged lines that anchoring emitted
    // one line at a time must be joined, or it would never look long enough to separate two hunks.
    let mut joined: Vec<DiffOp> = Vec::with_capacity(ops.len());
    for op in ops {
        if let (Some(DiffOp::Equal { len: total, .. }), DiffOp::Equal { len, .. }) = (joined.last_mut(), op) {
            *total += len;
            continue;
        }
        joined.push(op);
    }
    (joined, approximate)
}

/// Diffs one region exactly when it fits the shared work budget.
///
/// A region too large for the budget is split at lines that occur exactly once on each side (patience
/// anchors: the longest increasing run of such lines), and each gap is diffed the same way from the same
/// budget. A gap that still does not fit becomes one replaced block. Anchoring is only tried once per
/// region (`anchor`), so the recursion is one level deep.
#[allow(clippy::too_many_arguments)]
fn segment(
    old: &[&str],
    new: &[&str],
    old_base: usize,
    new_base: usize,
    budget: &mut usize,
    approximate: &mut bool,
    anchor: bool,
    ops: &mut Vec<DiffOp>,
) {
    let limit = old.len().min(new.len());
    let prefix = (0..limit).take_while(|&index| old[index] == new[index]).count();
    let suffix = (0..limit - prefix)
        .take_while(|&index| old[old.len() - 1 - index] == new[new.len() - 1 - index])
        .count();
    if prefix > 0 {
        ops.push(DiffOp::Equal { old_index: old_base, new_index: new_base, len: prefix });
    }
    let (old_mid, new_mid) = (&old[prefix..old.len() - suffix], &new[prefix..new.len() - suffix]);
    let (old_at, new_at) = (old_base + prefix, new_base + prefix);
    let size = old_mid.len() + new_mid.len();
    if size == 0 {
        // Nothing differs between the trimmed ends.
    } else if old_mid.is_empty() {
        ops.push(DiffOp::Insert { old_index: old_at, new_index: new_at, new_len: new_mid.len() });
    } else if new_mid.is_empty() {
        ops.push(DiffOp::Delete { old_index: old_at, old_len: old_mid.len(), new_index: new_at });
    } else if size.saturating_mul(size) <= *budget {
        // Myers costs O((n+m)·D) and D <= n+m, so (n+m)^2 is a ceiling on its steps.
        *budget -= size * size;
        ops.extend(
            capture_diff_slices(Algorithm::Myers, old_mid, new_mid)
                .into_iter()
                .map(|op| shift(op, old_at, new_at)),
        );
    } else {
        *approximate = true;
        let anchors = if anchor { anchors(old_mid, new_mid) } else { Vec::new() };
        if anchors.is_empty() {
            ops.push(DiffOp::Replace { old_index: old_at, old_len: old_mid.len(), new_index: new_at, new_len: new_mid.len() });
        } else {
            let (mut old_from, mut new_from) = (0, 0);
            for &(old_anchor, new_anchor) in &anchors {
                let gap = (&old_mid[old_from..old_anchor], &new_mid[new_from..new_anchor]);
                segment(gap.0, gap.1, old_at + old_from, new_at + new_from, budget, approximate, false, ops);
                ops.push(DiffOp::Equal { old_index: old_at + old_anchor, new_index: new_at + new_anchor, len: 1 });
                (old_from, new_from) = (old_anchor + 1, new_anchor + 1);
            }
            let gap = (&old_mid[old_from..], &new_mid[new_from..]);
            segment(gap.0, gap.1, old_at + old_from, new_at + new_from, budget, approximate, false, ops);
        }
    }
    if suffix > 0 {
        ops.push(DiffOp::Equal { old_index: old_base + old.len() - suffix, new_index: new_base + new.len() - suffix, len: suffix });
    }
}

/// Lines present exactly once in each side, as the longest run whose positions increase together.
fn anchors(old: &[&str], new: &[&str]) -> Vec<(usize, usize)> {
    let mut seen: HashMap<&str, (usize, usize, usize)> = HashMap::new();
    for (index, line) in old.iter().enumerate() {
        let entry = seen.entry(line).or_insert((0, 0, index));
        entry.0 += 1;
    }
    let mut pairs: Vec<(usize, usize)> = Vec::new();
    let mut new_counts: HashMap<&str, usize> = HashMap::new();
    for line in new {
        *new_counts.entry(line).or_insert(0) += 1;
    }
    for (index, line) in new.iter().enumerate() {
        if let Some(&(1, _, old_index)) = seen.get(line) {
            if new_counts[line] == 1 {
                pairs.push((old_index, index));
            }
        }
    }
    pairs.sort_unstable();
    // Patience sorting on the new-side positions, keeping predecessor links to rebuild the run.
    let mut tails: Vec<usize> = Vec::new();
    let mut previous: Vec<Option<usize>> = vec![None; pairs.len()];
    for (position, &(_, new_index)) in pairs.iter().enumerate() {
        let slot = tails.partition_point(|&tail| pairs[tail].1 < new_index);
        previous[position] = slot.checked_sub(1).map(|before| tails[before]);
        if slot == tails.len() {
            tails.push(position);
        } else {
            tails[slot] = position;
        }
    }
    let mut run = Vec::with_capacity(tails.len());
    let mut cursor = tails.last().copied();
    while let Some(position) = cursor {
        run.push(pairs[position]);
        cursor = previous[position];
    }
    run.reverse();
    run
}

fn shift(op: DiffOp, old_by: usize, new_by: usize) -> DiffOp {
    match op {
        DiffOp::Equal { old_index, new_index, len } => {
            DiffOp::Equal { old_index: old_index + old_by, new_index: new_index + new_by, len }
        }
        DiffOp::Delete { old_index, old_len, new_index } => {
            DiffOp::Delete { old_index: old_index + old_by, old_len, new_index: new_index + new_by }
        }
        DiffOp::Insert { old_index, new_index, new_len } => {
            DiffOp::Insert { old_index: old_index + old_by, new_index: new_index + new_by, new_len }
        }
        DiffOp::Replace { old_index, old_len, new_index, new_len } => {
            DiffOp::Replace { old_index: old_index + old_by, old_len, new_index: new_index + new_by, new_len }
        }
    }
}

fn count(ops: &[DiffOp]) -> (usize, usize) {
    ops.iter().fold((0, 0), |(additions, deletions), op| match *op {
        DiffOp::Equal { .. } => (additions, deletions),
        DiffOp::Delete { old_len, .. } => (additions, deletions + old_len),
        DiffOp::Insert { new_len, .. } => (additions + new_len, deletions),
        DiffOp::Replace { old_len, new_len, .. } => (additions + new_len, deletions + old_len),
    })
}

/// The unified patch, or `None` once it would exceed the output bound.
fn render(
    old: &[&str],
    new: &[&str],
    ops: &[DiffOp],
    context: usize,
    old_name: &str,
    new_name: &str,
) -> Option<String> {
    let mut patch = String::new();
    if old_name == new_name {
        patch.push_str("Index: ");
        patch.push_str(old_name);
        patch.push('\n');
    }
    patch.push_str(RULE);
    patch.push_str("\n--- ");
    patch.push_str(old_name);
    patch.push_str("\n+++ ");
    patch.push_str(new_name);
    patch.push('\n');

    for group in group_diff_ops(ops.to_vec(), context) {
        let (first, last) = (group.first()?.old_range().start, group.last()?.old_range().end);
        let (new_first, new_last) = (group.first()?.new_range().start, group.last()?.new_range().end);
        let (old_len, new_len) = (last - first, new_last - new_first);
        // A range with no lines is addressed by the line before it, which is its zero-based start.
        let start = |index: usize, len: usize| if len == 0 { index } else { index + 1 };
        patch.push_str(&format!(
            "@@ -{},{} +{},{} @@\n",
            start(first, old_len),
            old_len,
            start(new_first, new_len),
            new_len
        ));
        // Removals before additions within a run of changes, as jsdiff prints them.
        let (mut removed, mut added) = (String::new(), String::new());
        let flush = |patch: &mut String, removed: &mut String, added: &mut String| {
            patch.push_str(removed);
            patch.push_str(added);
            removed.clear();
            added.clear();
        };
        for op in &group {
            match *op {
                DiffOp::Equal { old_index, len, .. } => {
                    flush(&mut patch, &mut removed, &mut added);
                    old[old_index..old_index + len].iter().for_each(|line| push_line(&mut patch, ' ', line));
                }
                DiffOp::Delete { old_index, old_len, .. } => {
                    old[old_index..old_index + old_len].iter().for_each(|line| push_line(&mut removed, '-', line))
                }
                DiffOp::Insert { new_index, new_len, .. } => {
                    new[new_index..new_index + new_len].iter().for_each(|line| push_line(&mut added, '+', line))
                }
                DiffOp::Replace { old_index, old_len, new_index, new_len } => {
                    old[old_index..old_index + old_len].iter().for_each(|line| push_line(&mut removed, '-', line));
                    new[new_index..new_index + new_len].iter().for_each(|line| push_line(&mut added, '+', line));
                }
            }
            if patch.len() + removed.len() + added.len() > MAX_OUTPUT_BYTES {
                return None;
            }
        }
        flush(&mut patch, &mut removed, &mut added);
        if patch.len() > MAX_OUTPUT_BYTES {
            return None;
        }
    }
    Some(patch)
}

fn push_line(output: &mut String, marker: char, line: &str) {
    output.push(marker);
    output.push_str(line);
    if !line.ends_with('\n') {
        output.push('\n');
        output.push_str(NO_NEWLINE);
    }
}

fn document(
    binary: bool,
    additions: usize,
    deletions: usize,
    approximate: bool,
    lossy: bool,
    patch: Option<String>,
    truncated: bool,
) -> String {
    let mut value = serde_json::json!({
        "schema_version": 1,
        "binary": binary,
        "additions": additions,
        "deletions": deletions,
        "approximate": approximate,
        "lossy": lossy,
        "patchTruncated": truncated,
    });
    if let Some(patch) = patch {
        value["patch"] = patch.into();
    }
    value.to_string()
}

fn error(code: &str, message: &str) -> String {
    serde_json::json!({ "schema_version": 1, "error": code, "message": message }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diff(before: &str, after: &str, options: &str) -> serde_json::Value {
        serde_json::from_str(&diff_text(before.as_bytes(), after.as_bytes(), options)).unwrap()
    }

    fn patch(before: &str, after: &str) -> String {
        diff(before, after, r#"{"oldName":"a.txt","newName":"a.txt"}"#)["patch"].as_str().unwrap().to_string()
    }

    const HEAD: &str = "Index: a.txt\n===================================================================\n--- a.txt\n+++ a.txt\n";

    // The expected strings below are what jsdiff 8.0.4's createTwoFilesPatch printed for the same inputs.
    #[test]
    fn matches_jsdiff_for_a_simple_modification() {
        assert_eq!(patch("one\ntwo\nthree\n", "one\nTWO\nthree\n"), format!("{HEAD}@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n"));
    }

    #[test]
    fn marks_a_missing_final_newline_after_the_line_that_lacks_it() {
        assert_eq!(patch("a\nb", "a\nb\n"), format!("{HEAD}@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n"));
        assert_eq!(patch("a\nb\n", "a\nb"), format!("{HEAD}@@ -1,2 +1,2 @@\n a\n-b\n+b\n\\ No newline at end of file\n"));
        assert_eq!(patch("x\nsame", "y\nsame"), format!("{HEAD}@@ -1,2 +1,2 @@\n-x\n+y\n same\n\\ No newline at end of file\n"));
    }

    #[test]
    fn addresses_empty_ranges_the_way_jsdiff_does() {
        assert_eq!(patch("", "x\ny\n"), format!("{HEAD}@@ -0,0 +1,2 @@\n+x\n+y\n"));
        assert_eq!(patch("x\ny\n", ""), format!("{HEAD}@@ -1,2 +0,0 @@\n-x\n-y\n"));
        let insert = diff("1\n2\n3\n", "1\n2\nNEW\n3\n", r#"{"oldName":"a.txt","newName":"a.txt","context":0}"#);
        assert_eq!(insert["patch"], format!("{HEAD}@@ -2,0 +3,1 @@\n+NEW\n"));
        let delete = diff("1\n2\n3\n", "1\n3\n", r#"{"oldName":"a.txt","newName":"a.txt","context":0}"#);
        assert_eq!(delete["patch"], format!("{HEAD}@@ -2,1 +1,0 @@\n-2\n"));
    }

    #[test]
    fn splits_distant_changes_into_hunks_and_honours_context() {
        let before: String = (0..20).map(|index| format!("l{index}\n")).collect();
        let after: String = (0..20).map(|index| if index == 2 || index == 17 { "X\n".into() } else { format!("l{index}\n") }).collect();
        assert_eq!(
            patch(&before, &after),
            format!("{HEAD}@@ -1,7 +1,7 @@\n l0\n l1\n-l2\n+X\n l3\n l4\n l5\n l6\n@@ -14,7 +14,7 @@\n l13\n l14\n l15\n l16\n-l17\n+X\n l18\n l19\n")
        );
        let nine = "1\n2\n3\n4\n5\n6\n7\n8\n9\n";
        let changed = "1\n2\n3\n4\nFIVE\n6\n7\n8\n9\n";
        let narrow = diff(nine, changed, r#"{"oldName":"a.txt","newName":"a.txt","context":1}"#);
        assert_eq!(narrow["patch"], format!("{HEAD}@@ -4,3 +4,3 @@\n 4\n-5\n+FIVE\n 6\n"));
    }

    #[test]
    fn omits_the_index_line_for_different_names_and_keeps_crlf_bytes() {
        let renamed = diff("a\n", "b\n", r#"{"oldName":"old.txt","newName":"new.txt"}"#);
        assert_eq!(
            renamed["patch"],
            "===================================================================\n--- old.txt\n+++ new.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n"
        );
        assert_eq!(patch("a\r\nb\r\n", "a\r\nB\r\n"), format!("{HEAD}@@ -1,2 +1,2 @@\n a\r\n-b\r\n+B\r\n"));
    }

    #[test]
    fn identical_files_have_headers_and_no_hunks() {
        let result = diff("same\n", "same\n", r#"{"oldName":"a.txt","newName":"a.txt"}"#);
        assert_eq!(result["patch"], HEAD);
        assert_eq!((result["additions"].as_u64(), result["deletions"].as_u64()), (Some(0), Some(0)));
    }

    #[test]
    fn counts_added_and_removed_lines() {
        let result = diff("a\nb\nc\n", "a\nB\nc\nd\n", "");
        assert_eq!((result["additions"].as_u64(), result["deletions"].as_u64()), (Some(2), Some(1)));
        assert_eq!(result["approximate"], false);
    }

    #[test]
    fn counts_only_skips_the_patch() {
        let result = diff("a\n", "b\n", r#"{"patch":false}"#);
        assert!(result.get("patch").is_none());
        assert_eq!(result["additions"], 1);
    }

    #[test]
    fn nul_bytes_are_binary_with_zero_counts() {
        let result: serde_json::Value = serde_json::from_str(&diff_text(&[0, 1, 2], b"text\n", "")).unwrap();
        assert_eq!(result["binary"], true);
        assert_eq!((result["additions"].as_u64(), result["deletions"].as_u64()), (Some(0), Some(0)));
        assert!(result.get("patch").is_none());
    }

    #[test]
    fn invalid_utf8_is_decoded_lossily_and_flagged() {
        let result: serde_json::Value = serde_json::from_str(&diff_text(b"a\xff\n", b"a\n", "")).unwrap();
        assert_eq!(result["lossy"], true);
    }

    // 60,000 differing lines is (6e4)^2 = 3.6e9, over the work budget, and no line is shared to anchor on.
    #[test]
    fn a_huge_region_with_nothing_to_anchor_on_is_one_valid_approximate_block() {
        let before: String = (0..30_000).map(|index| format!("old {index}\n")).collect();
        let after: String = (0..30_000).map(|index| format!("new {index}\n")).collect();
        let result = diff(&format!("head\n{before}tail\n"), &format!("head\n{after}tail\n"), r#"{"oldName":"a","newName":"b"}"#);
        assert_eq!(result["approximate"], true);
        assert_eq!((result["additions"].as_u64(), result["deletions"].as_u64()), (Some(30_000), Some(30_000)));
        // One hunk: the unchanged first and last lines as context around the replaced block.
        let text = result["patch"].as_str().unwrap();
        assert!(text.contains("@@ -1,30002 +1,30002 @@\n head\n-old 0\n"));
        assert_eq!(text.lines().filter(|line| line.starts_with("@@ ")).count(), 1);
    }

    #[test]
    fn distant_edits_in_a_large_file_stay_small() {
        let base: Vec<String> = (0..50_000).map(|index| format!("line {index}\n")).collect();
        let mut edited = base.clone();
        edited[25_000] = "CHANGED\n".into();
        edited.insert(40_000, "INSERTED\n".into());
        let result = diff(&base.concat(), &edited.concat(), r#"{"oldName":"a","newName":"a"}"#);
        // Too large for one exact pass, so it is anchored and flagged, yet it finds the two real edits.
        assert_eq!(result["approximate"], true);
        assert_eq!((result["additions"].as_u64(), result["deletions"].as_u64()), (Some(2), Some(1)));
        let text = result["patch"].as_str().unwrap();
        assert_eq!(text.lines().filter(|line| line.starts_with("@@ ")).count(), 2);
        assert!(text.len() < 400);
    }

    #[test]
    fn a_region_within_budget_is_exact() {
        let base: Vec<String> = (0..10_000).map(|index| format!("line {index}\n")).collect();
        let mut edited = base.clone();
        edited[100] = "CHANGED\n".into();
        edited.remove(9_000);
        let result = diff(&base.concat(), &edited.concat(), "");
        assert_eq!(result["approximate"], false);
        assert_eq!((result["additions"].as_u64(), result["deletions"].as_u64()), (Some(1), Some(2)));
    }

    #[test]
    fn bounds_the_patch_and_rejects_bad_requests() {
        let before: String = (0..200_000).map(|index| format!("old line number {index}\n")).collect();
        let after: String = (0..200_000).map(|index| format!("new line number {index}\n")).collect();
        let large = diff(&before, &after, "");
        assert_eq!(large["patchTruncated"], true);
        assert!(large.get("patch").is_none());
        assert_eq!(large["additions"], 200_000);

        assert_eq!(diff("a", "b", "{nope")["error"], "options_invalid");
        assert_eq!(diff("a", "b", r#"{"unknown":1}"#)["error"], "options_invalid");
        assert_eq!(diff("a", "b", &" ".repeat(MAX_OPTIONS_BYTES + 1))["error"], "options_too_large");
        let oversized = vec![b'a'; MAX_INPUT_BYTES + 1];
        let rejected: serde_json::Value = serde_json::from_str(&diff_text(&oversized, b"", "")).unwrap();
        assert_eq!(rejected["error"], "input_too_large");
    }
}
