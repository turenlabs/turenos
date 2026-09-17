//! SQLite record format: a header-length varint, serial-type varints, then
//! the column bodies. Serial types 0–9 are fixed-size integers/floats or the
//! schema-format-4 constants 0 and 1; 10/11 are reserved; N>=12 even is a
//! (N-12)/2-byte blob and N>=13 odd is (N-13)/2-byte text in the database
//! encoding.

use serde_json::{json, Value};

use crate::db::Db;
use crate::{varint, Report, MAX_BLOB_PREVIEW, MAX_COLUMNS, MAX_TEXT_VALUE};

/// Byte size of one serial-type body. `None` for reserved types 10/11.
pub(crate) fn serial_size(serial: u64) -> Option<u64> {
    match serial {
        0 | 8 | 9 => Some(0),
        1 => Some(1),
        2 => Some(2),
        3 => Some(3),
        4 => Some(4),
        5 => Some(6),
        6 | 7 => Some(8),
        10 | 11 => None,
        n if n >= 12 && n % 2 == 0 => Some((n - 12) / 2),
        n if n >= 13 => Some((n - 13) / 2),
        _ => None,
    }
}

/// Parsed record header: serial types plus where the body begins.
pub(crate) struct RecordHeader {
    pub serials: Vec<u64>,
    /// Offset of the body within the payload.
    pub body_offset: usize,
}

/// Parse the record header at the start of `payload`. Column count is capped
/// at `max_columns`; extra serials make the header malformed.
pub(crate) fn parse_record_header(
    payload: &[u8],
    max_columns: usize,
) -> Result<RecordHeader, &'static str> {
    let (header_len, n) = varint(payload).ok_or("record_header")?;
    let header_len = header_len as usize;
    if header_len < n || header_len > payload.len() {
        return Err("record_header");
    }
    let mut serials = Vec::new();
    let mut cursor = n;
    while cursor < header_len {
        let (serial, used) = varint(&payload[cursor..header_len]).ok_or("record_header")?;
        serials.push(serial);
        if serials.len() > max_columns {
            return Err("record_header");
        }
        cursor += used;
    }
    if cursor != header_len {
        return Err("record_header");
    }
    Ok(RecordHeader {
        serials,
        body_offset: header_len,
    })
}

/// Decode one column body of `serial` type at `payload[offset..]` into a
/// type-tagged JSON value plus the bytes consumed. Text is transcoded from
/// the database encoding; blobs are never inlined — only length, sha256,
/// and a bounded hex preview.
fn decode_value(
    db: &Db,
    serial: u64,
    payload: &[u8],
    offset: usize,
    blob_preview: usize,
    report: &mut Report,
) -> Result<(Value, usize), &'static str> {
    let size = serial_size(serial).ok_or("reserved_serial_type")?;
    // Compare in u64 first — a huge serial type must not wrap usize on
    // wasm32 before the bounds check.
    if offset as u64 + size > payload.len() as u64 {
        return Err("record_body");
    }
    let size = size as usize;
    let body = &payload[offset..offset + size];
    let value = match serial {
        0 => json!({"type": "null"}),
        1..=6 => {
            let int = match size {
                1 => body[0] as i8 as i64,
                2 => i16::from_be_bytes([body[0], body[1]]) as i64,
                // 24-bit and 48-bit two's-complement: place the value so its
                // top bit lands on the sign bit, then arithmetic-shift back.
                3 => ((crate::u24_be(body, 0) << 8) as i32 >> 8) as i64,
                4 => i32::from_be_bytes([body[0], body[1], body[2], body[3]]) as i64,
                6 => ((crate::u48_be(body, 0) << 16) as i64) >> 16,
                8 => i64::from_be_bytes([
                    body[0], body[1], body[2], body[3], body[4], body[5], body[6], body[7],
                ]),
                _ => return Err("record_body"),
            };
            json!({"type": "integer", "value": int})
        }
        7 => {
            let float = f64::from_be_bytes([
                body[0], body[1], body[2], body[3], body[4], body[5], body[6], body[7],
            ]);
            json!({"type": "real", "value": float})
        }
        8 => json!({"type": "integer", "value": 0}),
        9 => json!({"type": "integer", "value": 1}),
        n if n >= 13 && n % 2 == 1 => {
            let (text, lossless) = decode_text(db, body, report);
            json!({
                "type": "text",
                "value": text,
                "length": size,
                "lossless": lossless,
            })
        }
        n if n >= 12 => {
            let preview_len = blob_preview.min(size).min(MAX_BLOB_PREVIEW);
            json!({
                "type": "blob",
                "length": size,
                "sha256": crate::sha256_hex(body),
                "previewHex": crate::hex_encode(&body[..preview_len]),
            })
        }
        _ => return Err("reserved_serial_type"),
    };
    Ok((value, size))
}

/// Decode a whole record payload into column values. Returns the values and
/// the count of body bytes consumed.
pub(crate) fn decode_record(
    db: &Db,
    payload: &[u8],
    blob_preview: usize,
    report: &mut Report,
) -> Result<Vec<Value>, &'static str> {
    decode_record_bounded(db, payload, blob_preview, MAX_COLUMNS, report)
}

/// Column-capped variant used by carving (preview needs at most
/// `max_columns` values even when the header holds more).
pub(crate) fn decode_record_bounded(
    db: &Db,
    payload: &[u8],
    blob_preview: usize,
    max_columns: usize,
    report: &mut Report,
) -> Result<Vec<Value>, &'static str> {
    let header = parse_record_header(payload, max_columns)?;
    let mut values = Vec::with_capacity(header.serials.len());
    let mut offset = header.body_offset;
    for serial in &header.serials {
        let (value, size) = decode_value(db, *serial, payload, offset, blob_preview, report)?;
        values.push(value);
        offset += size;
    }
    Ok(values)
}

/// Serial types parsed for carving: returns `(header_len, serials)` or
/// `None` when the bytes do not look like a record header. Stricter than
/// `parse_record_header` — reserved serial types reject the candidate, and
/// the serial scan stops at `MAX_CARVE_COLUMNS` so probe cost stays bounded
/// (wider candidate records are simply skipped).
pub(crate) fn probe_record_header(bytes: &[u8]) -> Option<(usize, Vec<u64>)> {
    let (header_len_u64, n) = varint(bytes)?;
    let header_len = header_len_u64 as usize;
    if header_len < n + 1 || header_len > bytes.len() || header_len > crate::MAX_CARVE_HEADER {
        return None;
    }
    let mut serials = Vec::new();
    let mut cursor = n;
    while cursor < header_len {
        let (serial, used) = varint(&bytes[cursor..header_len])?;
        if serial_size(serial).is_none() {
            return None;
        }
        serials.push(serial);
        if serials.len() > crate::MAX_CARVE_COLUMNS {
            return None;
        }
        cursor += used;
    }
    if cursor != header_len || serials.is_empty() {
        return None;
    }
    Some((header_len, serials))
}

/// Total body bytes implied by serial types. Saturates at u64::MAX.
pub(crate) fn body_size(serials: &[u64]) -> u64 {
    serials
        .iter()
        .fold(0u64, |sum, s| sum.saturating_add(serial_size(*s).unwrap_or(0)))
}

/// Transcode text bytes from the database encoding to UTF-8. Returns the
/// string plus a `lossless` flag; invalid sequences become U+FFFD and a
/// single warning is recorded.
pub(crate) fn decode_text(db: &Db, bytes: &[u8], report: &mut Report) -> (String, bool) {
    let capped = &bytes[..bytes.len().min(MAX_TEXT_VALUE * 4)];
    match db.header.text_encoding {
        2 | 3 => {
            let units: Vec<u16> = capped
                .chunks_exact(2)
                .map(|pair| {
                    if db.header.text_encoding == 2 {
                        u16::from_le_bytes([pair[0], pair[1]])
                    } else {
                        u16::from_be_bytes([pair[0], pair[1]])
                    }
                })
                .collect();
            let mut lossless = capped.len() % 2 == 0;
            let mut out = String::new();
            for unit in std::char::decode_utf16(units) {
                match unit {
                    Ok(ch) => out.push(ch),
                    Err(_) => {
                        lossless = false;
                        out.push('\u{fffd}');
                    }
                }
            }
            if out.len() > MAX_TEXT_VALUE {
                truncate_utf8(&mut out, MAX_TEXT_VALUE);
                report.warn("text value truncated at the 4 KiB cap");
                lossless = false;
            }
            if !lossless {
                report.warn("invalid UTF-16 sequence replaced with U+FFFD");
            }
            (out, lossless)
        }
        _ => {
            // UTF-8 (and unknown encodings treated as UTF-8, lossy).
            match std::str::from_utf8(capped) {
                Ok(text) => {
                    if text.len() > MAX_TEXT_VALUE {
                        report.warn("text value truncated at the 4 KiB cap");
                        (safe_prefix(text, MAX_TEXT_VALUE).to_string(), false)
                    } else {
                        (text.to_string(), true)
                    }
                }
                Err(_) => {
                    let mut text = String::from_utf8_lossy(capped).to_string();
                    if text.len() > MAX_TEXT_VALUE {
                        truncate_utf8(&mut text, MAX_TEXT_VALUE);
                    }
                    report.warn("invalid UTF-8 replaced with U+FFFD");
                    (text, false)
                }
            }
        }
    }
}

/// Byte-length cap that never splits a UTF-8 code point.
fn safe_prefix(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn truncate_utf8(text: &mut String, max: usize) {
    let end = safe_prefix(text, max).len();
    text.truncate(end);
}
