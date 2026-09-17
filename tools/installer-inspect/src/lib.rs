#![forbid(unsafe_code)]

//! Bounded Windows installer inspection for Turen agent tools.
//!
//! The module accepts installer bytes plus a small JSON options object and
//! returns either a bounded JSON report or one bounded byte vector:
//!
//! - `msi_inspect` inspects an OLE/CFB compound file as a Windows Installer
//!   package: CFB entry listing, decoded MSI database tables, embedded binary
//!   stream metadata (name, size, SHA-256), decoded CustomAction type flags,
//!   InstallExecuteSequence ordering, and triage findings.
//! - `msi_stream_read` returns one embedded stream's bytes as base64 inside a
//!   bounded JSON object (declared streams over 8 MiB are never read; the
//!   serialized content ceiling is ~3 MiB) so the caller can pull Binary-table
//!   payloads or embedded cabinets. `msi_inspect` already reports each
//!   stream's SHA-256.
//! - `cab_list` parses a Microsoft Cabinet (MSCF) header, folder, and file
//!   tables and reports per-file metadata including compression scheme,
//!   folder offset, and multi-cabinet continuation markers.
//! - `cab_extract` returns one decompressed member as base64 inside a bounded
//!   JSON object (declared members over 128 MiB are never decompressed; the
//!   serialized content ceiling is ~3 MiB). `none` and `mszip` folders are
//!   decoded through flate2/miniz_oxide and `lzx` folders through lzxd;
//!   Quantum always reports `unsupported_compression`.
//!
//! Expected errors are reported as a JSON object
//! `{"schema_version":1,"error":"<code>", ...}` carried as the `JsError`
//! message. Nothing is ever written to a filesystem, nothing is executed, and
//! all limits are enforced before unbounded allocation or serialization.

mod cab;
mod msi_inspect;

use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

/// Maximum input accepted by any operation.
pub(crate) const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
/// Maximum serialized options object accepted by any operation.
pub(crate) const MAX_OPTIONS_BYTES: usize = 4 * 1024;
/// Maximum JSON report produced by `msi_inspect` or `cab_list`.
pub(crate) const MAX_JSON_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
/// Maximum entries in any emitted list (CFB entries, streams, tables, files).
pub(crate) const MAX_LIST_ITEMS: usize = 4096;
/// Maximum rows decoded per MSI table.
pub(crate) const MAX_TABLE_ROWS: usize = 4096;
/// Maximum characters kept from any decoded string cell.
pub(crate) const MAX_STRING_CHARS: usize = 4096;
/// Maximum bytes `msi_stream_read` returns for one embedded stream.
pub(crate) const MAX_STREAM_READ_BYTES: usize = 8 * 1024 * 1024;
/// Maximum decompressed bytes `cab_extract` returns for one member.
pub(crate) const MAX_EXTRACT_BYTES: usize = 128 * 1024 * 1024;
/// Largest payload that survives base64 encoding inside the 4 MiB JSON
/// output cap. Responses carrying more decoded bytes than this cannot be
/// serialized, so a larger `maxBytes` preview still fails closed above it.
pub(crate) const MAX_CONTENT_BYTES: usize = (MAX_JSON_OUTPUT_BYTES - 1024) * 3 / 4;

/// `{"schema_version":1,"error":code, ...}` — the shared error envelope.
/// Internal functions return this string; the wasm boundary wraps it in
/// `JsError` so JavaScript receives the same JSON as the thrown message.
pub(crate) fn error_json(code: &str, extra: Value) -> String {
    let mut object = serde_json::Map::new();
    object.insert("schema_version".into(), json!(1));
    object.insert("error".into(), json!(code));
    if let Value::Object(fields) = extra {
        object.extend(fields);
    }
    Value::Object(object).to_string()
}

pub(crate) fn check_input(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(error_json(
            "input_too_large",
            json!({ "size": bytes.len(), "limit": MAX_INPUT_BYTES }),
        ));
    }
    Ok(())
}

pub(crate) fn parse_options(
    options_json: &str,
) -> Result<serde_json::Map<String, Value>, String> {
    if options_json.len() > MAX_OPTIONS_BYTES {
        return Err(error_json(
            "options_too_large",
            json!({ "size": options_json.len(), "limit": MAX_OPTIONS_BYTES }),
        ));
    }
    let trimmed = options_json.trim();
    if trimmed.is_empty() {
        return Ok(serde_json::Map::new());
    }
    let value: Value = serde_json::from_str(trimmed).map_err(|_| {
        error_json("invalid_options", json!({ "detail": "options is not valid JSON" }))
    })?;
    value.as_object().cloned().ok_or_else(|| {
        error_json("invalid_options", json!({ "detail": "options must be a JSON object" }))
    })
}

pub(crate) fn option_u64(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<u64>, String> {
    match object.get(key) {
        None => Ok(None),
        Some(value) => match value.as_u64() {
            Some(number) => Ok(Some(number)),
            None => Err(error_json(
                "invalid_options",
                json!({ "detail": format!("{key} must be a non-negative integer") }),
            )),
        },
    }
}

pub(crate) fn option_string(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<String>, String> {
    match object.get(key) {
        None => Ok(None),
        Some(value) => match value.as_str() {
            Some(text) => Ok(Some(text.to_string())),
            None => Err(error_json(
                "invalid_options",
                json!({ "detail": format!("{key} must be a string") }),
            )),
        },
    }
}

/// Serialize a report, enforcing the JSON output ceiling.
pub(crate) fn finish_json(report: Value) -> Result<String, String> {
    let text = report.to_string();
    if text.len() > MAX_JSON_OUTPUT_BYTES {
        return Err(error_json(
            "output_too_large",
            json!({ "size": text.len(), "limit": MAX_JSON_OUTPUT_BYTES }),
        ));
    }
    Ok(text)
}

/// Keep at most `MAX_STRING_CHARS` characters of a decoded string cell.
pub(crate) fn clean(value: &str) -> String {
    value.chars().take(MAX_STRING_CHARS).collect()
}

/// Inspect a Windows Installer (MSI) package: CFB container listing, decoded
/// database tables, embedded binary stream metadata, decoded CustomAction
/// types, sequence ordering, and triage findings.
///
/// Options: `maxRowsPerTable` (default and ceiling 4096), `maxTables`
/// (default and ceiling 4096), `tableFilter` (exact table-name match to
/// decode only selected tables; repeatable via array is not supported —
/// pass a single string).
#[wasm_bindgen]
pub fn msi_inspect(bytes: &[u8], options_json: &str) -> Result<String, JsError> {
    msi_inspect::inspect_impl(bytes, options_json).map_err(|message| JsError::new(&message))
}

/// Read one embedded stream from an MSI package (or a raw CFB stream path)
/// and return its bytes base64-encoded inside a bounded JSON object:
/// `{schema_version, stream, size, declaredSize, sha256, contentBase64,
/// truncated}`.
///
/// Options: `stream` (required) — a stream name as reported in the
/// `streams[].name` field of `msi_inspect`, or a raw CFB entry path such as
/// the `SummaryInformation` metadata stream (its name begins with a
/// U+0005 byte) as listed in `cfb.entries[].path`; `maxBytes`
/// (optional) requests a bounded preview of at most that many bytes, always
/// clamped to the ~3 MiB serialized-content ceiling. Streams declared larger
/// than 8 MiB are never read (`stream_too_large`).
#[wasm_bindgen]
pub fn msi_stream_read(bytes: &[u8], options_json: &str) -> Result<String, JsError> {
    msi_inspect::stream_read_impl(bytes, options_json).map_err(|message| JsError::new(&message))
}

/// List the contents of a Microsoft Cabinet (.cab): header fields, folders
/// with compression schemes, and file entries with sizes, offsets, and
/// continuation markers. Never writes to disk.
///
/// Options: `maxFiles` (default and ceiling 4096).
#[wasm_bindgen]
pub fn cab_list(bytes: &[u8], options_json: &str) -> Result<String, JsError> {
    cab::list_impl(bytes, options_json).map_err(|message| JsError::new(&message))
}

/// Decompress one member of a Microsoft Cabinet and return its bytes
/// base64-encoded inside a bounded JSON object: `{schema_version, file, size,
/// declaredSize, sha256, contentBase64, truncated, compression}`. Folders
/// using `none`, `mszip`, or `lzx` compression decode fully; `quantum`
/// reports `unsupported_compression`, as do files that span cabinet
/// boundaries.
///
/// Options: `file` (required, exact name from `cab_list`), `maxBytes`
/// (optional) requests a bounded preview of at most that many bytes, always
/// clamped to the ~3 MiB serialized-content ceiling. Members declaring more
/// than 128 MiB are never decompressed (`entry_too_large`).
#[wasm_bindgen]
pub fn cab_extract(bytes: &[u8], options_json: &str) -> Result<String, JsError> {
    cab::extract_impl(bytes, options_json).map_err(|message| JsError::new(&message))
}

#[cfg(test)]
mod tests;
