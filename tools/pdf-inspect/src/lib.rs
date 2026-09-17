//! Bounded, offline PDF structure inspection for TurenOS document-malware
//! triage. Parses PDF bytes with `lopdf` and reports document structure and
//! suspicious indicators. The module never executes JavaScript, never
//! dereferences external references, never renders, and has no network,
//! filesystem, or process access.

mod inspect;
mod objects;
mod stream;
mod text;

#[cfg(test)]
mod tests;

use lopdf::{Document, LoadOptions};
use serde::de::DeserializeOwned;
use wasm_bindgen::prelude::*;

/// Hard input bound enforced before any parsing or allocation.
pub(crate) const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
/// Hard bound on the JSON options string.
pub(crate) const MAX_OPTIONS_BYTES: usize = 4 * 1024;
/// Hard bound on serialized JSON output, checked after bounded collection.
pub(crate) const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
/// Hard bound on result rows, findings, and collected lists.
pub(crate) const MAX_RESULTS: usize = 4096;
/// Maximum decoded size of a single stream returned by `pdf_stream_decode`.
pub(crate) const MAX_STREAM_DECODE_BYTES: usize = 8 * 1024 * 1024;
/// Per-stream decompression bound applied while lopdf eagerly decodes object
/// and cross-reference streams during document load (decompression-bomb guard).
pub(crate) const MAX_LOAD_STREAM_BYTES: usize = 16 * 1024 * 1024;
/// Per-page decompressed content bound used by `pdf_text`.
pub(crate) const MAX_PAGE_CONTENT_BYTES: usize = 8 * 1024 * 1024;
/// Maximum characters returned by `pdf_text` (bounded below the JSON cap so
/// escaping can never push a serialized report past `MAX_OUTPUT_BYTES`).
pub(crate) const MAX_TEXT_CHARS: usize = 512 * 1024;
pub(crate) const DEFAULT_MAX_TEXT_CHARS: usize = 256 * 1024;
pub(crate) const DEFAULT_MAX_PAGES: usize = 1024;
pub(crate) const MAX_PAGES: usize = 4096;
/// Bound on URLs reported across one document.
pub(crate) const MAX_URLS: usize = 256;
/// Bound on a single reported URL or metadata string.
pub(crate) const MAX_STRING_CHARS: usize = 1024;
/// Bound on dictionary key listings (catalog keys, trailer keys, object keys).
pub(crate) const MAX_KEY_LIST: usize = 256;
pub(crate) const MAX_SUSPICIOUS_KEYS_PER_OBJECT: usize = 64;
pub(crate) const MAX_WARNINGS: usize = 64;
/// Depth and node budget for the bounded dictionary scan inside one object.
pub(crate) const MAX_SCAN_DEPTH: usize = 16;
pub(crate) const MAX_SCAN_NODES: usize = 8192;

/// Failure carrying a stable machine-readable code plus optional detail fields
/// merged into the error JSON object.
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

pub(crate) type OpResult = Result<serde_json::Value, Fail>;

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

/// Parse the options JSON. An empty string means defaults; anything else must
/// be a valid JSON object. Size is checked by the dispatcher before this runs.
fn parse_options<T: DeserializeOwned + Default>(options_json: &str) -> Result<T, Fail> {
    let trimmed = options_json.trim();
    if trimmed.is_empty() {
        return Ok(T::default());
    }
    // serde would accept a JSON array into a struct positionally; require an
    // object so callers cannot smuggle positional options.
    let value: serde_json::Value =
        serde_json::from_str(trimmed).map_err(|_| Fail::new("invalid_options"))?;
    if !value.is_object() {
        return Err(Fail::new("invalid_options"));
    }
    serde_json::from_value(value).map_err(|_| Fail::new("invalid_options"))
}

/// Load a PDF with lopdf's lenient reader and a per-stream decompression cap.
/// Malformed objects and broken object streams are skipped by the reader; only
/// structural failures produce `invalid_pdf`. The module never supplies a
/// password, so a document whose contents need one keeps its `/Encrypt`
/// trailer entry and reports `encrypted` without decrypting anything.
pub(crate) fn load_document(bytes: &[u8]) -> Result<Document, Fail> {
    let options = LoadOptions {
        max_decompressed_size: Some(MAX_LOAD_STREAM_BYTES),
        ..LoadOptions::default()
    };
    Document::load_mem_with_options(bytes, options).map_err(|error| {
        Fail::new("invalid_pdf").with(
            "detail",
            clean(&error.to_string(), MAX_STRING_CHARS),
        )
    })
}

/// Shared dispatcher: enforce input/options bounds before any allocation,
/// parse options, load the document under `catch_unwind` so a parser panic on
/// malformed input degrades to `invalid_pdf`/`internal_error` instead of
/// trapping the worker, run the operation, then bound serialized output.
fn dispatch<T, F>(bytes: &[u8], options_json: &str, op: F) -> String
where
    T: DeserializeOwned + Default,
    F: FnOnce(&Document, &T, &[u8]) -> OpResult,
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
    let document = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        load_document(bytes)
    })) {
        Ok(Ok(document)) => document,
        Ok(Err(fail)) => return fail_json(fail),
        Err(_) => return fail_json(Fail::new("invalid_pdf")),
    };
    let value = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        op(&document, &options, bytes)
    })) {
        Ok(Ok(value)) => value,
        Ok(Err(fail)) => return fail_json(fail),
        Err(_) => return fail_json(Fail::new("internal_error")),
    };
    // `bytes` reaches ops for metadata (input digest); ops must never copy it.
    match serde_json::to_string(&value) {
        Ok(json) if json.len() <= MAX_OUTPUT_BYTES => json,
        Ok(_) => error_json("output_too_large"),
        Err(_) => error_json("serialization_error"),
    }
}

/// Document summary and suspicious-indicator findings.
///
/// Options: `max_findings` (default `MAX_RESULTS`, cap `MAX_RESULTS`),
/// `max_urls` (default `MAX_URLS`, cap `MAX_URLS`).
#[wasm_bindgen]
pub fn pdf_inspect(bytes: &[u8], options_json: &str) -> String {
    dispatch::<inspect::InspectOptions, _>(bytes, options_json, inspect::run)
}

/// Bounded object table.
///
/// Options: `object_id` + `generation` select one object, `type` filters by
/// `/Type` name, `kind` filters by object variant, `max_results` (default and
/// hard cap `MAX_RESULTS`).
#[wasm_bindgen]
pub fn pdf_objects(bytes: &[u8], options_json: &str) -> String {
    dispatch::<objects::ObjectsOptions, _>(bytes, options_json, objects::run)
}

/// Decode one stream object selected by `object_id`/`generation` and return the
/// decoded bytes as base64 inside JSON. Options: `max_output_bytes` (default
/// `MAX_STREAM_DECODE_BYTES`, cap `MAX_STREAM_DECODE_BYTES`). Undecodable
/// filter chains report `unsupported_filter` with the offending names; decoded
/// output that would exceed the option fails closed with
/// `decoded_stream_too_large`; payloads too large for the JSON output cap are
/// delivered truncated with `truncated: true` and `delivered_bytes`.
#[wasm_bindgen]
pub fn pdf_stream_decode(bytes: &[u8], options_json: &str) -> String {
    dispatch::<stream::StreamOptions, _>(bytes, options_json, stream::run)
}

/// Bounded text extraction.
///
/// Options: `start_page` (1-based, default 1), `max_pages` (default 1024, cap
/// 4096), `max_chars` (default 256 Ki, cap 512 Ki).
#[wasm_bindgen]
pub fn pdf_text(bytes: &[u8], options_json: &str) -> String {
    dispatch::<text::TextOptions, _>(bytes, options_json, text::run)
}

/// Lossy UTF-8 for a raw PDF name/key, capped for output.
pub(crate) fn name_string(bytes: &[u8]) -> String {
    clean(&String::from_utf8_lossy(bytes), MAX_STRING_CHARS)
}

/// Decode a PDF text string object (PDFDocEncoding or UTF-16BE via lopdf) and
/// cap it. Falls back to lossy UTF-8 for non-string objects.
pub(crate) fn text_string(object: &lopdf::Object) -> Option<String> {
    match lopdf::decode_text_string(object) {
        Ok(value) => Some(clean(&value, MAX_STRING_CHARS)),
        Err(_) => None,
    }
}

/// Truncate to `limit` bytes on a char boundary.
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

pub(crate) fn hex(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(TABLE[(byte >> 4) as usize] as char);
        output.push(TABLE[(byte & 15) as usize] as char);
    }
    output
}

/// Standard base64 (shared convention with tools/static-analysis).
pub(crate) fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::new();
    for chunk in bytes.chunks(3) {
        let a = chunk[0] as usize;
        let b = chunk.get(1).copied().unwrap_or(0) as usize;
        let c = chunk.get(2).copied().unwrap_or(0) as usize;
        output.push(TABLE[a >> 2] as char);
        output.push(TABLE[((a & 3) << 4) | (b >> 4)] as char);
        if chunk.len() > 1 {
            output.push(TABLE[((b & 15) << 2) | (c >> 6)] as char);
        } else {
            output.push('=');
        }
        if chunk.len() > 2 {
            output.push(TABLE[c & 63] as char);
        } else {
            output.push('=');
        }
    }
    output
}
