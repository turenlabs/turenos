#![forbid(unsafe_code)]

//! Bounded compression and encoding transforms for Turen agent tools.
//!
//! The module accepts input bytes plus a small JSON options object and returns
//! one bounded byte vector (or a JSON report for `detect`). Expected errors are
//! reported as a JSON object `{"schema_version":1,"error":"<code>"}`: returned
//! as the string value from `detect` and carried as the `JsError` message for
//! the byte-returning transforms. Nothing here panics on untrusted input.

mod bounded;
mod codec;
mod detect;
mod encoding;

use serde_json::json;
use wasm_bindgen::prelude::*;

/// Maximum input accepted by any operation.
pub(crate) const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
/// Maximum serialized options object accepted by any operation.
pub(crate) const MAX_OPTIONS_BYTES: usize = 4 * 1024;
/// Maximum JSON report produced by `detect`.
pub(crate) const MAX_JSON_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
/// Maximum bytes one transform may produce.
pub(crate) const MAX_TRANSFORM_BYTES: usize = 128 * 1024 * 1024;
/// Dictionary/history bound for LZMA-alone decompression.
pub(crate) const MAX_LZMA_DICT_BYTES: usize = 64 * 1024 * 1024;
/// Maximum zstd window size accepted by the decoder.
pub(crate) const MAX_ZSTD_WINDOW_BYTES: u64 = 64 * 1024 * 1024;

/// Shared options recognized by the transform operations.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Options {
    /// Hard cap on produced bytes; clamped to `MAX_TRANSFORM_BYTES`.
    pub max_output_bytes: usize,
    /// Caller-provided size hint used only to pre-reserve output space.
    pub expected_output_bytes: usize,
    /// Compression level; interpreted per algorithm and clamped.
    pub level: Option<u32>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            max_output_bytes: MAX_TRANSFORM_BYTES,
            expected_output_bytes: 0,
            level: None,
        }
    }
}

/// `{"schema_version":1,"error":code, ...}` — the shared error envelope.
/// Internal functions return this string; the wasm boundary wraps it in
/// `JsError` so JavaScript receives the same JSON as the thrown message.
pub(crate) fn error_json(code: &str, extra: serde_json::Value) -> String {
    let mut object = serde_json::Map::new();
    object.insert("schema_version".into(), json!(1));
    object.insert("error".into(), json!(code));
    if let serde_json::Value::Object(fields) = extra {
        object.extend(fields);
    }
    serde_json::Value::Object(object).to_string()
}

pub(crate) fn err_with(code: &str, extra: serde_json::Value) -> String {
    error_json(code, extra)
}

fn check_input(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(err_with(
            "input_too_large",
            json!({ "size": bytes.len(), "limit": MAX_INPUT_BYTES }),
        ));
    }
    Ok(())
}

fn option_u64(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<Option<u64>, String> {
    match object.get(key) {
        None => Ok(None),
        Some(value) => match value.as_u64() {
            Some(number) => Ok(Some(number)),
            None => Err(err_with(
                "invalid_options",
                json!({ "detail": format!("{key} must be a non-negative integer") }),
            )),
        },
    }
}

pub(crate) fn parse_options(options_json: &str) -> Result<Options, String> {
    if options_json.len() > MAX_OPTIONS_BYTES {
        return Err(err_with(
            "options_too_large",
            json!({ "size": options_json.len(), "limit": MAX_OPTIONS_BYTES }),
        ));
    }
    let mut options = Options::default();
    let trimmed = options_json.trim();
    if trimmed.is_empty() {
        return Ok(options);
    }
    let value: serde_json::Value = serde_json::from_str(trimmed).map_err(|_| {
        err_with("invalid_options", json!({ "detail": "options is not valid JSON" }))
    })?;
    let object = value.as_object().ok_or_else(|| {
        err_with("invalid_options", json!({ "detail": "options must be a JSON object" }))
    })?;
    if let Some(value) = option_u64(object, "maxOutputBytes")? {
        options.max_output_bytes = value.clamp(1, MAX_TRANSFORM_BYTES as u64) as usize;
    }
    if let Some(value) = option_u64(object, "expectedOutputBytes")? {
        options.expected_output_bytes = value.min(MAX_TRANSFORM_BYTES as u64) as usize;
    }
    if let Some(value) = option_u64(object, "level")? {
        options.level = Some(value.min(u32::MAX as u64) as u32);
    }
    options.expected_output_bytes = options.expected_output_bytes.min(options.max_output_bytes);
    Ok(options)
}

pub(crate) fn decompress_impl(
    algorithm: &str,
    bytes: &[u8],
    options_json: &str,
) -> Result<Vec<u8>, String> {
    check_input(bytes)?;
    let options = parse_options(options_json)?;
    codec::decompress(algorithm, bytes, &options)
}

pub(crate) fn compress_impl(
    algorithm: &str,
    bytes: &[u8],
    options_json: &str,
) -> Result<Vec<u8>, String> {
    check_input(bytes)?;
    let options = parse_options(options_json)?;
    codec::compress(algorithm, bytes, &options)
}

pub(crate) fn encode_impl(
    encoding: &str,
    bytes: &[u8],
    options_json: &str,
) -> Result<Vec<u8>, String> {
    check_input(bytes)?;
    let options = parse_options(options_json)?;
    encoding::encode(encoding, bytes, &options)
}

pub(crate) fn decode_impl(
    encoding: &str,
    bytes: &[u8],
    options_json: &str,
) -> Result<Vec<u8>, String> {
    check_input(bytes)?;
    let options = parse_options(options_json)?;
    encoding::decode(encoding, bytes, &options)
}

/// Decompress `bytes` with `algorithm`, returning one bounded byte vector.
///
/// Algorithms: `gzip`, `zlib`, `deflate` (raw), `brotli`, `lz4` (frame),
/// `lz4-block` (size-prefixed), `bzip2`, `xz`, `lzma` (LZMA-Alone), `lzma2`,
/// `zstd`. Options: `maxOutputBytes` (default and ceiling 128 MiB),
/// `expectedOutputBytes` (allocation hint). Output exceeding the cap is a
/// hard `output_too_large` error; partial output is never returned.
#[wasm_bindgen]
pub fn decompress(
    algorithm: &str,
    bytes: &[u8],
    options_json: &str,
) -> Result<Vec<u8>, JsError> {
    decompress_impl(algorithm, bytes, options_json).map_err(|message| JsError::new(&message))
}

/// Compress `bytes` with `algorithm`, returning one bounded byte vector.
///
/// Algorithms: `gzip`, `zlib`, `deflate`, `brotli`, `lz4`, `lz4-block`, `xz`,
/// `lzma`, `lzma2`. `bzip2` and `zstd` are decode-only here and return
/// `unsupported`. Options: `level` (deflate 0-9 default 6, brotli 0-11
/// default 5; ignored elsewhere) and `maxOutputBytes`.
#[wasm_bindgen]
pub fn compress(algorithm: &str, bytes: &[u8], options_json: &str) -> Result<Vec<u8>, JsError> {
    compress_impl(algorithm, bytes, options_json).map_err(|message| JsError::new(&message))
}

/// Encode `bytes` to a text `encoding`, returned as UTF-8 bytes.
///
/// Encodings: `hex`, `base64`, `base64url`, `base32`, `base32hex`, `base58`,
/// `base58check`, `z85` (input length must be a multiple of 4),
/// `quoted-printable` (RFC 2045), `uuencode`.
#[wasm_bindgen]
pub fn encode(encoding: &str, bytes: &[u8], options_json: &str) -> Result<Vec<u8>, JsError> {
    encode_impl(encoding, bytes, options_json).map_err(|message| JsError::new(&message))
}

/// Decode text `encoding` bytes back to raw bytes.
///
/// Encodings match `encode`; `uudecode`/`uu` are accepted aliases for the
/// uuencode decoder, which locates a `begin`/`end` block inside the input.
/// Whitespace inside the payload is tolerated where the format allows it.
#[wasm_bindgen]
pub fn decode(encoding: &str, bytes: &[u8], options_json: &str) -> Result<Vec<u8>, JsError> {
    decode_impl(encoding, bytes, options_json).map_err(|message| JsError::new(&message))
}

/// Identify the likely compression format or text encoding of `bytes`.
///
/// Always returns a JSON string: on success a report with `schema_version`,
/// `inputBytes`, `primary` (best guess or null) and `candidates`
/// (`{kind, name, confidence, detail}`); on failure the shared error envelope.
#[wasm_bindgen]
pub fn detect(bytes: &[u8]) -> String {
    if bytes.len() > MAX_INPUT_BYTES {
        return error_json(
            "input_too_large",
            json!({ "size": bytes.len(), "limit": MAX_INPUT_BYTES }),
        );
    }
    let text = detect::detect(bytes).to_string();
    if text.len() > MAX_JSON_OUTPUT_BYTES {
        return error_json("output_too_large", json!({ "limit": MAX_JSON_OUTPUT_BYTES }));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn error_code(result: Result<Vec<u8>, String>) -> String {
        let message = result.expect_err("expected error");
        let parsed: serde_json::Value =
            serde_json::from_str(&message).expect("error message is JSON");
        parsed["error"].as_str().unwrap_or("").to_string()
    }

    #[test]
    fn input_limit_boundary() {
        let at_limit = vec![0x61u8; MAX_INPUT_BYTES];
        assert!(decompress_impl("gzip", &at_limit, "{}").is_err()); // not gzip, but accepted size
        let over_limit = vec![0x61u8; MAX_INPUT_BYTES + 1];
        assert_eq!(
            error_code(decompress_impl("gzip", &over_limit, "{}")),
            "input_too_large"
        );
        assert_eq!(
            error_code(encode_impl("hex", &over_limit, "{}")),
            "input_too_large"
        );
        assert_eq!(
            error_code(compress_impl("gzip", &over_limit, "{}")),
            "input_too_large"
        );
        assert_eq!(
            error_code(decode_impl("base64", &over_limit, "{}")),
            "input_too_large"
        );
    }

    #[test]
    fn options_limit_boundary() {
        let bytes = b"hello";
        let big_options = format!("{{\"pad\":\"{}\"}}", " ".repeat(MAX_OPTIONS_BYTES));
        assert_eq!(
            error_code(decompress_impl("gzip", bytes, &big_options)),
            "options_too_large"
        );
        let at_limit = format!("{{\"pad\":\"{}\"}}", " ".repeat(MAX_OPTIONS_BYTES - 10));
        assert!(encode_impl("hex", bytes, &at_limit).is_ok());
    }

    #[test]
    fn malformed_options() {
        let bytes = b"hello";
        for bad in [
            "{",
            "not json",
            "[1,2]",
            "\"x\"",
            "123",
            "null",
            "{\"level\":-1}",
            "{\"level\":\"x\"}",
            "{\"maxOutputBytes\":true}",
        ] {
            let result = encode_impl("hex", bytes, bad);
            assert_eq!(error_code(result), "invalid_options", "options {bad:?}");
        }
        assert!(encode_impl("hex", bytes, "{}").is_ok());
        assert!(encode_impl("hex", bytes, "").is_ok());
        assert!(encode_impl("hex", bytes, "   ").is_ok());
        // Unknown option keys are ignored for forward compatibility.
        assert!(encode_impl("hex", bytes, "{\"futureOption\":123}").is_ok());
    }

    #[test]
    fn unknown_names() {
        let bytes = b"hello";
        assert_eq!(
            error_code(decompress_impl("rar", bytes, "{}")),
            "unknown_algorithm"
        );
        assert_eq!(
            error_code(compress_impl("zip", bytes, "{}")),
            "unknown_algorithm"
        );
        assert_eq!(
            error_code(encode_impl("rot13", bytes, "{}")),
            "unknown_encoding"
        );
        assert_eq!(
            error_code(decode_impl("rot13", bytes, "{}")),
            "unknown_encoding"
        );
    }

    #[test]
    fn detect_oversized_returns_json_error() {
        let over = vec![0u8; MAX_INPUT_BYTES + 1];
        let report: serde_json::Value = serde_json::from_str(&detect(&over)).unwrap();
        assert_eq!(report["schema_version"], 1);
        assert_eq!(report["error"], "input_too_large");
    }
}
