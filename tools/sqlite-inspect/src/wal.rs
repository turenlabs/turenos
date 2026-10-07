//! WAL layout and cumulative checksums: sqlite.org/fileformat2.html#wal_file_format.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::{u32_be, Report, MAX_ITEMS};

#[derive(Deserialize)]
pub(crate) struct Options {
    #[serde(default, rename = "maxItems")]
    max_items: Option<usize>,
}

pub(crate) fn inspect(
    bytes: &[u8],
    options: &Options,
    report: &mut Report,
) -> Result<Value, &'static str> {
    if bytes.len() < 32 || !matches!(u32_be(bytes, 0), 0x377f0682 | 0x377f0683) {
        return Err("not_sqlite_wal");
    }
    if u32_be(bytes, 4) != 3_007_000 {
        return Err("unsupported_wal_version");
    }
    let page_size = u32_be(bytes, 8) as usize;
    if !(512..=65536).contains(&page_size) || !page_size.is_power_of_two() {
        return Err("invalid_page_size");
    }
    let little = u32_be(bytes, 0) == 0x377f0682;
    let mut sum = checksum(&bytes[..24], little, [0, 0]);
    let header_valid = sum == [u32_be(bytes, 24), u32_be(bytes, 28)];
    let frame_size = page_size + 24;
    let complete_frames = (bytes.len() - 32) / frame_size;
    let trailing_bytes = (bytes.len() - 32) % frame_size;
    let cap = options.max_items.unwrap_or(MAX_ITEMS).clamp(1, MAX_ITEMS);
    let mut frames = Vec::new();
    let mut valid_frames = 0;
    let mut commit_markers = 0;
    let mut last_commit = None;
    let mut invalid_frame = None;
    if !header_valid {
        report.warn("WAL header checksum mismatch; no frame is validated");
    }
    if header_valid {
        for index in 0..complete_frames {
            let offset = 32 + index * frame_size;
            let frame = &bytes[offset..offset + frame_size];
            let page = u32_be(frame, 0);
            let db_size = u32_be(frame, 4);
            let salts_valid = frame[8..16] == bytes[16..24];
            let candidate = checksum(&frame[24..], little, checksum(&frame[..8], little, sum));
            let checksum_valid = candidate == [u32_be(frame, 16), u32_be(frame, 20)];
            let reason = if !salts_valid {
                Some("salt_mismatch")
            } else if !checksum_valid {
                Some("checksum_mismatch")
            } else if page == 0 || page == u32::MAX {
                Some("invalid_page_number")
            } else {
                None
            };
            if let Some(reason) = reason {
                invalid_frame =
                    Some(json!({"frame": index + 1, "offset": offset, "reason": reason}));
                report.warn("Validation stops at the first invalid frame; later bytes may belong to an older WAL generation");
                break;
            }
            sum = candidate;
            valid_frames += 1;
            if db_size != 0 {
                commit_markers += 1;
                last_commit = Some((index + 1, db_size));
            }
            if frames.len() < cap {
                frames.push(json!({
                    "frame": index + 1, "offset": offset, "pageNumber": page,
                    "databasePagesAfterCommit": db_size, "commit": db_size != 0,
                }));
            }
        }
    }
    if valid_frames > frames.len() {
        report.truncated = true;
        report.warn("Frame list is capped; summary covers the full validated prefix");
    }
    if trailing_bytes != 0 {
        report.warn("File ends with a partial frame; partial bytes are not validated");
    }
    Ok(json!({
        "schema_version": 1, "kind": "sqlite-wal", "fileBytes": bytes.len(),
        "header": {
            "version": u32_be(bytes, 4), "pageSize": page_size,
            "checkpointSequence": u32_be(bytes, 12),
            "salts": [u32_be(bytes, 16), u32_be(bytes, 20)],
            "checksumByteOrder": if little { "little-endian" } else { "big-endian" },
            "checksumValid": header_valid,
        },
        "completeFrames": complete_frames, "validFrames": valid_frames,
        "commitMarkers": commit_markers,
        "lastCommit": last_commit.map(|(frame, pages)| json!({"frame": frame, "databasePages": pages})),
        "uncommittedFrames": valid_frames - last_commit.map_or(0, |(frame, _)| frame),
        "invalidFrame": invalid_frame, "trailingBytes": trailing_bytes,
        "frames": frames, "truncated": report.truncated, "warnings": report.warnings,
        "replayed": false,
        "caveat": "Checksums are not authentication. A WAL alone cannot establish database association or checkpoint status. Commit markers are not an exact transaction count.",
    }))
}

fn checksum(bytes: &[u8], little: bool, mut sum: [u32; 2]) -> [u32; 2] {
    for pair in bytes.chunks_exact(8) {
        let word = |offset| {
            let value = pair[offset..offset + 4].try_into().unwrap();
            if little {
                u32::from_le_bytes(value)
            } else {
                u32::from_be_bytes(value)
            }
        };
        sum[0] = sum[0].wrapping_add(word(0)).wrapping_add(sum[1]);
        sum[1] = sum[1].wrapping_add(word(4)).wrapping_add(sum[0]);
    }
    sum
}
