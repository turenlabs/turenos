//! Bounded `Cookies.binarycookies` parsing, hand-rolled from the
//! documented WebKit/Safari jar format (libyal dtformats "Safari
//! Cookies"): `"cook"` signature, a big-endian page-size table, then
//! pages of little-endian cookie records. Each record is `{size,
//! unknown, flags, unknown, domain/name/path/value/comment offsets, end
//! marker, expires f64, created f64}` with NUL-terminated strings hanging
//! off the tail; timestamps are Cocoa seconds since 2001-01-01T00:00:00Z.
//! The file trailer is a big-endian checksum (sum of every 4th byte of
//! every page), the 8-byte footer `0x071720050000004b`, and an optional
//! bplist metadata blob that is reported but not decoded.

use serde::Deserialize;

use crate::{
    clean, clamp_limit, f64_le, preview, u32_be, u32_le, Envelope, Fail, DEFAULT_RESULTS,
    MAX_COOKIE_SIZE, MAX_RESULTS, MAX_SAFARI_PAGES, MAX_STRING_CHARS,
};

#[derive(Deserialize, Default)]
pub(crate) struct CookiesOptions {
    pub(crate) max_results: Option<u64>,
}

const PAGE_MAGIC: u32 = 0x0000_0100;
const FILE_FOOTER: [u8; 8] = [0x07, 0x17, 0x20, 0x05, 0x00, 0x00, 0x00, 0x4b];
const MAC_EPOCH_UNIX: f64 = 978_307_200.0;
const COOKIE_HEADER: usize = 56; // fixed fields before the string area

/// Cocoa timestamp (f64 seconds since 2001-01-01) -> Unix seconds.
fn mac_time_to_unix(value: f64) -> Option<i64> {
    if !value.is_finite() {
        return None;
    }
    let unix = value + MAC_EPOCH_UNIX;
    if unix < i64::MIN as f64 || unix > i64::MAX as f64 {
        return None;
    }
    Some(unix as i64)
}

/// Read a NUL-terminated string stored at `offset` inside `record`;
/// offsets below COOKIE_HEADER point into the fixed fields and are
/// rejected.
fn cookie_string(record: &[u8], offset: u32, label: &str, envelope: &mut Envelope) -> Option<String> {
    let offset = offset as usize;
    if offset == 0 {
        return None;
    }
    if offset < COOKIE_HEADER || offset >= record.len() {
        if offset >= record.len() {
            envelope.warn(format!("cookie {label} offset {offset} outside record"));
        }
        return None;
    }
    let tail = &record[offset..];
    let end = tail.iter().position(|b| *b == 0).unwrap_or(tail.len());
    Some(clean(
        &String::from_utf8_lossy(&tail[..end]),
        MAX_STRING_CHARS,
    ))
}

/// The documented file checksum: the sum, as a big-endian u32, of every
/// 4th byte across all pages (bytes at page-relative offsets 0, 4, 8...).
fn checksum_pages(bytes: &[u8], pages: &[(usize, usize)]) -> u32 {
    let mut sum: u64 = 0;
    for &(start, size) in pages {
        let end = start.saturating_add(size).min(bytes.len());
        let mut i = start;
        while i < end {
            sum += u64::from(bytes[i]);
            i += 4;
        }
    }
    (sum & 0xffff_ffff) as u32
}

pub(crate) fn run(
    bytes: &[u8],
    options: &CookiesOptions,
    envelope: &mut Envelope,
) -> Result<serde_json::Value, Fail> {
    let max_results = clamp_limit(options.max_results, DEFAULT_RESULTS, MAX_RESULTS);

    if bytes.len() < 8 || !bytes.starts_with(b"cook") {
        return Err(Fail::new("invalid_binarycookies"));
    }
    let page_count = u32_be(bytes, 4).unwrap_or(0) as usize;
    if page_count == 0 || page_count > MAX_SAFARI_PAGES {
        return Err(Fail::new("invalid_binarycookies")
            .with("detail", format!("implausible page count {page_count}")));
    }
    let table_end = 8usize
        .checked_add(page_count.checked_mul(4).ok_or_else(|| Fail::new("invalid_binarycookies"))?)
        .ok_or_else(|| Fail::new("invalid_binarycookies"))?;
    if table_end > bytes.len() {
        return Err(Fail::new("invalid_binarycookies").with("detail", "page table truncated"));
    }
    let page_sizes: Vec<usize> = (0..page_count)
        .map(|i| u32_be(bytes, 8 + 4 * i).unwrap_or(0) as usize)
        .collect();

    let mut cursor = table_end;
    let mut pages: Vec<(usize, usize)> = Vec::new();
    let mut cookies: Vec<serde_json::Value> = Vec::new();
    let mut cookie_total: u64 = 0;
    let mut page_rows: Vec<serde_json::Value> = Vec::new();

    for (page_index, &page_size) in page_sizes.iter().enumerate() {
        let Some(page_end) = cursor.checked_add(page_size) else {
            return Err(Fail::new("invalid_binarycookies").with("detail", "page size overflow"));
        };
        if page_end > bytes.len() {
            envelope.warn(format!(
                "page {page_index} ({page_size} bytes at {cursor}) overruns file; stopped"
            ));
            break;
        }
        let page = &bytes[cursor..page_end];
        pages.push((cursor, page_size));
        if page.len() >= 8 && u32_be(page, 0) == Some(PAGE_MAGIC) {
            let mut declared_cookies = u32_le(page, 4).unwrap_or(0) as usize;
            if declared_cookies > MAX_RESULTS {
                envelope.warn(format!(
                    "page {page_index} declares implausible cookie count {declared_cookies}"
                ));
                declared_cookies = 0;
            }
            let offsets_end = 8usize.saturating_add(4 * declared_cookies);
            if offsets_end + 4 > page.len() {
                envelope.warn(format!("page {page_index} cookie offset table truncated"));
                declared_cookies = 0;
            }
            let mut page_cookies = 0usize;
            for i in 0..declared_cookies {
                let rel = u32_le(page, 8 + 4 * i).unwrap_or(0) as usize;
                if rel >= page.len() {
                    envelope.warn(format!(
                        "page {page_index} cookie {i} offset {rel} outside page"
                    ));
                    continue;
                }
                let record = &page[rel..];
                let Some(size) = u32_le(record, 0).map(|v| v as usize) else {
                    continue;
                };
                if size == 0 || size > MAX_COOKIE_SIZE {
                    envelope.warn(format!(
                        "page {page_index} cookie {i} implausible size {size}"
                    ));
                    continue;
                }
                if size > record.len() {
                    envelope.warn(format!(
                        "page {page_index} cookie {i} size {size} overruns page"
                    ));
                    continue;
                }
                let record = &record[..size];
                if record.len() < COOKIE_HEADER {
                    envelope.warn(format!(
                        "page {page_index} cookie {i} too small ({})",
                        record.len()
                    ));
                    continue;
                }
                cookie_total += 1;
                page_cookies += 1;
                if cookies.len() >= max_results {
                    envelope.truncated = true;
                    continue;
                }
                let flags = u32_le(record, 8).unwrap_or(0);
                let mut flag_names = Vec::new();
                if flags & 0x1 != 0 {
                    flag_names.push("secure");
                }
                if flags & 0x4 != 0 {
                    flag_names.push("http_only");
                }
                let expires = f64_le(record, 40);
                let created = f64_le(record, 48);
                let value_offset = u32_le(record, 28).unwrap_or(0) as usize;
                let raw_value: &[u8] = if value_offset >= COOKIE_HEADER && value_offset < record.len()
                {
                    let tail = &record[value_offset..];
                    let end = tail.iter().position(|b| *b == 0).unwrap_or(tail.len());
                    &tail[..end]
                } else {
                    &[]
                };
                cookies.push(serde_json::json!({
                    "page": page_index,
                    "index": i,
                    "record_offset": cursor + rel,
                    "size": size,
                    "domain": cookie_string(record, u32_le(record, 16).unwrap_or(0), "domain", envelope),
                    "name": cookie_string(record, u32_le(record, 20).unwrap_or(0), "name", envelope),
                    "path": cookie_string(record, u32_le(record, 24).unwrap_or(0), "path", envelope),
                    "comment": cookie_string(record, u32_le(record, 32).unwrap_or(0), "comment", envelope),
                    "flags": {
                        "raw": format!("0x{flags:08x}"),
                        "names": flag_names,
                    },
                    "secure": flags & 0x1 != 0,
                    "http_only": flags & 0x4 != 0,
                    "expires_unix": expires.and_then(mac_time_to_unix),
                    "created_unix": created.and_then(mac_time_to_unix),
                    "value": preview(raw_value),
                }));
            }
            page_rows.push(serde_json::json!({
                "index": page_index,
                "offset": cursor,
                "size": page_size,
                "declared_cookies": declared_cookies,
                "parsed_cookies": page_cookies,
            }));
        } else {
            envelope.warn(format!("page {page_index} bad page magic; skipped"));
        }
        cursor = page_end;
    }

    // Trailer: checksum (u32 BE), 8-byte footer magic, optional metadata.
    let mut checksum_stored: Option<u32> = None;
    let mut checksum_valid: Option<bool> = None;
    let mut footer_valid = false;
    let mut metadata_note = serde_json::Value::Null;
    let tail = &bytes[cursor.min(bytes.len())..];
    if tail.len() >= 4 {
        let stored = u32_be(tail, 0).unwrap_or(0);
        checksum_stored = Some(stored);
        let computed = checksum_pages(bytes, &pages);
        checksum_valid = Some(computed == stored);
        if checksum_valid == Some(false) {
            envelope.warn(format!(
                "checksum mismatch (stored {stored:#010x}, computed {computed:#010x})"
            ));
        }
    } else if !tail.is_empty() {
        envelope.warn(format!("{} trailing bytes after pages", tail.len()));
    }
    if tail.len() >= 12 && tail[4..12] == FILE_FOOTER {
        footer_valid = true;
        let metadata = &tail[12..];
        if !metadata.is_empty() {
            metadata_note = if metadata.starts_with(b"bplist") {
                serde_json::json!({
                    "kind": "bplist",
                    "length": metadata.len(),
                    "note": "NSHTTPCookieAcceptPolicy metadata plist (not decoded)",
                })
            } else {
                serde_json::json!({
                    "kind": "unknown",
                    "length": metadata.len(),
                })
            };
        }
    } else if tail.len() > 4 {
        envelope.warn("binarycookies footer magic missing".to_string());
    }

    if cookie_total > cookies.len() as u64 {
        envelope.truncated = true;
        envelope.warn(format!(
            "cookie list truncated at {} of {} cookies",
            cookies.len(),
            cookie_total
        ));
    }

    Ok(serde_json::json!({
        "kind": "safari_cookies",
        "file_size": bytes.len(),
        "page_count": pages.len(),
        "declared_pages": page_count,
        "pages": page_rows,
        "cookie_count": cookie_total,
        "cookies_returned": cookies.len(),
        "cookies": cookies,
        "checksum": {
            "stored": checksum_stored.map(|v| format!("0x{v:08x}")),
            "valid": checksum_valid,
        },
        "footer_valid": footer_valid,
        "metadata": metadata_note,
    }))
}
