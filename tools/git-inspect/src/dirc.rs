//! Bounded git index (`DIRC`) v2/v3/v4 inspection.
//!
//! Layout: 12-byte header, `count` stat-cache entries, optional named
//! extensions (TREE, REUC, UNTR, EOIE, IEOT, ...), trailing SHA-1 over all
//! preceding bytes. v2/v3 entries are fixed records padded to a multiple of 8;
//! v4 replaces name padding with prefix compression (strip-N varint plus a
//! NUL-terminated suffix against the previous path). v3 adds a 16-bit
//! extended-flags word when the entry's extended bit is set.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::{hex_encode, u32_be, u16_be, Report, MAX_EXTENSIONS, MAX_ITEMS, MAX_STRING_BYTES};

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct IndexOptions {
    #[serde(alias = "max_items")]
    max_items: Option<usize>,
    #[serde(alias = "include_extensions")]
    include_extensions: Option<bool>,
}

struct Entry {
    index: usize,
    path: Vec<u8>,
    sha1: [u8; 20],
    mode: u32,
    stage: u8,
    size: u32,
    ctime_s: u32,
    ctime_n: u32,
    mtime_s: u32,
    mtime_n: u32,
    dev: u32,
    ino: u32,
    uid: u32,
    gid: u32,
    assume_valid: bool,
    skip_worktree: bool,
    intent_to_add: bool,
}

/// `git_index_inspect`.
pub(crate) fn inspect(
    bytes: &[u8],
    options: &IndexOptions,
    report: &mut Report,
) -> Result<Value, &'static str> {
    if bytes.len() < 4 || &bytes[..4] != b"DIRC" {
        return Err("not_index");
    }
    if bytes.len() < 12 {
        return Err("truncated_input");
    }
    let version = u32_be(bytes, 4);
    if !(2..=4).contains(&version) {
        return Err("unsupported_index_version");
    }
    if bytes.len() < 32 {
        return Err("truncated_input");
    }
    let declared = u32_be(bytes, 8);
    let body_end = bytes.len() - 20;
    let checksum_valid = crate::sha1_bytes(&bytes[..body_end]) == bytes[body_end..];

    let limit = options.max_items.unwrap_or(MAX_ITEMS).clamp(1, MAX_ITEMS);
    let mut pos = 12usize;
    let mut prev_path: Vec<u8> = Vec::new();
    let mut entries: Vec<Entry> = Vec::new();
    let mut parsed = 0usize;
    for index in 0..declared as usize {
        match parse_entry(bytes, pos, body_end, version, &prev_path) {
            Some((mut entry, next)) => {
                entry.index = index;
                prev_path = entry.path.clone();
                pos = next;
                parsed += 1;
                if entries.len() < limit {
                    entries.push(entry);
                }
            }
            None => {
                report.warnings.push(format!(
                    "entry {index} of {declared} is truncated or malformed at offset {pos}"
                ));
                break;
            }
        }
    }
    if entries.len() < parsed {
        report.truncated = true;
        report.warnings.push(format!(
            "entries truncated from {parsed} to {}",
            entries.len()
        ));
    }

    // Extensions occupy the space between the last entry and the trailer.
    let mut extensions = Vec::new();
    if options.include_extensions.unwrap_or(true) {
        while pos + 8 <= body_end && extensions.len() < MAX_EXTENSIONS {
            let name = &bytes[pos..pos + 4];
            let size = u32_be(bytes, pos + 4) as usize;
            let end = match pos.checked_add(8).and_then(|p| p.checked_add(size)) {
                Some(end) => end,
                None => break,
            };
            if end > body_end {
                report
                    .warnings
                    .push(format!("extension at {pos} overruns index body"));
                break;
            }
            extensions.push(json!({
                "name": extension_name(name),
                "size": size,
                "offset": pos,
            }));
            pos = end;
        }
    }

    Ok(json!({
        "schema_version": 1,
        "kind": "index",
        "version": version,
        "declaredEntries": declared,
        "parsedEntries": parsed,
        "entries": entries.iter().map(entry_json).collect::<Vec<_>>(),
        "entryCount": entries.len(),
        "extensions": extensions,
        "trailerSha1": hex_encode(&bytes[body_end..]),
        "checksumValid": checksum_valid,
        "scanEndedAt": pos,
        "bodyEnd": body_end,
        "truncated": report.truncated,
        "warnings": report.warnings,
    }))
}

/// Parse one index entry starting at `pos`. Returns (entry, next offset) or
/// None when the record is truncated/malformed.
fn parse_entry(
    bytes: &[u8],
    pos: usize,
    body_end: usize,
    version: u32,
    prev_path: &[u8],
) -> Option<(Entry, usize)> {
    if pos + 62 > body_end {
        return None;
    }
    let read = |i: usize| u32_be(bytes, pos + i * 4);
    let ctime_s = read(0);
    let ctime_n = read(1);
    let mtime_s = read(2);
    let mtime_n = read(3);
    let dev = read(4);
    let ino = read(5);
    let mode = read(6);
    let uid = read(7);
    let gid = read(8);
    let size = read(9);
    let mut sha1 = [0u8; 20];
    sha1.copy_from_slice(&bytes[pos + 40..pos + 60]);
    let flags = u16_be(bytes, pos + 60);
    let stage = ((flags >> 12) & 3) as u8;
    let assume_valid = flags & 0x8000 != 0;
    let extended = flags & 0x4000 != 0;
    let mut name_pos = pos + 62;
    let mut skip_worktree = false;
    let mut intent_to_add = false;
    if extended && version >= 3 {
        if name_pos + 2 > body_end {
            return None;
        }
        let ext = u16_be(bytes, name_pos);
        skip_worktree = ext & 0x4000 != 0;
        intent_to_add = ext & 0x2000 != 0;
        name_pos += 2;
    }

    let (path, next) = if version == 4 {
        // v4: strip N bytes from the previous path, append NUL-terminated
        // suffix. The strip count uses the offset-varint (with +1 carry).
        let (strip, after) = read_offset_varint(bytes, name_pos, body_end)?;
        let keep = prev_path.len().checked_sub(strip as usize)?;
        let nul = bytes[after..body_end]
            .iter()
            .position(|b| *b == 0)
            .map(|at| after + at)?;
        let mut path = Vec::with_capacity(keep + (nul - after));
        path.extend_from_slice(&prev_path[..keep]);
        path.extend_from_slice(&bytes[after..nul]);
        (path, nul + 1)
    } else {
        // v2/v3: name is `namelen` bytes (0xfff means "scan for NUL"), then
        // 1-8 NUL pad bytes so the whole entry is a multiple of 8 while the
        // name stays NUL-terminated.
        let namelen = (flags & 0x0fff) as usize;
        let name_end = if namelen < 0x0fff {
            name_pos.checked_add(namelen)?
        } else {
            bytes[name_pos..body_end]
                .iter()
                .position(|b| *b == 0)
                .map(|at| name_pos + at)?
        };
        if name_end > body_end || name_end < name_pos {
            return None;
        }
        let path = bytes[name_pos..name_end].to_vec();
        let entry_len = name_end - pos;
        let next = pos.checked_add((entry_len / 8 + 1) * 8)?;
        if next > body_end || bytes[name_end..next].iter().any(|b| *b != 0) {
            return None;
        }
        (path, next)
    };
    Some((
        Entry {
            index: 0,
            path,
            sha1,
            mode,
            stage,
            size,
            ctime_s,
            ctime_n,
            mtime_s,
            mtime_n,
            dev,
            ino,
            uid,
            gid,
            assume_valid,
            skip_worktree,
            intent_to_add,
        },
        next,
    ))
}

/// Git's offset varint: 7-bit groups with a +1 carry per continuation byte.
fn read_offset_varint(bytes: &[u8], mut pos: usize, end: usize) -> Option<(u64, usize)> {
    if pos >= end {
        return None;
    }
    let mut byte = bytes[pos];
    pos += 1;
    let mut value = (byte & 0x7f) as u64;
    while byte & 0x80 != 0 {
        if pos >= end {
            return None;
        }
        byte = bytes[pos];
        pos += 1;
        value = ((value + 1) << 7) | (byte & 0x7f) as u64;
        if value > 1 << 40 {
            return None;
        }
    }
    Some((value, pos))
}

fn entry_json(entry: &Entry) -> Value {
    // The full path is kept for v4 prefix state; only the emitted string is
    // bounded so oversized paths cannot grow the report.
    let path_lossy = String::from_utf8_lossy(&entry.path);
    let path_kept = path_lossy.len().min(MAX_STRING_BYTES);
    json!({
        "index": entry.index,
        "path": &path_lossy[..floor_char_boundary(&path_lossy, path_kept)],
        "pathBytes": entry.path.len(),
        "pathTruncated": path_kept < path_lossy.len(),
        "sha1": hex_encode(&entry.sha1),
        "mode": format!("0o{:o}", entry.mode),
        "modeKind": mode_kind(entry.mode),
        "stage": entry.stage,
        "size": entry.size,
        "ctime": {"seconds": entry.ctime_s, "nanoseconds": entry.ctime_n},
        "mtime": {"seconds": entry.mtime_s, "nanoseconds": entry.mtime_n},
        "dev": entry.dev,
        "ino": entry.ino,
        "uid": entry.uid,
        "gid": entry.gid,
        "flags": {
            "assumeValid": entry.assume_valid,
            "skipWorktree": entry.skip_worktree,
            "intentToAdd": entry.intent_to_add,
        },
    })
}

fn mode_kind(mode: u32) -> &'static str {
    match mode & 0o170000 {
        0o100000 => "file",
        0o120000 => "symlink",
        0o160000 => "gitlink",
        _ => "other",
    }
}

fn extension_name(raw: &[u8]) -> String {
    if raw.iter().all(|b| b.is_ascii_graphic() || *b == b' ') {
        String::from_utf8_lossy(raw).into_owned()
    } else {
        format!("0x{}", hex_encode(raw))
    }
}

fn floor_char_boundary(text: &str, index: usize) -> usize {
    if index >= text.len() {
        return text.len();
    }
    let mut end = index;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    end
}
