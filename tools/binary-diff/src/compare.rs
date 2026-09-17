//! Structural comparison (`binary_compare`) and the cheaper alignment-aware
//! changed-region report (`binary_regions`).
//!
//! Region records share one shape: `offset`/`old_offset` locate the changed
//! span in `new` and `old` respectively, `old_len`/`new_len` size the two
//! sides, `preview` is hex of up to 32 bytes of the changed content (new side,
//! or old side for pure deletions), and `old_entropy`/`new_entropy` plus
//! `old_class`/`new_class` describe the byte-class shift inside the span.

use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

use serde::Serialize;

use crate::{hex_string, sha256_hex, MAX_PREVIEW_BYTES, MAX_REGIONS, REGION_BLOCK_SIZE};

#[derive(Serialize)]
pub(crate) struct Region {
    /// Offset of the changed span in `new`.
    offset: usize,
    /// Offset of the corresponding span in `old`.
    old_offset: usize,
    old_len: usize,
    new_len: usize,
    preview: String,
    old_entropy: f64,
    new_entropy: f64,
    old_class: &'static str,
    new_class: &'static str,
}

#[derive(Serialize)]
pub(crate) struct CompareReport {
    schema_version: u8,
    identical: bool,
    old_size: usize,
    new_size: usize,
    size_delta: i64,
    common_prefix: usize,
    common_suffix: usize,
    matched_bytes: usize,
    /// matched_bytes / max(old_size, new_size), rounded to 4 decimals.
    matching_ratio: f64,
    /// matching_ratio scaled to 0-100 with a region-count penalty: the score
    /// loses up to half its value at 4096 regions.
    similarity_score: u32,
    region_count: usize,
    regions: Vec<Region>,
    sha256_old: String,
    sha256_new: String,
    truncated: bool,
    warnings: Vec<String>,
}

#[derive(Serialize)]
pub(crate) struct RegionsReport {
    schema_version: u8,
    /// "aligned-scan" for equal sizes, "rolling-hash" otherwise.
    method: &'static str,
    identical: bool,
    old_size: usize,
    new_size: usize,
    block_size: usize,
    anchor_count: usize,
    matched_bytes: usize,
    matching_ratio: f64,
    region_count: usize,
    regions: Vec<Region>,
    truncated: bool,
    warnings: Vec<String>,
}

/// `binary_compare`: exact structural comparison.
pub(crate) fn compare(old: &[u8], new: &[u8], max_regions: usize) -> CompareReport {
    let prefix = common_prefix(old, new);
    let suffix = common_suffix(old, new, prefix);
    let identical = old == new;

    let mut spans = Vec::new();
    if !identical {
        if old.len() == new.len() {
            for (start, end) in mismatch_runs(old, new, prefix, old.len() - suffix) {
                spans.push(Span {
                    old_start: start,
                    old_end: end,
                    new_start: start,
                    new_end: end,
                });
            }
        } else {
            spans.push(Span {
                old_start: prefix,
                old_end: old.len() - suffix,
                new_start: prefix,
                new_end: new.len() - suffix,
            });
        }
    }

    let region_count = spans.len();
    let collected = spans.len().min(max_regions);
    let regions: Vec<Region> = spans[..collected]
        .iter()
        .map(|span| make_region(old, new, span))
        .collect();
    let matched_bytes: usize = old
        .len()
        .saturating_sub(spans.iter().map(|span| span.old_end - span.old_start).sum::<usize>());
    let ratio = matching_ratio(matched_bytes, old.len(), new.len());
    let truncated = region_count > collected;

    CompareReport {
        schema_version: 1,
        identical,
        old_size: old.len(),
        new_size: new.len(),
        size_delta: new.len() as i64 - old.len() as i64,
        common_prefix: prefix,
        common_suffix: suffix,
        matched_bytes,
        matching_ratio: ratio,
        similarity_score: similarity_score(ratio, region_count),
        region_count,
        regions,
        sha256_old: sha256_hex(old),
        sha256_new: sha256_hex(new),
        truncated,
        warnings: if truncated {
            vec![format!("regions truncated from {region_count} to {collected}")]
        } else {
            Vec::new()
        },
    }
}

/// `binary_regions`: bounded changed-region report. Equal sizes use the exact
/// aligned scan; different sizes use the rolling-hash anchor scan.
pub(crate) fn regions(old: &[u8], new: &[u8], max_regions: usize) -> RegionsReport {
    let identical = old == new;
    let mut spans = Vec::new();
    let mut anchor_count = 0usize;
    let mut matched_bytes = if identical { old.len() } else { 0 };
    let mut method = "aligned-scan";

    if !identical {
        if old.len() == new.len() {
            let prefix = common_prefix(old, new);
            let suffix = common_suffix(old, new, prefix);
            for (start, end) in mismatch_runs(old, new, prefix, old.len() - suffix) {
                spans.push(Span {
                    old_start: start,
                    old_end: end,
                    new_start: start,
                    new_end: end,
                });
            }
            matched_bytes = old
                .len()
                .saturating_sub(spans.iter().map(|s| s.new_len()).sum());
        } else {
            method = "rolling-hash";
            let (found, matched) = RollingScan::new(old, new).run(&mut spans);
            // A scan that finds no anchors still reports the changed middle
            // bounded by prefix/suffix.
            if spans.is_empty() {
                let prefix = common_prefix(old, new);
                let suffix = common_suffix(old, new, prefix);
                spans.push(Span {
                    old_start: prefix,
                    old_end: old.len() - suffix,
                    new_start: prefix,
                    new_end: new.len() - suffix,
                });
            }
            anchor_count = found;
            matched_bytes = matched;
        }
    }

    let region_count = spans.len();
    let collected = spans.len().min(max_regions);
    let out_regions: Vec<Region> = spans[..collected]
        .iter()
        .map(|span| make_region(old, new, span))
        .collect();
    let truncated = region_count > collected;

    RegionsReport {
        schema_version: 1,
        method,
        identical,
        old_size: old.len(),
        new_size: new.len(),
        block_size: REGION_BLOCK_SIZE,
        anchor_count,
        matched_bytes,
        matching_ratio: matching_ratio(matched_bytes, old.len(), new.len()),
        region_count,
        regions: out_regions,
        truncated,
        warnings: if truncated {
            vec![format!("regions truncated from {region_count} to {collected}")]
        } else {
            Vec::new()
        },
    }
}

struct Span {
    old_start: usize,
    old_end: usize,
    new_start: usize,
    new_end: usize,
}

impl Span {
    fn new_len(&self) -> usize {
        self.new_end - self.new_start
    }
}

fn common_prefix(old: &[u8], new: &[u8]) -> usize {
    let n = old.len().min(new.len());
    let mut i = 0;
    while i < n && old[i] == new[i] {
        i += 1;
    }
    i
}

/// Longest common suffix of the remainders after `prefix` on both sides.
fn common_suffix(old: &[u8], new: &[u8], prefix: usize) -> usize {
    let mut n = 0;
    while n < old.len() - prefix
        && n < new.len() - prefix
        && old[old.len() - 1 - n] == new[new.len() - 1 - n]
    {
        n += 1;
    }
    n
}

/// Maximal runs of differing bytes within `new[start..end)` (same-size scan).
fn mismatch_runs(
    old: &[u8],
    new: &[u8],
    start: usize,
    end: usize,
) -> Vec<(usize, usize)> {
    let mut runs = Vec::new();
    let mut i = start;
    while i < end {
        if old[i] != new[i] {
            let run_start = i;
            while i < end && old[i] != new[i] {
                i += 1;
            }
            runs.push((run_start, i));
        } else {
            i += 1;
        }
    }
    runs
}

fn make_region(old: &[u8], new: &[u8], span: &Span) -> Region {
    let new_slice = &new[span.new_start..span.new_end];
    let old_slice = &old[span.old_start..span.old_end];
    let preview_source = if new_slice.is_empty() {
        old_slice
    } else {
        new_slice
    };
    Region {
        offset: span.new_start,
        old_offset: span.old_start,
        old_len: span.old_end - span.old_start,
        new_len: span.new_end - span.new_start,
        preview: hex_string(&preview_source[..preview_source.len().min(MAX_PREVIEW_BYTES)]),
        old_entropy: entropy(old_slice),
        new_entropy: entropy(new_slice),
        old_class: dominant_class(old_slice),
        new_class: dominant_class(new_slice),
    }
}

fn matching_ratio(matched: usize, old_len: usize, new_len: usize) -> f64 {
    let denominator = old_len.max(new_len);
    if denominator == 0 {
        return 1.0;
    }
    round4(matched as f64 / denominator as f64)
}

fn similarity_score(ratio: f64, region_count: usize) -> u32 {
    let penalty = 1.0 - (region_count.min(MAX_REGIONS) as f64 / (2.0 * MAX_REGIONS as f64));
    (100.0 * ratio * penalty).round().clamp(0.0, 100.0) as u32
}

fn round4(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}

/// Shannon entropy of the slice in bits/byte, rounded to 4 decimals.
fn entropy(slice: &[u8]) -> f64 {
    if slice.is_empty() {
        return 0.0;
    }
    let mut counts = [0u64; 256];
    for &byte in slice {
        counts[byte as usize] += 1;
    }
    let len = slice.len() as f64;
    let sum: f64 = counts
        .iter()
        .filter(|&&count| count > 0)
        .map(|&count| {
            let p = count as f64 / len;
            -p * p.log2()
        })
        .sum();
    round4(sum)
}

/// Byte classes: `zero`, `ff`, `ascii` (printable + whitespace), `low`
/// (other control bytes), `high` (>= 0x80). Returns the dominant class.
fn dominant_class(slice: &[u8]) -> &'static str {
    if slice.is_empty() {
        return "empty";
    }
    let mut counts = [0usize; 5];
    for &byte in slice {
        counts[class_index(byte)] += 1;
    }
    const NAMES: [&str; 5] = ["zero", "ff", "ascii", "low", "high"];
    let mut best = 0;
    for (index, &count) in counts.iter().enumerate() {
        if count > counts[best] {
            best = index;
        }
    }
    NAMES[best]
}

fn class_index(byte: u8) -> usize {
    match byte {
        0x00 => 0,
        0xff => 1,
        0x20..=0x7e | b'\t' | b'\n' | b'\r' => 2,
        0x01..=0x1f | 0x7f => 3,
        _ => 4,
    }
}

/// Rolling-hash anchor scan over `new` against a fixed grid of 64-byte blocks
/// in `old`. Hash matches are byte-verified, then extended greedily; spans
/// between consecutive anchors are the changed regions. Collisions only cost
/// a failed memcmp, so the report is exact.
struct RollingScan<'a> {
    old: &'a [u8],
    new: &'a [u8],
}

const ROLL_BASE: u64 = 257;
/// Maximum old positions recorded per block hash.
const MAX_CANDIDATES: usize = 8;

impl<'a> RollingScan<'a> {
    fn new(old: &'a [u8], new: &'a [u8]) -> Self {
        Self { old, new }
    }

    /// Populate `spans` with the gaps between anchors. Returns
    /// (anchor_count, matched_bytes).
    fn run(self, spans: &mut Vec<Span>) -> (usize, usize) {
        let block = REGION_BLOCK_SIZE;
        let (old, new) = (self.old, self.new);
        if old.len() < block || new.len() < block {
            return (0, 0);
        }

        // Anchor grid: non-overlapping 64-byte blocks of `old`, hashed into a
        // map of hash -> positions. A cheap multiplicative hasher keeps the
        // scan linear; verification makes hits exact.
        let mut index: HashMap<u64, Vec<u32>, BuildHasherDefault<KeyHasher>> =
            HashMap::default();
        let mut grid = 0;
        while grid + block <= old.len() {
            let hash = block_hash(&old[grid..grid + block]);
            let entries = index.entry(hash).or_default();
            if entries.len() < MAX_CANDIDATES {
                entries.push(grid as u32);
            }
            grid += block;
        }

        let mut anchors = 0usize;
        let mut matched = 0usize;
        let mut new_pos = 0usize; // scan cursor
        let mut new_mark = 0usize; // end of the previous match in `new`
        let mut old_mark = 0usize; // end of the previous match in `old`
        let mut hash = 0u64;
        let mut primed = false;
        while new_pos + block <= new.len() {
            if primed {
                // roll: drop new[new_pos-1], add new[new_pos+block-1]
                hash = hash
                    .wrapping_sub((new[new_pos - 1] as u64).wrapping_mul(ROLL_POW))
                    .wrapping_mul(ROLL_BASE)
                    .wrapping_add(new[new_pos + block - 1] as u64);
            } else {
                hash = block_hash(&new[new_pos..new_pos + block]);
                primed = true;
            }
            if let Some(candidates) = index.get(&hash) {
                let anchor = candidates.iter().copied().find(|&start| {
                    old[start as usize..start as usize + block]
                        == new[new_pos..new_pos + block]
                });
                if let Some(start) = anchor {
                    let mut old_start = start as usize;
                    let mut new_start = new_pos;
                    // Extend left without crossing the previous match.
                    while new_start > new_mark
                        && old_start > old_mark
                        && new[new_start - 1] == old[old_start - 1]
                    {
                        new_start -= 1;
                        old_start -= 1;
                    }
                    let mut new_end = new_pos + block;
                    // The match's old side ends at the anchor's end — not at
                    // `old_start + block`, which the left extension moved.
                    let mut old_end = start as usize + block;
                    while new_end < new.len() && old_end < old.len() && new[new_end] == old[old_end]
                    {
                        new_end += 1;
                        old_end += 1;
                    }
                    if new_start > new_mark || old_start > old_mark {
                        spans.push(Span {
                            old_start: old_mark,
                            old_end: old_start,
                            new_start: new_mark,
                            new_end: new_start,
                        });
                    }
                    anchors += 1;
                    matched += new_end - new_start;
                    new_mark = new_end;
                    old_mark = old_end;
                    new_pos = new_end;
                    primed = false;
                    continue;
                }
            }
            new_pos += 1;
        }
        if new_mark < new.len() || old_mark < old.len() {
            spans.push(Span {
                old_start: old_mark,
                old_end: old.len(),
                new_start: new_mark,
                new_end: new.len(),
            });
        }
        (anchors, matched)
    }
}

const ROLL_POW: u64 = roll_pow();

const fn roll_pow() -> u64 {
    let mut value = 1u64;
    let mut i = 0;
    while i < REGION_BLOCK_SIZE - 1 {
        value = value.wrapping_mul(ROLL_BASE);
        i += 1;
    }
    value
}

fn block_hash(block: &[u8]) -> u64 {
    block.iter().fold(0u64, |hash, &byte| {
        hash.wrapping_mul(ROLL_BASE).wrapping_add(byte as u64)
    })
}

/// Multiplicative hasher for prehashed u64 keys.
#[derive(Default)]
struct KeyHasher(u64);

impl Hasher for KeyHasher {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.0 = self.0.wrapping_mul(0x9E3779B97F4A7C15).wrapping_add(byte as u64);
        }
    }

    fn write_u64(&mut self, value: u64) {
        self.0 = value.wrapping_mul(0x9E3779B97F4A7C15);
        self.0 ^= self.0 >> 33;
    }
}
