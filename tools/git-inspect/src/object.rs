//! Structured decoding of git object bodies (commit, tag, tree, blob).
//!
//! Pure byte parsing: no object lookup, no refs, no filesystem. String fields
//! are bounded through the shared report so hostile input cannot grow output.

use serde_json::{json, Value};

use crate::{base64_encode, hex_encode, sha256_hex, Report, MAX_ITEMS, MAX_MESSAGE_BYTES};

/// Describe one object body. `max_preview` bounds the embedded base64 preview
/// of binary-ish content (blob and unknown types).
pub(crate) fn describe(kind: &str, content: &[u8], max_preview: usize, report: &mut Report) -> Value {
    match kind {
        "commit" => describe_commit(content, report),
        "tag" => describe_tag(content, report),
        "tree" => describe_tree(content, report),
        _ => describe_blob(content, max_preview, report),
    }
}

fn describe_blob(content: &[u8], max_preview: usize, report: &mut Report) -> Value {
    let preview_len = content.len().min(max_preview);
    if preview_len < content.len() {
        report.truncated = true;
        report
            .warnings
            .push(format!("content preview truncated to {preview_len} bytes"));
    }
    json!({
        "previewBase64": base64_encode(&content[..preview_len]),
        "previewBytes": preview_len,
        "utf8": std::str::from_utf8(content).is_ok(),
        "sha256": sha256_hex(content),
    })
}

/// Split a commit/tag header block on the first blank line. Continuation lines
/// (leading space, used by gpgsig/mergetag) fold into the previous header.
fn parse_headers(content: &[u8]) -> (Vec<(String, String)>, &[u8]) {
    let (head, message) = match content.windows(2).position(|w| w == b"\n\n") {
        Some(at) => (&content[..at], &content[at + 2..]),
        None => (content, &content[..0]),
    };
    let mut headers: Vec<(String, String)> = Vec::new();
    for line in head.split(|b| *b == b'\n') {
        if line.first() == Some(&b' ') {
            if let Some(last) = headers.last_mut() {
                last.1.push('\n');
                last.1.push_str(&String::from_utf8_lossy(&line[1..]));
            }
            continue;
        }
        match line.iter().position(|b| *b == b' ') {
            Some(space) => headers.push((
                String::from_utf8_lossy(&line[..space]).into_owned(),
                String::from_utf8_lossy(&line[space + 1..]).into_owned(),
            )),
            None if !line.is_empty() => {
                headers.push((String::from_utf8_lossy(line).into_owned(), String::new()))
            }
            None => {}
        }
    }
    (headers, message)
}

/// Parse `Name <email> 1234567890 +0000` best-effort.
fn parse_identity(value: &str) -> Value {
    let open = value.find('<');
    let close = value.rfind('>');
    let (name, email, rest) = match (open, close) {
        (Some(o), Some(c)) if c > o => (
            value[..o].trim_end().to_string(),
            value[o + 1..c].to_string(),
            value[c + 1..].trim().to_string(),
        ),
        _ => (value.to_string(), String::new(), String::new()),
    };
    let mut parts = rest.split_whitespace();
    let timestamp = parts.next().and_then(|v| v.parse::<i64>().ok());
    let timezone = parts.next().map(|v| v.to_string());
    json!({
        "name": name,
        "email": email,
        "timestamp": timestamp,
        "timezone": timezone,
    })
}

fn message_json(message: &[u8], report: &mut Report) -> Value {
    let kept = message.len().min(MAX_MESSAGE_BYTES);
    if kept < message.len() {
        report.truncated = true;
        report.warnings.push(format!(
            "message truncated from {} to {} bytes",
            message.len(),
            kept
        ));
    }
    json!({
        "text": String::from_utf8_lossy(&message[..kept]),
        "bytes": message.len(),
        "truncated": kept < message.len(),
    })
}

fn describe_commit(content: &[u8], report: &mut Report) -> Value {
    let (headers, message) = parse_headers(content);
    let find = |name: &str| -> Vec<&str> {
        headers
            .iter()
            .filter(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
            .collect()
    };
    let parents: Vec<&str> = find("parent");
    let other: Vec<&str> = headers
        .iter()
        .map(|(k, _)| k.as_str())
        .filter(|k| !matches!(*k, "tree" | "parent" | "author" | "committer" | "encoding" | "gpgsig"))
        .collect();
    json!({
        "tree": find("tree").first().copied(),
        "parents": parents,
        "author": find("author").first().map(|v| parse_identity(v)),
        "committer": find("committer").first().map(|v| parse_identity(v)),
        "encoding": find("encoding").first().copied(),
        "gpgsig": !find("gpgsig").is_empty(),
        "otherHeaders": other,
        "message": message_json(message, report),
    })
}

fn describe_tag(content: &[u8], report: &mut Report) -> Value {
    let (headers, message) = parse_headers(content);
    let find = |name: &str| -> Option<&str> {
        headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    };
    json!({
        "object": find("object"),
        "objectType": find("type"),
        "tag": find("tag"),
        "tagger": find("tagger").map(parse_identity),
        "message": message_json(message, report),
    })
}

fn describe_tree(content: &[u8], report: &mut Report) -> Value {
    let mut entries = Vec::new();
    let mut pos = 0usize;
    let mut malformed = 0usize;
    while pos < content.len() && entries.len() < MAX_ITEMS {
        let space = match content[pos..].iter().position(|b| *b == b' ') {
            Some(at) if at <= 8 => pos + at,
            _ => {
                malformed += 1;
                break;
            }
        };
        let mode = match std::str::from_utf8(&content[pos..space]) {
            Ok(m) if m.bytes().all(|b| (b'0'..=b'7').contains(&b)) => m,
            _ => {
                malformed += 1;
                break;
            }
        };
        let nul = match content[space + 1..].iter().position(|b| *b == 0) {
            Some(at) => space + 1 + at,
            None => {
                malformed += 1;
                break;
            }
        };
        if nul + 21 > content.len() {
            malformed += 1;
            break;
        }
        let name = &content[space + 1..nul];
        let sha = &content[nul + 1..nul + 21];
        let mode_val = u32::from_str_radix(mode, 8).unwrap_or(0);
        entries.push(json!({
            "mode": format!("0o{mode}"),
            "name": String::from_utf8_lossy(name),
            "nameBytes": name.len(),
            "sha1": hex_encode(sha),
            "kind": tree_entry_kind(mode_val),
        }));
        pos = nul + 21;
    }
    if pos < content.len() && entries.len() >= MAX_ITEMS {
        report.truncated = true;
        report
            .warnings
            .push(format!("tree entries truncated at {MAX_ITEMS}"));
    }
    if malformed > 0 {
        report
            .warnings
            .push(format!("tree body has malformed entry at offset {pos}"));
    }
    json!({
        "entries": entries,
        "entryCount": entries.len(),
        "malformedTail": malformed > 0 || (pos < content.len() && entries.len() < MAX_ITEMS),
    })
}

fn tree_entry_kind(mode: u32) -> &'static str {
    match mode & 0o170000 {
        0o040000 => "tree",
        0o100000 => "blob",
        0o120000 => "symlink",
        0o160000 => "gitlink",
        _ => "unknown",
    }
}
