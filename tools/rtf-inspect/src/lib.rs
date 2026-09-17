#![forbid(unsafe_code)]

//! Bounded, offline Rich Text Format inspection for TurenOS
//! document-malware triage. A hand-rolled single-pass scanner tokenizes RTF
//! groups, control words/symbols, `\'hh` escapes, `\binN` binary runs, and
//! `\uN` Unicode characters, then reports document structure, embedded OLE
//! objects, security findings, and extracted body text. The module never
//! executes embedded content, never follows references, and has no network,
//! filesystem, or process access.
//!
//! ABI: `op(input_bytes, options_json) -> JSON string`. Success reports carry
//! `"schema_version": 1`; failures are returned (not thrown) as
//! `{"schema_version":1,"error":"<code>","message":"..."}`.

mod audit;
mod inspect;
mod objects;
mod rtf;
mod text;

#[cfg(test)]
mod tests;

use serde::de::DeserializeOwned;
use serde_json::json;
use wasm_bindgen::prelude::*;

/// Hard input bound enforced before any parsing or allocation. RTF is a
/// text format; legitimate documents are far below this ceiling, so the
/// module deliberately narrows the 32 MiB house default to 16 MiB.
pub(crate) const MAX_INPUT_BYTES: usize = 16 * 1024 * 1024;
/// Hard bound on the JSON options string.
pub(crate) const MAX_OPTIONS_BYTES: usize = 4 * 1024;
/// Hard bound on serialized JSON output, checked after bounded collection.
pub(crate) const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
/// Hard bound on result rows, findings, and collected lists.
pub(crate) const MAX_RESULTS: usize = 4096;
/// Bound on a single reported string (names, previews, detail fields).
pub(crate) const MAX_STRING_CHARS: usize = 1024;
/// Bound on decoded payload returned inline by `rtf_objects` when
/// `include_payload_hex` is set.
pub(crate) const MAX_INLINE_PAYLOAD_BYTES: usize = 64 * 1024;

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

pub(crate) type OpResult = Result<serde_json::Value, Fail>;

pub(crate) fn error_json(code: &str) -> String {
    json!({ "schema_version": 1, "error": code }).to_string()
}

fn fail_json(fail: Fail) -> String {
    let mut object = serde_json::Map::new();
    object.insert("schema_version".to_string(), 1.into());
    object.insert("error".to_string(), fail.code.into());
    object.insert("message".to_string(), fail.code.into());
    object.extend(fail.extra);
    serde_json::Value::Object(object).to_string()
}

/// Parse the options JSON. An empty string means defaults; anything else
/// must be a valid JSON object. Size is checked by the dispatcher before
/// this runs.
fn parse_options<T: DeserializeOwned + Default>(options_json: &str) -> Result<T, Fail> {
    let trimmed = options_json.trim();
    if trimmed.is_empty() {
        return Ok(T::default());
    }
    // serde would accept a JSON array into a struct positionally; require an
    // object so callers cannot smuggle positional options.
    let value: serde_json::Value = serde_json::from_str(trimmed)
        .map_err(|_| Fail::new("invalid_options").with("message", "options is not valid JSON"))?;
    if !value.is_object() {
        return Err(Fail::new("invalid_options").with("message", "options must be a JSON object"));
    }
    serde_json::from_value(value)
        .map_err(|_| Fail::new("invalid_options").with("message", "options shape mismatch"))
}

/// Shared dispatcher: enforce input/options bounds before any allocation,
/// parse options, scan the document under `catch_unwind` so a scanner panic
/// on malformed input degrades to `internal_error` instead of trapping the
/// worker, run the operation, then bound serialized output.
fn dispatch<T, F>(bytes: &[u8], options_json: &str, op: F) -> String
where
    T: DeserializeOwned + Default,
    F: FnOnce(&rtf::Doc, &T, &[u8]) -> OpResult,
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
    let doc = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| rtf::scan(bytes))) {
        Ok(doc) => doc,
        Err(_) => return fail_json(Fail::new("internal_error")),
    };
    let value = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        op(&doc, &options, bytes)
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

/// Full structural report: group statistics, control-word histogram, font
/// table, style sheet, color table, {\info} metadata, {\*\generator}, picture
/// and OLE-object summaries, file-table entries, field instructions, counts,
/// a body-text preview, and the input digest.
///
/// Options: `top` (histogram rows, default 32, cap 256), `max_results`
/// (per-list cap, default 1024, hard cap 4096), `preview_chars` (text
/// preview, default 512, cap 4096).
#[wasm_bindgen]
pub fn rtf_inspect(bytes: &[u8], options_json: &str) -> String {
    dispatch::<inspect::InspectOptions, _>(bytes, options_json, inspect::run)
}

/// Enumerate embedded OLE objects: `{\object}` groups with `\objdata`
/// hex-decoded payloads — objclass, declared dimensions, decoded size,
/// SHA-256, first-16-bytes preview, OLE compound-magic detection, decode
/// errors, and `{\result}` rendering-data presence. Full payload hex is
/// returned only when the decoded payload is ≤ 64 KiB and
/// `include_payload_hex` is set.
///
/// Options: `max_results` (default 1024, cap 4096), `include_payload_hex`
/// (default false).
#[wasm_bindgen]
pub fn rtf_objects(bytes: &[u8], options_json: &str) -> String {
    dispatch::<objects::ObjectsOptions, _>(bytes, options_json, objects::run)
}

/// Security-focused finding list with byte offsets: objdata payloads, OLE
/// Package class names, data stores, file-table entries, template paths,
/// external field instructions, password markers, `\binN` binary blobs,
/// hex-heavy/fragmented obfuscation, nesting and brace anomalies, encoding
/// mixes, and Unicode anomalies.
///
/// Options: `max_findings` (default and cap 4096), `min_severity`
/// ("info"|"low"|"medium"|"high" — report findings at or above the level).
#[wasm_bindgen]
pub fn rtf_audit(bytes: &[u8], options_json: &str) -> String {
    dispatch::<audit::AuditOptions, _>(bytes, options_json, audit::run)
}

/// Bounded plain-text extraction: control words stripped, `\'hh` resolved
/// through the document code page, `\uN` resolved (with `\uc` fallback
/// skipping), and non-body destinations (font/color/style tables, info,
/// pictures, objects, `{\*\...}` ignorable groups, field instructions)
/// skipped.
///
/// Options: `max_chars` (default 262144, cap 524288).
#[wasm_bindgen]
pub fn rtf_text(bytes: &[u8], options_json: &str) -> String {
    dispatch::<text::TextOptions, _>(bytes, options_json, text::run)
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
