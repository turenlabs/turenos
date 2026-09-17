//! Bounded Chromium simple-disk-cache entry parsing, hand-rolled from
//! `net/disk_cache/simple/simple_entry_format.h` and
//! `simple_synchronous_entry.cc`.
//!
//! A combined entry file (streams 0+1) is:
//!   SimpleFileHeader(24) ++ key ++ stream-1 data ++ stream-1 EOF(24) ++
//!   stream-0 data ++ [key SHA-256(32) when FLAG_HAS_KEY_SHA256] ++
//!   stream-0 EOF(24)
//! A stream-2-only file is header ++ key ++ data ++ EOF. A sparse file is
//! a sequence of `SimpleFileSparseRangeHeader(32) ++ range data`.
//!
//! `key_hash` is Chromium's `base::PersistentHash` (SuperFastHash);
//! `data_crc32` is zlib CRC-32 (IEEE) — both are implemented here so no
//! new dependency is needed. Stream 0 is a `base::Pickle` of
//! `HttpResponseInfo`; it is decoded best-effort to surface the request/
//! response/original-response times and the NUL-separated raw headers.

use serde::Deserialize;

use crate::{
    clamp_limit, clean, preview, sha256_hex, u32_le, u64_le, Envelope, Fail,
    DEFAULT_RESULTS, MAX_CACHE_HEADERS, MAX_CACHE_KEY, MAX_RESULTS, MAX_SPARSE_RANGES,
    MAX_STRING_CHARS,
};

#[derive(Deserialize, Default)]
pub(crate) struct CacheOptions {
    pub(crate) max_results: Option<u64>,
}

pub(crate) const INITIAL_MAGIC: u64 = 0xfcfb6d1ba7725c30;
pub(crate) const FINAL_MAGIC: u64 = 0xf4fa6f45970d41d8;
pub(crate) const SPARSE_MAGIC: u64 = 0xeb97bf016553676b;

const HEADER_SIZE: usize = 24;
const EOF_SIZE: usize = 24;
const EOF_SIZE_LEGACY: usize = 20;
const SHA256_SIZE: usize = 32;
const SPARSE_HEADER_SIZE: usize = 32;
const SIMPLE_ENTRY_VERSION: u32 = 5;
const FLAG_HAS_CRC32: u32 = 1;
const FLAG_HAS_KEY_SHA256: u32 = 2;
const CHROMIUM_TIME_EPOCH_DELTA_US: i64 = 11_644_473_600_000_000;

struct Eof {
    offset: usize,
    size: usize,
    flags: u32,
    data_crc32: u32,
    stream_size: u32,
}

/// Locate the terminal EOF record: prefer the current 24-byte layout
/// (magic, flags, crc32, stream_size, padding), tolerate the 20-byte
/// layout some writers produced before the explicit padding member.
fn read_eof_at_tail(bytes: &[u8]) -> Option<Eof> {
    for size in [EOF_SIZE, EOF_SIZE_LEGACY] {
        if bytes.len() < size {
            continue;
        }
        let offset = bytes.len() - size;
        if u64_le(bytes, offset) != Some(FINAL_MAGIC) {
            continue;
        }
        return Some(Eof {
            offset,
            size,
            flags: u32_le(bytes, offset + 8)?,
            data_crc32: u32_le(bytes, offset + 12)?,
            stream_size: u32_le(bytes, offset + 16)?,
        });
    }
    None
}

/// Probe for an EOF record ending exactly at `end` (used for the stream-1
/// record that immediately precedes stream-0 data).
fn read_eof_ending_at(bytes: &[u8], end: usize) -> Option<Eof> {
    for size in [EOF_SIZE, EOF_SIZE_LEGACY] {
        if end < size {
            continue;
        }
        let offset = end - size;
        if u64_le(bytes, offset) != Some(FINAL_MAGIC) {
            continue;
        }
        return Some(Eof {
            offset,
            size,
            flags: u32_le(bytes, offset + 8)?,
            data_crc32: u32_le(bytes, offset + 12)?,
            stream_size: u32_le(bytes, offset + 16)?,
        });
    }
    None
}

/// zlib CRC-32 (IEEE 802.3, reflected poly 0xEDB88320) as used by
/// `simple_util::Crc32`. Hand-rolled: the `crc32c` crate only covers the
/// Castagnoli polynomial.
pub(crate) fn crc32_ieee(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xffff_ffff;
    for &byte in data {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

/// Chromium `base::PersistentHash` — Paul Hsieh's SuperFastHash
/// (base/third_party/superfasthash/superfasthash.c), the `key_hash`
/// field of `SimpleFileHeader`.
pub(crate) fn super_fast_hash(data: &[u8]) -> u32 {
    if data.is_empty() {
        return 0;
    }
    let get16 = |d: &[u8]| u32::from(d[0]) | (u32::from(d[1]) << 8);
    let mut hash = data.len() as u32;
    let mut chunks = data.chunks_exact(4);
    for chunk in &mut chunks {
        hash = hash.wrapping_add(get16(chunk));
        let tmp = (get16(&chunk[2..]) << 11) ^ hash;
        hash = (hash << 16) ^ tmp;
        hash = hash.wrapping_add(hash >> 11);
    }
    let rem = chunks.remainder();
    match rem.len() {
        3 => {
            hash = hash.wrapping_add(get16(rem));
            hash ^= hash << 16;
            // The C source sign-extends this byte before the shift.
            hash ^= ((rem[2] as i8) as i32 as u32) << 18;
            hash = hash.wrapping_add(hash >> 11);
        }
        2 => {
            hash = hash.wrapping_add(get16(rem));
            hash ^= hash << 11;
            hash = hash.wrapping_add(hash >> 17);
        }
        1 => {
            hash = hash.wrapping_add(u32::from(rem[0]));
            hash ^= hash << 10;
            hash = hash.wrapping_add(hash >> 6);
        }
        _ => {}
    }
    hash ^= hash << 3;
    hash = hash.wrapping_add(hash >> 5);
    hash ^= hash << 4;
    hash = hash.wrapping_add(hash >> 17);
    hash ^= hash << 25;
    hash = hash.wrapping_add(hash >> 6);
    hash
}

fn chromium_time_json(internal: i64) -> serde_json::Value {
    let unix_us = internal.saturating_sub(CHROMIUM_TIME_EPOCH_DELTA_US);
    serde_json::json!({
        "chromium": internal,
        "unix_us": unix_us,
        "unix_seconds": unix_us as f64 / 1_000_000.0,
    })
}

/// Walk a sparse-data region: `SimpleFileSparseRangeHeader` records each
/// followed by `length` bytes of range data.
fn walk_sparse(
    region: &[u8],
    base_offset: usize,
    max_ranges: usize,
    envelope: &mut Envelope,
) -> (Vec<serde_json::Value>, u64, usize) {
    let mut ranges = Vec::new();
    let mut data_bytes: u64 = 0;
    let mut pos = 0usize;
    while pos + SPARSE_HEADER_SIZE <= region.len() {
        if u64_le(region, pos) != Some(SPARSE_MAGIC) {
            break;
        }
        let range_offset = u64_le(region, pos + 8).unwrap_or(0);
        let length = u64_le(region, pos + 16).unwrap_or(0);
        let stored_crc = u32_le(region, pos + 24).unwrap_or(0);
        let data_start = pos + SPARSE_HEADER_SIZE;
        let Ok(length_usize) = usize::try_from(length) else {
            envelope.warn(format!(
                "sparse range at {} declares implausible length {length}",
                base_offset + pos
            ));
            break;
        };
        let Some(data_end) = data_start.checked_add(length_usize) else {
            envelope.warn(format!(
                "sparse range at {} length overflows",
                base_offset + pos
            ));
            break;
        };
        if data_end > region.len() {
            envelope.warn(format!(
                "sparse range at {} overruns region",
                base_offset + pos
            ));
            break;
        }
        let crc_valid = crc32_ieee(&region[data_start..data_end]) == stored_crc;
        if !crc_valid {
            envelope.warn(format!(
                "sparse range at {} crc32 mismatch",
                base_offset + pos
            ));
        }
        data_bytes += length;
        if ranges.len() < max_ranges {
            ranges.push(serde_json::json!({
                "header_offset": base_offset + pos,
                "offset": range_offset,
                "length": length,
                "data_crc32": format!("0x{stored_crc:08x}"),
                "crc32_valid": crc_valid,
            }));
        }
        pos = data_end;
    }
    (ranges, data_bytes, pos)
}

/// Best-effort `HttpResponseInfo` pickle decode. Layout:
/// `u32 payload_size`, then in the payload: `i32 flags` (version in the
/// low byte; bit31 means a following `i32 extra_flags`), `i64
/// request_time`, `i64 response_time`, optional `i64
/// original_response_time` (extra_flags bit 2), then the
/// `HttpResponseHeaders` blob (`i32 length` + NUL-separated lines,
/// 4-byte aligned). Everything after the headers is ignored.
fn decode_response_info(stream0: &[u8], envelope: &mut Envelope) -> Option<serde_json::Value> {
    let payload_size = u32_le(stream0, 0)? as usize;
    let payload_end = 4usize.checked_add(payload_size).unwrap_or(usize::MAX);
    let region = if payload_end <= stream0.len() {
        &stream0[4..payload_end]
    } else {
        envelope.warn("response-info pickle payload overruns stream; decoding what is present".to_string());
        stream0.get(4..)?
    };
    let mut pos = 0usize;
    let flags = u32_le(region, pos).map(|v| v as i32)?;
    pos += 4;
    let version = flags & 0xff;
    let extra_flags = if flags & (1 << 31) != 0 {
        let value = u32_le(region, pos).map(|v| v as i32)?;
        pos += 4;
        value
    } else {
        0
    };
    let request_time = u64_le(region, pos).map(|v| v as i64)?;
    pos += 8;
    let response_time = u64_le(region, pos).map(|v| v as i64)?;
    pos += 8;
    let original_response_time = if extra_flags & (1 << 2) != 0 {
        let value = u64_le(region, pos).map(|v| v as i64)?;
        pos += 8;
        Some(value)
    } else {
        None
    };
    let headers_len = u32_le(region, pos)? as usize;
    pos += 4;
    let headers_end = pos.checked_add(headers_len)?;
    if headers_end > region.len() {
        envelope.warn("response-info headers blob truncated".to_string());
        return None;
    }
    let blob = &region[pos..headers_end];
    let mut lines: Vec<String> = blob
        .split(|b| *b == 0)
        .filter(|line| !line.is_empty())
        .map(|line| clean(&String::from_utf8_lossy(line), MAX_STRING_CHARS))
        .collect();
    let headers_truncated = lines.len() > MAX_CACHE_HEADERS + 1;
    lines.truncate(MAX_CACHE_HEADERS + 1);
    let status_line = lines.first().cloned().unwrap_or_default();
    let headers = &lines[1.min(lines.len())..];
    Some(serde_json::json!({
        "pickle_payload_size": payload_size,
        "flags": format!("0x{flags:08x}"),
        "version": version,
        "extra_flags": format!("0x{extra_flags:08x}"),
        "request_time": chromium_time_json(request_time),
        "response_time": chromium_time_json(response_time),
        "original_response_time": original_response_time.map(chromium_time_json),
        "status_line": status_line,
        "header_count": headers.len(),
        "headers": headers,
        "headers_truncated": headers_truncated,
    }))
}

/// One stream's decoded report row.
fn stream_json(
    index: u32,
    data: &[u8],
    data_offset: usize,
    eof: Option<&Eof>,
    envelope: &mut Envelope,
) -> serde_json::Value {
    let mut row = serde_json::json!({
        "index": index,
        "data_offset": data_offset,
        "data_length": data.len(),
        "data": preview(data),
    });
    if let Some(eof) = eof {
        let crc_flag = eof.flags & FLAG_HAS_CRC32 != 0;
        let crc_valid = if crc_flag {
            Some(crc32_ieee(data) == eof.data_crc32)
        } else {
            None
        };
        if crc_valid == Some(false) {
            envelope.warn(format!("stream {index}: data crc32 mismatch"));
        }
        row["eof"] = serde_json::json!({
            "offset": eof.offset,
            "size": eof.size,
            "flags": format!("0x{:08x}", eof.flags),
            "has_crc32": crc_flag,
            "has_key_sha256": eof.flags & FLAG_HAS_KEY_SHA256 != 0,
            "data_crc32": format!("0x{:08x}", eof.data_crc32),
            "crc32_valid": crc_valid,
            "stream_size": eof.stream_size,
        });
    }
    if index == 0 {
        if let Some(info) = decode_response_info(data, envelope) {
            row["response_info"] = info;
        }
    }
    row
}

pub(crate) fn run(
    bytes: &[u8],
    options: &CacheOptions,
    envelope: &mut Envelope,
) -> Result<serde_json::Value, Fail> {
    let max_results = clamp_limit(options.max_results, DEFAULT_RESULTS, MAX_RESULTS);
    let range_cap = max_results.min(MAX_SPARSE_RANGES);

    // --- pure sparse file: no SimpleFileHeader, just range records ---
    if u64_le(bytes, 0) == Some(SPARSE_MAGIC) {
        let (ranges, data_bytes, consumed) =
            walk_sparse(bytes, 0, range_cap, envelope);
        if ranges.is_empty() {
            return Err(Fail::new("invalid_cache_entry")
                .with("detail", "sparse magic but no parseable ranges"));
        }
        if ranges.len() >= range_cap {
            envelope.truncated = true;
        }
        return Ok(serde_json::json!({
            "kind": "chrome_cache_sparse",
            "file_size": bytes.len(),
            "range_count": ranges.len(),
            "range_data_bytes": data_bytes,
            "trailing_bytes": bytes.len() - consumed,
            "ranges": ranges,
        }));
    }

    if bytes.len() < HEADER_SIZE || u64_le(bytes, 0) != Some(INITIAL_MAGIC) {
        return Err(Fail::new("invalid_cache_entry"));
    }
    let version = u32_le(bytes, 8).unwrap_or(0);
    let key_length = u32_le(bytes, 12).unwrap_or(0) as usize;
    let key_hash = u32_le(bytes, 16).unwrap_or(0);
    if version != SIMPLE_ENTRY_VERSION {
        envelope.warn(format!("unusual entry version {version} (expected {SIMPLE_ENTRY_VERSION})"));
    }
    if key_length == 0 || key_length > MAX_CACHE_KEY {
        return Err(Fail::new("invalid_cache_entry")
            .with("detail", format!("implausible key_length {key_length}")));
    }
    if HEADER_SIZE + key_length > bytes.len() {
        return Err(Fail::new("invalid_cache_entry")
            .with("detail", "key overruns file"));
    }
    let key = &bytes[HEADER_SIZE..HEADER_SIZE + key_length];
    let computed_hash = super_fast_hash(key);
    let key_hash_valid = computed_hash == key_hash;
    if !key_hash_valid {
        envelope.warn(format!(
            "key_hash mismatch (stored {key_hash:#010x}, computed {computed_hash:#010x})"
        ));
    }
    let data_start = HEADER_SIZE + key_length;
    let mut streams: Vec<serde_json::Value> = Vec::new();
    let mut sparse_rows: Option<serde_json::Value> = None;
    let mut key_sha256: Option<String> = None;
    let mut key_sha256_valid: Option<bool> = None;
    let mut layout = "single_stream";

    let terminal_eof = read_eof_at_tail(bytes);
    match &terminal_eof {
        Some(eof0) => {
            let mut stream0_end = eof0.offset;
            if eof0.flags & FLAG_HAS_KEY_SHA256 != 0 && stream0_end >= SHA256_SIZE {
                let sha = &bytes[stream0_end - SHA256_SIZE..stream0_end];
                key_sha256 = Some(crate::hex_encode(sha));
                key_sha256_valid = Some(sha256_hex(key) == crate::hex_encode(sha));
                stream0_end -= SHA256_SIZE;
            }
            let stream0_size = eof0.stream_size as usize;
            // Combined layout: a second EOF ends exactly where the
            // stream-0 region begins.
            let stream0_start = stream0_end.checked_sub(stream0_size);
            let eof1 = stream0_start.and_then(|start| read_eof_ending_at(bytes, start));
            match (stream0_start, eof1) {
                (Some(start), Some(eof1))
                    if start >= data_start && eof1.offset >= data_start =>
                {
                    layout = "combined";
                    let stream1 = &bytes[data_start..eof1.offset];
                    let stream0 = &bytes[start..stream0_end];
                    streams.push(stream_json(1, stream1, data_start, Some(&eof1), envelope));
                    streams.push(stream_json(0, stream0, start, Some(&eof0), envelope));
                }
                _ => {
                    // Single-stream file: data runs from the key to the
                    // (sha-adjusted) EOF.
                    let data = &bytes[data_start..stream0_end.max(data_start).min(bytes.len())];
                    // Sparse data inside a single-stream region?
                    if u64_le(data, 0) == Some(SPARSE_MAGIC) {
                        let (ranges, data_bytes, consumed) =
                            walk_sparse(data, data_start, range_cap, envelope);
                        sparse_rows = Some(serde_json::json!({
                            "range_count": ranges.len(),
                            "range_data_bytes": data_bytes,
                            "unparsed_bytes": data.len().saturating_sub(consumed),
                            "ranges": ranges,
                        }));
                        if ranges.len() >= range_cap {
                            envelope.truncated = true;
                        }
                    } else if !data.is_empty() {
                        streams.push(stream_json(2, data, data_start, Some(&eof0), envelope));
                        if stream0_size != 0 {
                            envelope.warn(format!(
                                "single-stream EOF declares stream_size {stream0_size}; ignored"
                            ));
                        }
                    } else {
                        envelope.warn("entry contains no stream data".to_string());
                    }
                }
            }
        }
        None => {
            envelope.warn("no SimpleFileEOF record at end of file".to_string());
            let data = &bytes[data_start..];
            if u64_le(data, 0) == Some(SPARSE_MAGIC) {
                let (ranges, data_bytes, consumed) =
                    walk_sparse(data, data_start, range_cap, envelope);
                sparse_rows = Some(serde_json::json!({
                    "range_count": ranges.len(),
                    "range_data_bytes": data_bytes,
                    "unparsed_bytes": data.len().saturating_sub(consumed),
                    "ranges": ranges,
                }));
            } else if !data.is_empty() {
                streams.push(stream_json(2, data, data_start, None, envelope));
            }
        }
    }

    Ok(serde_json::json!({
        "kind": "chrome_cache_entry",
        "file_size": bytes.len(),
        "layout": layout,
        "header": {
            "size": HEADER_SIZE,
            "version": version,
            "key_length": key_length,
            "key_hash": format!("0x{key_hash:08x}"),
            "key_hash_computed": format!("0x{computed_hash:08x}"),
            "key_hash_valid": key_hash_valid,
        },
        "key": preview(key),
        "key_sha256": key_sha256,
        "key_sha256_valid": key_sha256_valid,
        "eof_present": terminal_eof.is_some(),
        "streams": streams,
        "sparse": sparse_rows,
    }))
}
