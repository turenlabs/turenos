#![forbid(unsafe_code)]

//! Bounded, offline browser forensic-artifact parser for TurenOS triage —
//! the browser counterpart to the `windows-artifacts` and `macos-artifacts`
//! targets. Each operation accepts one artifact's raw bytes plus a JSON
//! options string and returns bounded, deterministic JSON. The module never
//! touches the network, filesystem, process, or environment; expected
//! failures degrade to stable error JSON
//! (`{"schema_version":1,"error":"<code>"}`) or explicit warnings — nothing
//! is silently skipped.
//!
//! Implemented formats (all original bounded implementations written
//! against documented on-disk layouts):
//!   - `leveldb_log_parse`    Chromium LevelDB write log (.log)
//!   - `leveldb_table_parse`  Chromium LevelDB table (.ldb/.sst)
//!   - `chrome_cache_parse`   Chromium simple-disk-cache entry files
//!   - `safari_cookies_parse` Cookies.binarycookies jars
//!   - `analyze`              magic/CRC sniffing dispatcher

mod binarycookies;
mod ldblog;
mod ldbtable;
mod simplecache;

#[cfg(test)]
mod tests;

use serde::de::DeserializeOwned;
use wasm_bindgen::prelude::*;

/// Hard input bound enforced before any parsing or allocation.
pub(crate) const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
/// Hard bound on the JSON options string.
pub(crate) const MAX_OPTIONS_BYTES: usize = 4 * 1024;
/// Hard bound on serialized JSON output.
pub(crate) const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
/// Hard bound on collected result lists (records, entries, cookies).
pub(crate) const MAX_RESULTS: usize = 4096;
/// Default result-list bound when the caller does not set `max_results`.
pub(crate) const DEFAULT_RESULTS: usize = 256;
/// Per-string cap applied to reported text (keys, values, paths, names).
pub(crate) const MAX_STRING_CHARS: usize = 1024;
/// Bound on warning strings collected per call.
pub(crate) const MAX_WARNINGS: usize = 64;
/// UTF-8 preview characters emitted per key/value preview.
pub(crate) const PREVIEW_CHARS: usize = 512;
/// Hex bytes emitted per key/value preview.
pub(crate) const PREVIEW_BYTES: usize = 64;
/// Bound on decompressed LevelDB table blocks (declared length is checked
/// against this cap before allocation).
pub(crate) const MAX_DECOMPRESSED_BYTES: usize = 64 * 1024 * 1024;
/// LevelDB log block size.
pub(crate) const LEVELDB_BLOCK_SIZE: usize = 32 * 1024;
/// Bound on table blocks walked per call (index + data + metaindex).
pub(crate) const MAX_TABLE_BLOCKS: usize = 4096;
/// Bound on entries decoded inside one table block.
pub(crate) const MAX_BLOCK_ENTRIES: usize = 65536;
/// Bound on Safari cookie pages walked.
pub(crate) const MAX_SAFARI_PAGES: usize = 4096;
/// Bound on one Safari cookie record.
pub(crate) const MAX_COOKIE_SIZE: usize = 16 * 1024;
/// Bound on response headers reported from a cache stream-0 pickle.
pub(crate) const MAX_CACHE_HEADERS: usize = 128;
/// Bound on sparse ranges reported per cache stream.
pub(crate) const MAX_SPARSE_RANGES: usize = 4096;
/// Bound on a reassembled logical log record across fragments.
pub(crate) const MAX_LOGICAL_RECORD: usize = 32 * 1024 * 1024;
/// Bound on a declared cache key length.
pub(crate) const MAX_CACHE_KEY: usize = 1024 * 1024;

/// Failure carrying a stable machine-readable code plus optional detail
/// fields merged into the error JSON object.
pub(crate) struct Fail {
    code: &'static str,
    extra: serde_json::Map<String, serde_json::Value>,
}

impl Fail {
    pub(crate) fn new(code: &'static str) -> Self {
        Self {
            code,
            extra: serde_json::Map::new(),
        }
    }

    pub(crate) fn with(mut self, key: &str, value: impl Into<serde_json::Value>) -> Self {
        self.extra.insert(key.to_string(), value.into());
        self
    }
}

/// Success envelope shared by every operation: `{schema_version, format,
/// truncated, warnings, result}`.
#[derive(serde::Serialize)]
pub(crate) struct Envelope {
    schema_version: u8,
    format: &'static str,
    truncated: bool,
    warnings: Vec<String>,
    result: serde_json::Value,
}

impl Envelope {
    pub(crate) fn new(format: &'static str) -> Self {
        Self {
            schema_version: 1,
            format,
            truncated: false,
            warnings: Vec::new(),
            result: serde_json::Value::Null,
        }
    }

    /// Push a bounded warning string; saturation collapses into a single
    /// marker so the warnings list itself stays bounded.
    pub(crate) fn warn(&mut self, message: impl Into<String>) {
        if self.warnings.len() < MAX_WARNINGS {
            self.warnings.push(message.into());
        } else if self.warnings.len() == MAX_WARNINGS {
            self.warnings
                .push("additional warnings suppressed".to_string());
        }
    }

    pub(crate) fn finish(self, result: serde_json::Value) -> serde_json::Value {
        serde_json::to_value(Envelope {
            result,
            ..self
        })
        .unwrap_or_else(|_| serde_json::json!({ "schema_version": 1, "error": "serialization_error" }))
    }
}

pub(crate) fn error_json(code: &str) -> String {
    serde_json::json!({ "schema_version": 1, "error": code }).to_string()
}

fn fail_json(fail: Fail) -> String {
    let mut object = serde_json::Map::new();
    object.insert("schema_version".to_string(), 1.into());
    object.insert("error".to_string(), fail.code.into());
    object.extend(fail.extra);
    serde_json::Value::Object(object).to_string()
}

/// Parse the options JSON. An empty string means defaults; anything else
/// must be a valid JSON object (never an array — that would allow
/// positional option smuggling). Size is checked by the dispatcher.
fn parse_options<T: DeserializeOwned + Default>(options_json: &str) -> Result<T, Fail> {
    let trimmed = options_json.trim();
    if trimmed.is_empty() {
        return Ok(T::default());
    }
    let value: serde_json::Value =
        serde_json::from_str(trimmed).map_err(|_| Fail::new("invalid_options"))?;
    if !value.is_object() {
        return Err(Fail::new("invalid_options"));
    }
    serde_json::from_value(value).map_err(|_| Fail::new("invalid_options"))
}

/// Shared dispatcher: enforce input/options bounds before any allocation,
/// run the operation under `catch_unwind` so a parser panic on malformed
/// input degrades to `internal_error` instead of trapping the worker, then
/// bound serialized output.
fn dispatch<T, F>(bytes: &[u8], options_json: &str, format: &'static str, op: F) -> String
where
    T: DeserializeOwned + Default,
    F: FnOnce(&[u8], &T, &mut Envelope) -> Result<serde_json::Value, Fail>,
{
    if bytes.is_empty() {
        return error_json("empty_input");
    }
    if bytes.len() > MAX_INPUT_BYTES {
        return error_json("input_too_large");
    }
    if options_json.len() > MAX_OPTIONS_BYTES {
        return error_json("options_too_large");
    }
    let options = match parse_options::<T>(options_json) {
        Ok(options) => options,
        Err(fail) => return fail_json(fail),
    };
    let value = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut envelope = Envelope::new(format);
        let result = op(bytes, &options, &mut envelope)?;
        Ok(envelope.finish(result))
    })) {
        Ok(Ok(value)) => value,
        Ok(Err(fail)) => return fail_json(fail),
        Err(_) => return fail_json(Fail::new("internal_error")),
    };
    match serde_json::to_string(&value) {
        Ok(json) if json.len() <= MAX_OUTPUT_BYTES => json,
        Ok(_) => error_json("output_too_large"),
        Err(_) => error_json("serialization_error"),
    }
}

/// Auto-detect the artifact kind and run the matching parser. Detection
/// order per README: `cook` magic, simple-cache magics, sstable footer
/// magic, then a CRC-verified LevelDB log probe. Unrecognized input yields
/// `{"schema_version":1,"error":"unknown_artifact"}`.
///
/// Options: same as the resolved operation.
#[wasm_bindgen]
pub fn analyze(bytes: &[u8], options_json: &str) -> String {
    match detect_kind(bytes) {
        "safari_cookies" => safari_cookies_parse(bytes, options_json),
        "chrome_cache" => chrome_cache_parse(bytes, options_json),
        "leveldb_table" => leveldb_table_parse(bytes, options_json),
        "leveldb_log" => leveldb_log_parse(bytes, options_json),
        _ => {
            if bytes.is_empty() {
                error_json("empty_input")
            } else if bytes.len() > MAX_INPUT_BYTES {
                error_json("input_too_large")
            } else {
                error_json("unknown_artifact")
            }
        }
    }
}

/// Parse one Chromium LevelDB write log (`.log`, the journal format behind
/// Local Storage, Session Storage, and IndexedDB). Physical records are
/// framed in 32 KiB blocks as FULL/FIRST/MIDDLE/LAST fragments with a
/// masked CRC-32C verified per record (`verify_crc`, default true) and
/// reassembled into logical records; each logical record decodes as a
/// WriteBatch whose entries surface as `{index, log_offset,
/// batch_sequence, sequence, operation, key, value}` rows — tombstones
/// report `operation: "delete"`, non-WriteBatch payloads (e.g. MANIFEST
/// VersionEdits) report `"unparsed"`. Corrupt records are flagged and the
/// remainder of their block skipped per LevelDB resync semantics; the file
/// never fails mid-parse.
///
/// Options: `max_results` (cap 4096, default 256), `verify_crc`
/// (default true).
#[wasm_bindgen]
pub fn leveldb_log_parse(bytes: &[u8], options_json: &str) -> String {
    dispatch::<ldblog::LogOptions, _>(bytes, options_json, "leveldb_log", ldblog::run)
}

/// Parse one Chromium LevelDB table (`.ldb`/`.sst`): the 48-byte footer
/// (metaindex + index block handles, magic `0xdb4775248b80fb57`), the
/// metaindex and index blocks, then every referenced data block decoded
/// with shared-prefix restart-array entry decompression. Snappy
/// (`snap`, raw format) blocks are decompressed with the declared length
/// checked against a 64 MiB cap before allocation; each block's CRC-32C is
/// verified when `verify_crc` is set and reported per block. Internal keys
/// decode to `{sequence, operation, user_key}` — tombstones surface as
/// `"delete"`.
///
/// Options: `max_results` (cap 4096, default 256), `verify_crc`
/// (default true), `include_index` (also list index-block entries,
/// default false).
#[wasm_bindgen]
pub fn leveldb_table_parse(bytes: &[u8], options_json: &str) -> String {
    dispatch::<ldbtable::TableOptions, _>(
        bytes,
        options_json,
        "leveldb_table",
        ldbtable::run,
    )
}

/// Parse one Chromium simple-disk-cache entry file: `SimpleFileHeader`
/// (initial magic, version, key length, key hash), the stored key (usually
/// a URL) verified against `key_hash` (SuperFastHash) and the optional
/// pre-EOF key SHA-256, the combined stream-1/stream-0 layout resolved via
/// the stream-0 `stream_size`, IEEE CRC-32 verification of each stream
/// when `FLAG_HAS_CRC32` is set, sparse-range headers
/// (`kSimpleSparseRangeMagicNumber`) identified and walked, and a
/// best-effort `HttpResponseInfo` pickle decode of stream 0 yielding
/// request/response/original-response times plus the NUL-separated raw
/// response headers. The on-disk entry format itself stores no per-file
/// timestamps; entry times come from the stream-0 response-info pickle.
///
/// Options: `max_results` (cap 4096, default 256 — bounds headers and
/// sparse ranges).
#[wasm_bindgen]
pub fn chrome_cache_parse(bytes: &[u8], options_json: &str) -> String {
    dispatch::<simplecache::CacheOptions, _>(
        bytes,
        options_json,
        "chrome_cache",
        simplecache::run,
    )
}

/// Parse one `Cookies.binarycookies` jar: `"cook"` magic, big-endian page
/// table, little-endian page/cookie records. Each cookie decodes to
/// `{page, index, domain, path, name, secure, http_only, flags,
/// expires_unix, created_unix, value, comment}` with the value as a
/// bounded preview (512 UTF-8 chars + 64 hex bytes + SHA-256) and
/// Cocoa-epoch timestamps converted to Unix seconds. The trailing
/// checksum, footer magic, and optional bplist metadata are reported.
///
/// Options: `max_results` (cap 4096, default 256).
#[wasm_bindgen]
pub fn safari_cookies_parse(bytes: &[u8], options_json: &str) -> String {
    dispatch::<binarycookies::CookiesOptions, _>(
        bytes,
        options_json,
        "safari_cookies",
        binarycookies::run,
    )
}

fn detect_kind(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"cook") {
        return "safari_cookies";
    }
    if bytes.starts_with(&simplecache::INITIAL_MAGIC.to_le_bytes())
        || bytes.starts_with(&simplecache::SPARSE_MAGIC.to_le_bytes())
    {
        return "chrome_cache";
    }
    if ldbtable::has_table_magic(bytes) {
        return "leveldb_table";
    }
    if ldblog::probe_log(bytes) {
        return "leveldb_log";
    }
    "unknown"
}

/// Bounded string copy used by every artifact parser.
pub(crate) fn clean(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_string();
    }
    let end = value
        .char_indices()
        .take_while(|(index, _)| *index < limit)
        .last()
        .map(|(index, character)| index + character.len_utf8())
        .unwrap_or(0);
    value[..end].to_string()
}

/// SHA-256 of a byte slice as lowercase hex.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    hex_encode(&sha2::Sha256::digest(bytes))
}

/// Lowercase hex of at most `limit` leading bytes (default PREVIEW_BYTES).
pub(crate) fn hex_n(bytes: &[u8], limit: usize) -> String {
    hex_encode(&bytes[..bytes.len().min(limit)])
}

pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// Bounded preview object shared by every record:
/// `{length, utf8, utf8_valid, hex, sha256}` where `utf8` is the decoded
/// string capped at PREVIEW_CHARS (null when the bytes are not valid
/// UTF-8) and `hex` covers at most PREVIEW_BYTES leading bytes.
pub(crate) fn preview(bytes: &[u8]) -> serde_json::Value {
    let utf8 = std::str::from_utf8(bytes).ok().map(|s| clean(s, PREVIEW_CHARS));
    serde_json::json!({
        "length": bytes.len(),
        "utf8": utf8,
        "utf8_valid": std::str::from_utf8(bytes).is_ok(),
        "hex": hex_n(bytes, PREVIEW_BYTES),
        "sha256": sha256_hex(bytes),
    })
}

/// Clamp a caller-supplied limit to `[1, cap]`.
pub(crate) fn clamp_limit(value: Option<u64>, default: usize, cap: usize) -> usize {
    value
        .map(|v| usize::try_from(v).unwrap_or(usize::MAX))
        .unwrap_or(default)
        .clamp(1, cap)
}

pub(crate) fn u16_le(bytes: &[u8], offset: usize) -> Option<u16> {
    let raw: [u8; 2] = bytes.get(offset..offset.checked_add(2)?)?.try_into().ok()?;
    Some(u16::from_le_bytes(raw))
}

pub(crate) fn u32_le(bytes: &[u8], offset: usize) -> Option<u32> {
    let raw: [u8; 4] = bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?;
    Some(u32::from_le_bytes(raw))
}

pub(crate) fn u32_be(bytes: &[u8], offset: usize) -> Option<u32> {
    let raw: [u8; 4] = bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?;
    Some(u32::from_be_bytes(raw))
}

pub(crate) fn u64_le(bytes: &[u8], offset: usize) -> Option<u64> {
    let raw: [u8; 8] = bytes.get(offset..offset.checked_add(8)?)?.try_into().ok()?;
    Some(u64::from_le_bytes(raw))
}

pub(crate) fn f64_le(bytes: &[u8], offset: usize) -> Option<f64> {
    Some(f64::from_bits(u64_le(bytes, offset)?))
}

/// Read a LevelDB-style varint64 (base-128, little-endian groups, at most
/// 10 bytes; the 10th byte may only contribute bit 63).
pub(crate) fn varint64(data: &[u8], pos: &mut usize) -> Option<u64> {
    let mut result: u64 = 0;
    for i in 0..10 {
        let byte = *data.get(*pos)?;
        *pos += 1;
        if i == 9 && byte > 1 {
            return None;
        }
        result |= u64::from(byte & 0x7f) << (7 * i);
        if byte & 0x80 == 0 {
            return Some(result);
        }
    }
    None
}

/// varint32 is a varint64 of at most 5 bytes whose value fits a u32.
pub(crate) fn varint32(data: &[u8], pos: &mut usize) -> Option<u32> {
    let start = *pos;
    let value = varint64(data, pos)?;
    if *pos - start > 5 {
        return None;
    }
    u32::try_from(value).ok()
}

/// Masked CRC-32C used by LevelDB log records and table block trailers:
/// `mask(crc) = ((crc >> 15) | (crc << 17)) + 0xa282ead8`.
pub(crate) fn mask_crc(crc: u32) -> u32 {
    crc.rotate_right(15).wrapping_add(0xa282_ead8)
}

/// CRC-32C over `type_byte ++ payload`, masked — the LevelDB record
/// checksum formula.
pub(crate) fn leveldb_record_crc(type_byte: u8, payload: &[u8]) -> u32 {
    let crc = crc32c::crc32c_append(crc32c::crc32c(&[type_byte]), payload);
    mask_crc(crc)
}
