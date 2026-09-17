//! `bipatch` patch application and patch introspection.
//!
//! Application is delegated to `bipatch::Reader`, the upstream decoder for the
//! wire format `binary_diff` emits. `patch_info` walks the same format without
//! an `old` buffer to describe what a patch would do.

use std::io::{Cursor, Read};

use byteorder::{LittleEndian, ReadBytesExt};
use integer_encoding::VarIntReader;
use serde::Serialize;

use crate::err_with;
use serde_json::json;

const MAGIC: u32 = 0xB1DF;
const VERSION: u32 = 0x1000;
/// Bound on control records walked by `patch_info`; a small patch can declare
/// millions of zero-length records and work stays proportional to this cap.
const MAX_CONTROLS: u64 = 1_000_000;

/// Apply `patch` to `old`, returning at most `max` output bytes.
pub(crate) fn apply(old: &[u8], patch: &[u8], max: usize) -> Result<Vec<u8>, String> {
    let reader = bipatch::Reader::new(Cursor::new(patch), Cursor::new(old)).map_err(|error| {
        err_with(
            "invalid_patch",
            json!({ "detail": format!("patch header: {error}") }),
        )
    })?;
    let mut out = Vec::new();
    reader
        .take(max as u64 + 1)
        .read_to_end(&mut out)
        .map_err(|error| {
            err_with(
                "invalid_patch",
                json!({ "detail": format!("patch stream: {error}") }),
            )
        })?;
    if out.len() > max {
        return Err(err_with(
            "output_too_large",
            json!({ "size": out.len(), "limit": max }),
        ));
    }
    Ok(out)
}

#[derive(Serialize)]
pub(crate) struct PatchInfo {
    schema_version: u8,
    patch_bytes: usize,
    /// "bipatch" when magic and version match, else "unknown".
    format: &'static str,
    magic: Option<String>,
    version: Option<String>,
    /// Header parsed and every control record is complete with sane seeks.
    well_formed: bool,
    /// The stream ends exactly on a control-record boundary.
    complete: bool,
    control_count: u64,
    /// Declared add-region bytes summed over complete records.
    add_bytes: u64,
    /// Declared literal copy bytes summed over complete records.
    copy_bytes: u64,
    /// Output size implied by the control records: `add_bytes + copy_bytes`.
    output_bytes: u64,
    /// Highest `old` offset any complete record would reach. Apply fails if
    /// the patch seeks before offset 0 or reads past the end of `old`.
    old_bytes_touched: u64,
    /// Sum of negative seek magnitudes (how far the old cursor rewinds).
    rewind_bytes: u64,
    truncated: bool,
    warnings: Vec<String>,
}

/// Walk a `bipatch` patch without an `old` buffer and describe it. Bad magic
/// or a bad version is still a report — `format` becomes "unknown" — because
/// this operation exists to triage untrusted patches.
pub(crate) fn patch_info(patch: &[u8]) -> PatchInfo {
    let mut info = PatchInfo {
        schema_version: 1,
        patch_bytes: patch.len(),
        format: "unknown",
        magic: None,
        version: None,
        well_formed: false,
        complete: false,
        control_count: 0,
        add_bytes: 0,
        copy_bytes: 0,
        output_bytes: 0,
        old_bytes_touched: 0,
        rewind_bytes: 0,
        truncated: false,
        warnings: Vec::new(),
    };
    walk(patch, &mut info);
    info.output_bytes = info.add_bytes + info.copy_bytes;
    info
}

fn walk(patch: &[u8], info: &mut PatchInfo) {
    let mut cursor = Cursor::new(patch);
    let magic = match cursor.read_u32::<LittleEndian>() {
        Ok(value) => value,
        Err(_) => {
            info.warnings.push("short_header".into());
            return;
        }
    };
    let version = match cursor.read_u32::<LittleEndian>() {
        Ok(value) => value,
        Err(_) => {
            info.magic = Some(format!("0x{magic:04x}"));
            info.warnings.push("short_header".into());
            return;
        }
    };
    info.magic = Some(format!("0x{magic:04x}"));
    info.version = Some(format!("0x{version:04x}"));
    if magic != MAGIC || version != VERSION {
        info.warnings.push("unrecognized_header".into());
        return;
    }
    info.format = "bipatch";

    let mut old_pos: i64 = 0;
    loop {
        if info.control_count >= MAX_CONTROLS {
            info.truncated = true;
            info.warnings.push("control_limit_reached".into());
            return;
        }
        // A record boundary is here. A clean EOF on the add_len varint is the
        // normal end of a patch.
        let add_len: u64 = match cursor.read_varint() {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
                info.complete = true;
                info.well_formed = true;
                return;
            }
            Err(_) => {
                info.warnings.push("bad_varint".into());
                return;
            }
        };
        if !skip(&mut cursor, add_len, patch.len()) {
            info.warnings.push("truncated_record".into());
            return;
        }
        if !record_tail(&mut cursor, patch.len(), info, &mut old_pos, add_len) {
            return;
        }
        info.control_count += 1;
    }
}

/// Skip the `add_len` payload, then read `copy_len`, skip its payload, and
/// read `seek`; commit a complete record's statistics. Returns false after
/// recording the appropriate warning.
fn record_tail(
    cursor: &mut Cursor<&[u8]>,
    patch_len: usize,
    info: &mut PatchInfo,
    old_pos: &mut i64,
    add_len: u64,
) -> bool {
    let copy_len: u64 = match cursor.read_varint() {
        Ok(value) => value,
        Err(_) => {
            info.warnings.push("truncated_record".into());
            return false;
        }
    };
    if !skip(cursor, copy_len, patch_len) {
        info.warnings.push("truncated_record".into());
        return false;
    }
    let seek: i64 = match cursor.read_varint() {
        Ok(value) => value,
        Err(_) => {
            info.warnings.push("truncated_record".into());
            return false;
        }
    };
    // `old` advances over the add region, then by the signed seek.
    if add_len > i64::MAX as u64 {
        info.warnings.push("implausible_length".into());
        return false;
    }
    let Some(after_add) = (*old_pos).checked_add(add_len as i64) else {
        info.warnings.push("implausible_length".into());
        return false;
    };
    *old_pos = after_add;
    info.old_bytes_touched = info.old_bytes_touched.max(*old_pos as u64);
    let Some(after_seek) = (*old_pos).checked_add(seek) else {
        info.warnings.push("implausible_seek".into());
        return false;
    };
    if after_seek < 0 {
        info.warnings.push("seek_before_start".into());
        return false;
    }
    *old_pos = after_seek;
    if seek < 0 {
        info.rewind_bytes += (-seek) as u64;
    }
    info.add_bytes += add_len;
    info.copy_bytes += copy_len;
    true
}

/// Advance `count` bytes if the payload is present.
fn skip(cursor: &mut Cursor<&[u8]>, count: u64, patch_len: usize) -> bool {
    match cursor.position().checked_add(count) {
        Some(end) if end <= patch_len as u64 => {
            cursor.set_position(end);
            true
        }
        _ => false,
    }
}
