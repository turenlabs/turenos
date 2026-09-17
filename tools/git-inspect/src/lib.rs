//! Bounded, offline, read-only inspection of git storage files.
//!
//! Input is always one file's bytes: a loose zlib object, a packfile, a pack
//! index, or a `DIRC` index. No repository path, refs traversal, network, or
//! filesystem is involved. Every operation returns bounded JSON
//! (`{"schema_version":1,...}`) or, for `git_pack_entry_raw`, one bounded byte
//! vector. Expected failures return `{"schema_version":1,"error":"<code>"}`.

mod delta;
mod dirc;
mod identify;
mod loose;
mod object;
mod pack;
mod zlib;

#[cfg(test)]
mod fixtures;
#[cfg(test)]
mod tests;

use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::panic::{catch_unwind, AssertUnwindSafe};
use wasm_bindgen::prelude::*;

pub(crate) const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const MAX_OPTIONS_BYTES: usize = 4 * 1024;
pub(crate) const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_ITEMS: usize = 4096;
pub(crate) const MAX_STRING_BYTES: usize = 4096;
pub(crate) const MAX_MESSAGE_BYTES: usize = 64 * 1024;
pub(crate) const MAX_PREVIEW_BYTES: usize = 64 * 1024;
/// One extracted object (loose content or resolved pack entry).
pub(crate) const MAX_OBJECT_BYTES: usize = 128 * 1024 * 1024;
pub(crate) const MAX_DELTA_DEPTH: usize = 64;
/// Aggregate decompressed bytes per call across scanning + chain resolution;
/// bounds CPU spent on compression-bomb packs.
pub(crate) const RESOLVE_BUDGET_BYTES: u64 = 256 * 1024 * 1024;
/// Entry headers scanned per pack (each head is a few dozen bytes of state).
pub(crate) const MAX_SCAN_ENTRIES: usize = 65536;
pub(crate) const MAX_EXTENSIONS: usize = 256;
/// Probe-inflate cap used by `git_identify` — only the object header is needed.
pub(crate) const IDENTIFY_INFLATE_CAP: usize = 1024 * 1024;

/// Shared per-request state: collected warnings and a truncation flag that
/// serializers echo back in the report body.
pub(crate) struct Report {
    pub warnings: Vec<String>,
    pub truncated: bool,
}

impl Report {
    fn new() -> Self {
        Self {
            warnings: Vec::new(),
            truncated: false,
        }
    }
}

/// Classify one file's bytes: loose object, packfile, pack index (v1/v2),
/// index (`DIRC`), bundle, or unknown.
#[wasm_bindgen]
pub fn git_identify(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return error_json("empty_input");
    }
    if bytes.len() > MAX_INPUT_BYTES {
        return error_json("input_too_large");
    }
    let mut report = Report::new();
    let result = catch_unwind(AssertUnwindSafe(|| identify::identify(bytes, &mut report)));
    finish(result)
}

/// Inflate and decode a loose object (`type SP size NUL content`): structured
/// fields for commit/tag/tree, bounded preview + sha256 for blobs, and the
/// recomputed SHA-1 object id.
#[wasm_bindgen]
pub fn git_object_decode(bytes: &[u8], options_json: &str) -> String {
    guard(bytes, options_json, loose::decode)
}

/// Summarize a packfile: version, declared vs parsed object count, per-entry
/// `{type, offset, size}` list (bounded by `maxItems`), delta-chain counts and
/// max depth, and trailing SHA-1 verification.
#[wasm_bindgen]
pub fn git_pack_inspect(bytes: &[u8], options_json: &str) -> String {
    guard(bytes, options_json, pack::inspect)
}

/// Resolve one pack entry selected by `{index}` or `{offset}`, following
/// ofs-delta/ref-delta chains (depth <= 64, result <= 128 MiB). Returns JSON
/// metadata plus a base64 content preview bounded by `maxPreviewBytes`
/// (<= 64 KiB). For the full object bytes use `git_pack_entry_raw`.
#[wasm_bindgen]
pub fn git_pack_entry(bytes: &[u8], options_json: &str) -> String {
    guard(bytes, options_json, pack::entry)
}

/// Resolve one pack entry like `git_pack_entry` but return the complete
/// object bytes as one bounded byte vector (<= 128 MiB). On failure the
/// promise rejects with the error code string (e.g. `"delta_depth_exceeded"`).
#[wasm_bindgen]
pub fn git_pack_entry_raw(bytes: &[u8], options_json: &str) -> Result<Vec<u8>, JsValue> {
    guard_raw(bytes, options_json, pack::entry_raw).map_err(JsValue::from_str)
}

/// Inspect a `DIRC` index (v2/v3/v4): version, declared vs parsed entry
/// counts, entries `{path, sha1, mode, stage, times, size}` (bounded by
/// `maxItems`), extension names+sizes, and trailer checksum verification.
#[wasm_bindgen]
pub fn git_index_inspect(bytes: &[u8], options_json: &str) -> String {
    guard(bytes, options_json, dirc::inspect)
}

fn finish(result: std::thread::Result<Result<Value, &'static str>>) -> String {
    let value = match result {
        Ok(Ok(value)) => value,
        Ok(Err(code)) => return error_json(code),
        Err(_) => return error_json("internal_error"),
    };
    match serde_json::to_string(&value) {
        Ok(output) if output.len() <= MAX_OUTPUT_BYTES => output,
        Ok(_) => error_json("output_too_large"),
        Err(_) => error_json("serialization_error"),
    }
}

/// Common pre-allocation limits and error-JSON convention for JSON ops.
fn guard<O, F>(bytes: &[u8], options_json: &str, op: F) -> String
where
    O: DeserializeOwned,
    F: FnOnce(&[u8], &O, &mut Report) -> Result<Value, &'static str>,
{
    if options_json.len() > MAX_OPTIONS_BYTES {
        return error_json("options_too_large");
    }
    if bytes.is_empty() {
        return error_json("empty_input");
    }
    if bytes.len() > MAX_INPUT_BYTES {
        return error_json("input_too_large");
    }
    let options = match serde_json::from_str::<O>(options_json) {
        Ok(options) => options,
        Err(_) => return error_json("invalid_options"),
    };
    let mut report = Report::new();
    finish(catch_unwind(AssertUnwindSafe(|| {
        op(bytes, &options, &mut report)
    })))
}

/// Same limits for the byte-vector op; errors reject with the code string.
fn guard_raw<O, F>(
    bytes: &[u8],
    options_json: &str,
    op: F,
) -> Result<Vec<u8>, &'static str>
where
    O: DeserializeOwned,
    F: FnOnce(&[u8], &O, &mut Report) -> Result<Vec<u8>, &'static str>,
{
    if options_json.len() > MAX_OPTIONS_BYTES {
        return Err("options_too_large");
    }
    if bytes.is_empty() {
        return Err("empty_input");
    }
    if bytes.len() > MAX_INPUT_BYTES {
        return Err("input_too_large");
    }
    let options = serde_json::from_str::<O>(options_json).map_err(|_| "invalid_options")?;
    let mut report = Report::new();
    match catch_unwind(AssertUnwindSafe(|| op(bytes, &options, &mut report))) {
        Ok(result) => result,
        Err(_) => Err("internal_error"),
    }
}

pub(crate) fn error_json(code: &str) -> String {
    json!({ "schema_version": 1, "error": code }).to_string()
}

pub(crate) fn u32_be(bytes: &[u8], offset: usize) -> u32 {
    u32::from_be_bytes([bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]])
}

pub(crate) fn u16_be(bytes: &[u8], offset: usize) -> u16 {
    u16::from_be_bytes([bytes[offset], bytes[offset + 1]])
}

pub(crate) fn sha1_bytes(data: &[u8]) -> [u8; 20] {
    use sha1::Digest;
    let digest = sha1::Sha1::digest(data);
    let mut out = [0u8; 20];
    out.copy_from_slice(&digest);
    out
}

/// A git object id: SHA-1 over `"<type> <size>\0" + content`.
pub(crate) fn sha1_bytes_prefixed(kind: &str, content: &[u8]) -> [u8; 20] {
    use sha1::Digest;
    let mut hasher = sha1::Sha1::new();
    hasher.update(kind.as_bytes());
    hasher.update(b" ");
    hasher.update(content.len().to_string().as_bytes());
    hasher.update(b"\0");
    hasher.update(content);
    let digest = hasher.finalize();
    let mut out = [0u8; 20];
    out.copy_from_slice(&digest);
    out
}

pub(crate) fn sha256_hex(data: &[u8]) -> String {
    use sha2::Digest;
    hex_encode(&sha2::Sha256::digest(data))
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

pub(crate) fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        let chars = [
            ALPHABET[(n >> 18) as usize & 63] as char,
            ALPHABET[(n >> 12) as usize & 63] as char,
            if chunk.len() > 1 {
                ALPHABET[(n >> 6) as usize & 63] as char
            } else {
                '='
            },
            if chunk.len() > 2 {
                ALPHABET[n as usize & 63] as char
            } else {
                '='
            },
        ];
        out.extend(chars);
    }
    out
}
