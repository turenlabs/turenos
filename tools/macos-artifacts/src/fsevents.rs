//! Bounded `.fseventsd` disk-log parsing. A log file is one or more
//! concatenated gzip members whose decompressed payload is a sequence of
//! record pages: a 12-byte header (`1SLD`/`2SLD`/`3SLD` magic, u32 padding,
//! u32 stream size including the header) followed by variable-length event
//! records. Records are a NUL-terminated path, a u64 event id, u32 flags,
//! then (v2+) a u64 node id and (v3) a trailing u32. Hand-rolled per the
//! documented format (libyal dtformats / FSEventsParser); every read is
//! bounds-checked and malformed tails degrade to warnings plus the rows
//! already decoded.

use flate2::read::MultiGzDecoder;
use serde::Deserialize;
use std::io::Read;

use crate::{
    clean, clamp_limit, Envelope, Fail, MAX_DECOMPRESSED_BYTES, MAX_PATH_CHARS, MAX_RESULTS,
    DEFAULT_RESULTS,
};

#[derive(Deserialize, Default)]
pub(crate) struct FseventsOptions {
    pub(crate) max_results: Option<u64>,
}

const HEADER_SIZE: usize = 12;
const PAGE_V1: u32 = 0x444c5331; // "1SLD"
const PAGE_V2: u32 = 0x444c5332; // "2SLD"
const PAGE_V3: u32 = 0x444c5333; // "3SLD"

pub(crate) fn run(
    bytes: &[u8],
    options: &FseventsOptions,
    envelope: &mut Envelope,
) -> Result<serde_json::Value, Fail> {
    let max_results = clamp_limit(options.max_results, DEFAULT_RESULTS, MAX_RESULTS);

    let decompressed = if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut decoder = MultiGzDecoder::new(bytes);
        // Read at most limit+1 to detect over-limit streams without
        // materializing an unbounded buffer.
        let mut capped = decoder.by_ref().take(MAX_DECOMPRESSED_BYTES + 1);
        let mut data = Vec::new();
        match capped.read_to_end(&mut data) {
            Ok(_) => {}
            Err(error) => {
                return Err(Fail::new("invalid_gzip").with("detail", error.to_string()));
            }
        }
        if data.len() as u64 > MAX_DECOMPRESSED_BYTES {
            data.truncate(MAX_DECOMPRESSED_BYTES as usize);
            envelope.truncated = true;
            envelope.warn(format!(
                "decompressed stream capped at {MAX_DECOMPRESSED_BYTES} bytes"
            ));
        }
        data
    } else {
        bytes.to_vec()
    };

    let mut stream = decompressed.as_slice();
    let mut pages: u32 = 0;
    let mut versions: Vec<&'static str> = Vec::new();
    let mut records: Vec<serde_json::Value> = Vec::new();
    let mut record_total: u64 = 0;
    let mut saw_page = false;

    while !stream.is_empty() {
        if stream.len() < HEADER_SIZE {
            envelope.warn(format!(
                "trailing {} bytes after last page",
                stream.len()
            ));
            break;
        }
        let magic = read_u32(stream, 0).unwrap_or(0);
        if !matches!(magic, PAGE_V1 | PAGE_V2 | PAGE_V3) {
            if !saw_page {
                return Err(Fail::new("not_fsevents"));
            }
            envelope.warn(format!("bad page magic 0x{magic:08x}, stopped"));
            break;
        }
        saw_page = true;
        pages += 1;
        let version = match magic {
            PAGE_V1 => "v1",
            PAGE_V2 => "v2",
            _ => "v3",
        };
        if !versions.contains(&version) {
            versions.push(version);
        }
        let stream_size = read_u32(stream, 8).unwrap_or(0) as usize;
        if stream_size < HEADER_SIZE || stream_size > stream.len() {
            envelope.warn(format!(
                "page {pages} declares invalid stream_size {stream_size}"
            ));
            break;
        }
        let mut cursor = HEADER_SIZE;
        while cursor < stream_size {
            let page = &stream[..stream_size];
            let record = match parse_record(page, cursor, magic) {
                Some((record, next)) => {
                    cursor = next;
                    record
                }
                None => {
                    envelope.warn(format!("page {pages} record at {cursor} truncated"));
                    break;
                }
            };
            record_total += 1;
            if records.len() < max_results {
                records.push(record);
            } else {
                envelope.truncated = true;
            }
        }
        stream = &stream[stream_size..];
    }

    if !saw_page {
        return Err(Fail::new("not_fsevents"));
    }
    if records.len() < record_total as usize {
        envelope.warn(format!(
            "record list truncated at {} of {} records",
            records.len(),
            record_total
        ));
    }

    Ok(serde_json::json!({
        "kind": "fsevents",
        "compressed": bytes.starts_with(&[0x1f, 0x8b]),
        "stream_versions": versions,
        "page_count": pages,
        "record_count": record_total,
        "records_returned": records.len(),
        "records": records,
    }))
}

/// One record: NUL-terminated path, u64 event id, u32 flags, v2+ u64 node,
/// v3 + u32 trailer. Returns the decoded record and the next cursor.
fn parse_record(
    page: &[u8],
    cursor: usize,
    magic: u32,
) -> Option<(serde_json::Value, usize)> {
    let tail = page.get(cursor..)?;
    let nul = tail.iter().position(|b| *b == 0)?;
    let raw_path = &tail[..nul];
    let mut offset = cursor + nul + 1;

    // Fixed tail: v1 = 12 bytes, v2 = 20, v3 = 24.
    let fixed = match magic {
        PAGE_V1 => 12,
        PAGE_V2 => 20,
        _ => 24,
    };
    if offset.checked_add(fixed)? > page.len() {
        return None;
    }

    let event_id = read_u64(page, offset)?;
    offset += 8;
    let flags = read_u32(page, offset)?;
    offset += 4;
    let node_id = if magic == PAGE_V1 {
        None
    } else {
        let value = read_u64(page, offset)?;
        offset += 8;
        Some(value)
    };
    let trailer = if magic == PAGE_V3 {
        let value = read_u32(page, offset)?;
        offset += 4;
        Some(value)
    } else {
        None
    };

    let path = decode_path(raw_path);
    let names = flag_names(flags);
    let mut record = serde_json::json!({
        "event_id": event_id,
        "path": path,
        "flags": { "raw": format!("0x{flags:08x}"), "names": names },
    });
    if let Some(node) = node_id {
        record["node_id"] = serde_json::Value::from(node);
    }
    if let Some(trailer) = trailer {
        record["trailer"] = serde_json::Value::from(trailer);
    }
    Some((record, offset))
}

fn decode_path(raw: &[u8]) -> String {
    let text = String::from_utf8_lossy(raw);
    // Records store absolute paths; the leading '/' is implicit in some
    // streams — normalize to a single leading slash without inventing one.
    let normalized = if text.starts_with("//") {
        &text[1..]
    } else {
        text.as_ref()
    };
    clean(normalized, MAX_PATH_CHARS)
}

fn read_u32(data: &[u8], offset: usize) -> Option<u32> {
    let raw: [u8; 4] = data.get(offset..offset + 4)?.try_into().ok()?;
    Some(u32::from_le_bytes(raw))
}

fn read_u64(data: &[u8], offset: usize) -> Option<u64> {
    let raw: [u8; 8] = data.get(offset..offset + 8)?.try_into().ok()?;
    Some(u64::from_le_bytes(raw))
}

/// Decode FSE_* flag bits per the documented sys/fsevents.h table.
fn flag_names(flags: u32) -> Vec<&'static str> {
    const FLAGS: &[(u32, &str)] = &[
        (0x0000_0001, "Created"),
        (0x0000_0002, "Removed"),
        (0x0000_0004, "InodeMetadataModified"),
        (0x0000_0008, "Renamed"),
        (0x0000_0010, "Modified"),
        (0x0000_0020, "Exchange"),
        (0x0000_0040, "FinderInfoModified"),
        (0x0000_0080, "DirectoryCreated"),
        (0x0000_0100, "PermissionChanged"),
        (0x0000_0200, "ExtendedAttributeModified"),
        (0x0000_0400, "ExtendedAttributeRemoved"),
        (0x0000_0800, "DocumentCreated"),
        (0x0000_1000, "DocumentRevision"),
        (0x0000_2000, "UnmountPending"),
        (0x0000_4000, "ItemCloned"),
        (0x0001_0000, "NotificationClone"),
        (0x0002_0000, "ItemTruncated"),
        (0x0004_0000, "DirectoryEvent"),
        (0x0008_0000, "LastHardLinkRemoved"),
        (0x0010_0000, "IsHardLink"),
        (0x0040_0000, "IsSymbolicLink"),
        (0x0080_0000, "IsFile"),
        (0x0100_0000, "IsDirectory"),
        (0x0200_0000, "Mount"),
        (0x0400_0000, "Unmount"),
        (0x2000_0000, "EndOfTransaction"),
    ];
    let mut names = Vec::new();
    for (bit, name) in FLAGS {
        if flags & bit != 0 {
            names.push(*name);
        }
    }
    names
}
