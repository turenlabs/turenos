#![forbid(unsafe_code)]

//! Bounded SquashFS listing and single-entry extraction for Turen agent tools.
//!
//! The module accepts image bytes plus a small JSON options object and returns
//! JSON reports. Expected errors are reported as a JSON object
//! `{"schema_version":1,"error":"<code>", ...}` carried as the `JsError`
//! message. Nothing is ever written to a filesystem: extraction returns one
//! entry's bytes as base64 inside the JSON report, and paths in the image are
//! never interpreted as host paths. Symlinks are reported, never followed.
//!
//! Supported input: SquashFS 4.0 little/big-endian (including the AVM mixed
//! endian variant) and SquashFS 3.x little/big-endian, with `uncompressed`,
//! `gzip`, and `lz4` data compression. Images compressed with xz, zstd, lzo,
//! or lzma (including the `v3_lzma`/`v4_lzma` vendor kinds such as `qshs` and
//! `shsq`) are detected but reported as unsupported: those backhand features
//! pull in C or GPL code that does not fit the pure-Rust/Apache-MIT closure of
//! this artifact.

mod image;
#[cfg(test)]
mod tests;

use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

/// Maximum input accepted by any operation.
pub(crate) const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
/// Maximum serialized options object accepted by any operation.
pub(crate) const MAX_OPTIONS_BYTES: usize = 4 * 1024;
/// Maximum JSON report produced by any operation.
pub(crate) const MAX_JSON_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
/// Maximum entries emitted by `squashfs_list`.
pub(crate) const MAX_ENTRIES: usize = 4096;
/// Hard ceiling for one extracted entry (declared size, bytes).
pub(crate) const MAX_ENTRY_BYTES: u64 = 128 * 1024 * 1024;
/// Largest extracted payload that survives base64 encoding inside the 4 MiB
/// JSON output cap. Responses carrying more decoded bytes than this cannot be
/// serialized, so extraction fails closed above it.
pub(crate) const MAX_CONTENT_BYTES: usize = (MAX_JSON_OUTPUT_BYTES - 1024) * 3 / 4;
/// Sanity bound on the superblock's inode count: the smallest on-disk inode is
/// ~16 bytes, so a 32 MiB image cannot hold more.
pub(crate) const MAX_INODES: u32 = 8 * 1024 * 1024;
/// Maximum byte length of a request or filter path.
pub(crate) const MAX_PATH_BYTES: usize = 4096;

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

fn check_input(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(error_json(
            "input_too_large",
            json!({ "size": bytes.len(), "limit": MAX_INPUT_BYTES }),
        ));
    }
    Ok(())
}

fn parse_options(options_json: &str) -> Result<serde_json::Map<String, Value>, String> {
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
        error_json(
            "invalid_options",
            json!({ "detail": "options is not valid JSON" }),
        )
    })?;
    value.as_object().cloned().ok_or_else(|| {
        error_json(
            "invalid_options",
            json!({ "detail": "options must be a JSON object" }),
        )
    })
}

fn option_u64(object: &serde_json::Map<String, Value>, key: &str) -> Result<Option<u64>, String> {
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

fn option_string(
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

fn serialize(report: &Value) -> Result<String, String> {
    let text = serde_json::to_string(report)
        .map_err(|error| error_json("internal", json!({ "detail": error.to_string() })))?;
    if text.len() > MAX_JSON_OUTPUT_BYTES {
        return Err(error_json(
            "output_too_large",
            json!({ "size": text.len(), "limit": MAX_JSON_OUTPUT_BYTES }),
        ));
    }
    Ok(text)
}

pub(crate) fn list_impl(bytes: &[u8], options_json: &str) -> Result<String, String> {
    check_input(bytes)?;
    let object = parse_options(options_json)?;
    let options = image::ListOptions {
        offset: option_u64(&object, "offset")?.unwrap_or(0),
        path_filter: option_string(&object, "pathFilter")?,
        max_results: option_u64(&object, "maxResults")?
            .map(|value| value.min(MAX_ENTRIES as u64) as usize),
    };
    let report = image::list(bytes, &options)?;
    serialize(&report)
}

pub(crate) fn extract_impl(bytes: &[u8], options_json: &str) -> Result<String, String> {
    check_input(bytes)?;
    let object = parse_options(options_json)?;
    let path = option_string(&object, "path")?
        .ok_or_else(|| error_json("invalid_options", json!({ "detail": "path is required" })))?;
    let options = image::ExtractOptions {
        offset: option_u64(&object, "offset")?.unwrap_or(0),
        path,
        max_bytes: option_u64(&object, "maxBytes")?,
    };
    let report = image::extract(bytes, &options)?;
    serialize(&report)
}

/// List a SquashFS image embedded in `bytes`.
///
/// Returns a JSON report with superblock metadata (`kind`, `version`,
/// `compression`, `blockSize`, inode/fragment counts, timestamps) and a
/// `entries` array of `{path, type, size, mode, uid, gid, mtime, linkTarget?,
/// deviceNumber?}` sorted by path. Entries are capped at 4096 (`truncated`
/// marks overflow). Options: `offset` (byte offset of the image inside
/// `bytes`, for firmware containers), `pathFilter` (directory-prefix filter),
/// `maxResults` (entry cap override).
#[wasm_bindgen]
pub fn squashfs_list(bytes: &[u8], options_json: &str) -> Result<String, JsError> {
    list_impl(bytes, options_json).map_err(|message| JsError::new(&message))
}

/// Extract exactly one regular file from a SquashFS image by exact normalized
/// path (leading `/`, no `.`/`..` resolution — parent components are rejected).
///
/// Returns a JSON report `{path, size, declaredSize, sha256, truncated,
/// contentBase64}`. Extraction never touches a filesystem: the entry is
/// decompressed into memory and returned as base64. `truncated` is true when
/// `maxBytes` clipped the entry. Options: `path` (required), `offset`,
/// `maxBytes` (preview limit; without it an entry whose decoded size does not
/// fit the JSON budget fails `entry_too_large`).
#[wasm_bindgen]
pub fn squashfs_extract(bytes: &[u8], options_json: &str) -> Result<String, JsError> {
    extract_impl(bytes, options_json).map_err(|message| JsError::new(&message))
}
