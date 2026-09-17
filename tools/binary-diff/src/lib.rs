#![forbid(unsafe_code)]

//! Bounded binary differencing and patching for Turen agent tools.
//!
//! # Two-input container convention
//!
//! Operations that need two byte buffers take ONE input document: the `input`
//! argument is a UTF-8 JSON object whose fields are canonical base64 strings:
//!
//! - `binary_compare`, `binary_regions`, `binary_diff`:
//!   `{"old": "<base64>", "new": "<base64>"}`
//! - `binary_patch`: `{"old": "<base64>", "patch": "<base64>"}`
//! - `binary_patch_info` is the exception: its `input` is the raw patch bytes.
//!
//! `binary_compare`, `binary_regions`, and `binary_patch_info` return a JSON
//! string. `binary_diff` and `binary_patch` return one bounded byte vector.
//! Expected failures are reported as `{"schema_version":1,"error":"<code>"}` —
//! as the returned string for JSON operations and as the `JsError` message for
//! the byte-returning operations. Nothing here panics on untrusted input.
//!
//! The diff engine is a bounded, single-threaded port of the bsdiff-style
//! partition scan from divvun/bidiff 1.0.0 (Apache-2.0 OR MIT) over a
//! `divsufsort`/`sacabase` suffix array; the rayon and `Instant::now()` paths
//! upstream uses do not exist here. Patches use the upstream `bipatch` wire
//! format (magic `0xB1DF`, version `0x1000`, varint-framed add/copy/seek
//! control records) and are applied by the `bipatch` crate.

mod bsdiff;
mod compare;
mod patch;

use serde_json::json;
use wasm_bindgen::prelude::*;

/// Maximum size of the JSON input document: two canonical-base64 fields of
/// `MAX_EMBEDDED_BYTES` each plus JSON overhead.
pub(crate) const MAX_INPUT_DOC_BYTES: usize = 92 * 1024 * 1024;
/// Maximum size of one decoded embedded buffer (`old`, `new`, or `patch`).
pub(crate) const MAX_EMBEDDED_BYTES: usize = 32 * 1024 * 1024;
/// Maximum base64 characters needed to encode `MAX_EMBEDDED_BYTES`.
pub(crate) const MAX_BASE64_FIELD_BYTES: usize = 4 * (MAX_EMBEDDED_BYTES / 3 + 1);
/// Maximum raw patch bytes accepted by `binary_patch_info`.
pub(crate) const MAX_PATCH_INFO_BYTES: usize = 32 * 1024 * 1024;
/// Maximum serialized options object accepted by any operation.
pub(crate) const MAX_OPTIONS_BYTES: usize = 4 * 1024;
/// Maximum JSON report produced by the JSON-returning operations.
pub(crate) const MAX_JSON_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
/// Maximum bytes `binary_diff` or `binary_patch` may produce.
pub(crate) const MAX_OUTPUT_BYTES: usize = 128 * 1024 * 1024;
/// Maximum changed regions reported by `binary_compare`/`binary_regions`.
pub(crate) const MAX_REGIONS: usize = 4096;
/// Anchor block size for the rolling-hash matcher in `binary_regions`.
pub(crate) const REGION_BLOCK_SIZE: usize = 64;
/// Bytes of region content included as a hex preview.
pub(crate) const MAX_PREVIEW_BYTES: usize = 32;

/// Shared per-call options parsed from `options_json`.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Options {
    /// Hard cap on produced bytes; clamped to `MAX_OUTPUT_BYTES`.
    pub max_output_bytes: usize,
    /// Cap on collected changed regions; clamped to `MAX_REGIONS`.
    pub max_regions: usize,
    /// Optional expected SHA-256 of the `binary_patch` result, verified after
    /// apply. Mismatch is a hard `checksum_mismatch` error.
    pub expected_sha256: Option<[u8; 32]>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            max_output_bytes: MAX_OUTPUT_BYTES,
            max_regions: MAX_REGIONS,
            expected_sha256: None,
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

pub(crate) fn err(code: &str) -> String {
    error_json(code, json!({}))
}

pub(crate) fn err_with(code: &str, extra: serde_json::Value) -> String {
    error_json(code, extra)
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
        options.max_output_bytes = value.clamp(1, MAX_OUTPUT_BYTES as u64) as usize;
    }
    if let Some(value) = option_u64(object, "maxRegions")? {
        options.max_regions = value.clamp(1, MAX_REGIONS as u64) as usize;
    }
    if let Some(value) = object.get("expectedSha256") {
        let hex = value.as_str().ok_or_else(|| {
            err_with(
                "invalid_options",
                json!({ "detail": "expectedSha256 must be a hex string" }),
            )
        })?;
        options.expected_sha256 = Some(parse_sha256(hex)?);
    }
    Ok(options)
}

fn parse_sha256(hex: &str) -> Result<[u8; 32], String> {
    let bad = || {
        err_with(
            "invalid_options",
            json!({ "detail": "expectedSha256 must be 64 lowercase or uppercase hex characters" }),
        )
    };
    if hex.len() != 64 {
        return Err(bad());
    }
    let mut digest = [0u8; 32];
    for (index, pair) in hex.as_bytes().chunks_exact(2).enumerate() {
        let high = hex_value(pair[0]).ok_or_else(bad)?;
        let low = hex_value(pair[1]).ok_or_else(bad)?;
        digest[index] = (high << 4) | low;
    }
    Ok(digest)
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// A decoded pair of embedded buffers from the input document.
pub(crate) struct InputPair {
    pub old: Vec<u8>,
    pub second: Vec<u8>,
}

/// Parse the JSON input document and decode `first_field` (always `"old"`)
/// plus `second_field` (`"new"` or `"patch"`) as canonical base64. Decoded
/// size limits are enforced on the base64 length *before* allocation so an
/// oversized field never reaches the decoder.
pub(crate) fn parse_input_pair(
    input: &[u8],
    second_field: &'static str,
) -> Result<InputPair, String> {
    if input.len() > MAX_INPUT_DOC_BYTES {
        return Err(err_with(
            "input_too_large",
            json!({ "size": input.len(), "limit": MAX_INPUT_DOC_BYTES }),
        ));
    }
    let value: serde_json::Value = serde_json::from_slice(input).map_err(|_| {
        err_with(
            "invalid_input",
            json!({ "detail": "input must be a JSON document" }),
        )
    })?;
    let object = value.as_object().ok_or_else(|| {
        err_with(
            "invalid_input",
            json!({ "detail": "input document must be a JSON object" }),
        )
    })?;
    Ok(InputPair {
        old: decode_field(object, "old")?,
        second: decode_field(object, second_field)?,
    })
}

fn decode_field(
    object: &serde_json::Map<String, serde_json::Value>,
    field: &'static str,
) -> Result<Vec<u8>, String> {
    let value = object.get(field).ok_or_else(|| {
        err_with(
            "invalid_input",
            json!({ "detail": format!("missing field \"{field}\"") }),
        )
    })?;
    let encoded = value.as_str().ok_or_else(|| {
        err_with(
            "invalid_input",
            json!({ "detail": format!("field \"{field}\" must be a base64 string") }),
        )
    })?;
    if encoded.len() > MAX_BASE64_FIELD_BYTES {
        return Err(err_with(
            "input_too_large",
            json!({ "field": field, "encodedSize": encoded.len(), "limit": MAX_EMBEDDED_BYTES }),
        ));
    }
    let decoded = data_encoding::BASE64
        .decode(encoded.as_bytes())
        .map_err(|_| {
            err_with(
                "invalid_base64",
                json!({ "detail": format!("field \"{field}\" is not canonical base64") }),
            )
        })?;
    if decoded.len() > MAX_EMBEDDED_BYTES {
        return Err(err_with(
            "input_too_large",
            json!({ "field": field, "size": decoded.len(), "limit": MAX_EMBEDDED_BYTES }),
        ));
    }
    Ok(decoded)
}

pub(crate) fn serialize(value: &impl serde::Serialize) -> Result<String, String> {
    match serde_json::to_string(value) {
        Ok(json) if json.len() <= MAX_JSON_OUTPUT_BYTES => Ok(json),
        Ok(_) => Err(err("output_too_large")),
        Err(_) => Err(err("internal_error")),
    }
}

pub(crate) fn hex_string(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::new(), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    hex_string(&sha2::Sha256::digest(bytes))
}

fn json_result(result: Result<String, String>) -> String {
    match result {
        Ok(json) => json,
        Err(envelope) => envelope,
    }
}

fn bytes_result(result: Result<Vec<u8>, String>) -> Result<Vec<u8>, JsError> {
    result.map_err(|envelope| JsError::new(&envelope))
}

/// Structural comparison of the document's `old` and `new` buffers: identity,
/// sizes, common prefix/suffix, bounded changed-region list with per-region
/// entropy and byte-class hints, hashes, and a similarity score.
///
/// Input document: `{"old": "<base64>", "new": "<base64>"}`.
/// Options: `maxRegions` (default and ceiling 4096).
#[wasm_bindgen]
pub fn binary_compare(input: &[u8], options_json: &str) -> String {
    json_result((|| {
        let options = parse_options(options_json)?;
        let pair = parse_input_pair(input, "new")?;
        serialize(&compare::compare(&pair.old, &pair.second, options.max_regions))
    })())
}

/// Cheaper alignment-aware changed-region report. Equal-size buffers use an
/// exact aligned scan; different-size buffers use a rolling-hash anchor scan
/// that tolerates insertions and deletions.
///
/// Input document: `{"old": "<base64>", "new": "<base64>"}`.
/// Options: `maxRegions` (default and ceiling 4096).
#[wasm_bindgen]
pub fn binary_regions(input: &[u8], options_json: &str) -> String {
    json_result((|| {
        let options = parse_options(options_json)?;
        let pair = parse_input_pair(input, "new")?;
        serialize(&compare::regions(&pair.old, &pair.second, options.max_regions))
    })())
}

/// Describe a `bipatch`-format patch: header fields, control-record count,
/// payload totals, implied output size, and old-buffer span touched.
///
/// Input is the raw patch bytes (no JSON document). Options: none.
#[wasm_bindgen]
pub fn binary_patch_info(input: &[u8], options_json: &str) -> String {
    json_result((|| {
        let _ = parse_options(options_json)?;
        if input.len() > MAX_PATCH_INFO_BYTES {
            return Err(err_with(
                "input_too_large",
                json!({ "size": input.len(), "limit": MAX_PATCH_INFO_BYTES }),
            ));
        }
        serialize(&patch::patch_info(input))
    })())
}

pub(crate) fn binary_diff_impl(input: &[u8], options_json: &str) -> Result<Vec<u8>, String> {
    let options = parse_options(options_json)?;
    let pair = parse_input_pair(input, "new")?;
    bsdiff::diff(&pair.old, &pair.second, options.max_output_bytes)
}

/// Produce a `bipatch`-format patch that transforms `old` into `new`.
///
/// Input document: `{"old": "<base64>", "new": "<base64>"}`.
/// Options: `maxOutputBytes` (default and ceiling 128 MiB).
/// Returns the patch bytes; errors throw the shared JSON error envelope.
#[wasm_bindgen]
pub fn binary_diff(input: &[u8], options_json: &str) -> Result<Vec<u8>, JsError> {
    bytes_result(binary_diff_impl(input, options_json))
}

pub(crate) fn binary_patch_impl(input: &[u8], options_json: &str) -> Result<Vec<u8>, String> {
    let options = parse_options(options_json)?;
    let pair = parse_input_pair(input, "patch")?;
    let output = patch::apply(&pair.old, &pair.second, options.max_output_bytes)?;
    if let Some(expected) = options.expected_sha256 {
        use sha2::Digest;
        let actual: [u8; 32] = sha2::Sha256::digest(&output).into();
        if actual != expected {
            return Err(err_with(
                "checksum_mismatch",
                json!({ "expected": hex_string(&expected), "actual": hex_string(&actual) }),
            ));
        }
    }
    Ok(output)
}

/// Apply a `bipatch`-format patch to `old`, returning the new bytes.
///
/// Input document: `{"old": "<base64>", "patch": "<base64>"}`.
/// Options: `maxOutputBytes` (default and ceiling 128 MiB) and
/// `expectedSha256` (64-hex digest verified against the patched output —
/// `bipatch` patches carry no checksum of their own).
#[wasm_bindgen]
pub fn binary_patch(input: &[u8], options_json: &str) -> Result<Vec<u8>, JsError> {
    bytes_result(binary_patch_impl(input, options_json))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// Deterministic xorshift64* byte source; no `rand` dependency.
    struct Prng(u64);

    impl Prng {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            self.0 = x;
            x.wrapping_mul(0x2545F4914F6CDD1D)
        }

        fn bytes(&mut self, n: usize) -> Vec<u8> {
            (0..n).map(|_| (self.next() >> 32) as u8).collect()
        }
    }

    fn b64(bytes: &[u8]) -> String {
        data_encoding::BASE64.encode(bytes)
    }

    fn pair_doc(old: &[u8], new: &[u8]) -> Vec<u8> {
        serde_json::to_vec(&json!({ "old": b64(old), "new": b64(new) })).unwrap()
    }

    fn patch_doc(old: &[u8], patch: &[u8]) -> Vec<u8> {
        serde_json::to_vec(&json!({ "old": b64(old), "patch": b64(patch) })).unwrap()
    }

    fn parse(output: String) -> Value {
        serde_json::from_str(&output).expect("output must be JSON")
    }

    fn diff_bytes(old: &[u8], new: &[u8]) -> Vec<u8> {
        binary_diff_impl(&pair_doc(old, new), "{}").expect("diff must succeed")
    }

    fn patch_bytes(old: &[u8], patch: &[u8], options: &str) -> Result<Vec<u8>, String> {
        binary_patch_impl(&patch_doc(old, patch), options)
    }

    fn patch_ok(old: &[u8], patch: &[u8]) -> Vec<u8> {
        patch_bytes(old, patch, "{}").expect("patch must apply")
    }

    fn patch_error(old: &[u8], patch: &[u8]) -> String {
        let envelope = patch_bytes(old, patch, "{}").expect_err("patch must fail");
        parse(envelope)["error"].as_str().unwrap().to_string()
    }

    // ---- binary_compare ---------------------------------------------------

    #[test]
    fn compare_identical() {
        let data = Prng(7).bytes(4096);
        let result = parse(binary_compare(&pair_doc(&data, &data), "{}"));
        assert_eq!(result["schema_version"], 1);
        assert_eq!(result["identical"], true);
        assert_eq!(result["old_size"], 4096);
        assert_eq!(result["new_size"], 4096);
        assert_eq!(result["size_delta"], 0);
        assert_eq!(result["common_prefix"], 4096);
        assert_eq!(result["common_suffix"], 0);
        assert_eq!(result["matched_bytes"], 4096);
        assert_eq!(result["matching_ratio"], 1.0);
        assert_eq!(result["similarity_score"], 100);
        assert_eq!(result["region_count"], 0);
        assert_eq!(result["regions"], json!([]));
        assert_eq!(
            result["sha256_old"].as_str().unwrap(),
            result["sha256_new"].as_str().unwrap()
        );
        assert_eq!(result["truncated"], false);
    }

    #[test]
    fn compare_single_byte_change() {
        let mut old = b"the quick brown fox jumps over the lazy dog".to_vec();
        old.extend(Prng(11).bytes(200));
        let mut new = old.clone();
        new[10] = b'X';
        let result = parse(binary_compare(&pair_doc(&old, &new), "{}"));
        assert_eq!(result["identical"], false);
        assert_eq!(result["common_prefix"], 10);
        assert_eq!(result["common_suffix"], old.len() - 11);
        assert_eq!(result["region_count"], 1);
        let region = &result["regions"][0];
        assert_eq!(region["offset"], 10);
        assert_eq!(region["old_offset"], 10);
        assert_eq!(region["old_len"], 1);
        assert_eq!(region["new_len"], 1);
        assert_eq!(region["preview"], "58"); // "X"
        assert_eq!(result["matched_bytes"], old.len() - 1);
        assert!(result["matching_ratio"].as_f64().unwrap() > 0.99);
        assert_eq!(result["similarity_score"], 100);
    }

    #[test]
    fn compare_inserted_block() {
        let old = Prng(5).bytes(1024);
        let mut new = old[..400].to_vec();
        new.extend(Prng(9).bytes(128));
        new.extend(&old[400..]);
        let result = parse(binary_compare(&pair_doc(&old, &new), "{}"));
        assert_eq!(result["identical"], false);
        assert_eq!(result["size_delta"], 128);
        assert_eq!(result["common_prefix"], 400);
        assert_eq!(result["common_suffix"], 624);
        assert_eq!(result["region_count"], 1);
        let region = &result["regions"][0];
        assert_eq!(region["offset"], 400);
        assert_eq!(region["old_len"], 0);
        assert_eq!(region["new_len"], 128);
        assert_eq!(region["preview"].as_str().unwrap().len(), 64); // 32B hex
        // Inserted high-entropy bytes: entropy shift and class hint present.
        assert!(region["new_entropy"].as_f64().unwrap() > 6.0);
        assert_eq!(region["old_class"], "empty");
    }

    #[test]
    fn compare_deleted_block() {
        let old = Prng(5).bytes(1024);
        let mut new = old[..200].to_vec();
        new.extend(&old[456..]);
        let result = parse(binary_compare(&pair_doc(&old, &new), "{}"));
        assert_eq!(result["size_delta"], -256);
        assert_eq!(result["region_count"], 1);
        let region = &result["regions"][0];
        assert_eq!(region["offset"], 200);
        assert_eq!(region["old_len"], 256);
        assert_eq!(region["new_len"], 0);
        // Deletion previews the removed old-side bytes.
        assert_eq!(
            region["preview"].as_str().unwrap(),
            hex_string(&old[200..232])
        );
        assert!(region["old_entropy"].as_f64().unwrap() > 6.0);
        assert_eq!(region["new_class"], "empty");
    }

    #[test]
    fn compare_scattered_changes() {
        let old = Prng(3).bytes(2048);
        let mut new = old.clone();
        for offset in [17usize, 500, 501, 900, 1500, 2000] {
            new[offset] ^= 0xff;
        }
        let result = parse(binary_compare(&pair_doc(&old, &new), "{}"));
        // 500-501 merge into one run; five regions total.
        assert_eq!(result["region_count"], 5);
        let offsets: Vec<u64> = result["regions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|region| region["offset"].as_u64().unwrap())
            .collect();
        assert_eq!(offsets, vec![17, 500, 900, 1500, 2000]);
        assert_eq!(result["matched_bytes"], 2048 - 6);
        assert!(result["similarity_score"].as_u64().unwrap() >= 99);
    }

    #[test]
    fn compare_empty_and_asymmetric() {
        let result = parse(binary_compare(&pair_doc(b"", b""), "{}"));
        assert_eq!(result["identical"], true);
        assert_eq!(result["matching_ratio"], 1.0);

        let result = parse(binary_compare(&pair_doc(b"", b"abc"), "{}"));
        assert_eq!(result["identical"], false);
        assert_eq!(result["size_delta"], 3);
        assert_eq!(result["region_count"], 1);
        assert_eq!(result["regions"][0]["old_len"], 0);
        assert_eq!(result["regions"][0]["new_len"], 3);
        assert_eq!(result["matching_ratio"], 0.0);
        assert_eq!(result["similarity_score"], 0);
    }

    #[test]
    fn compare_byte_class_shift_hint() {
        // ASCII text replaced by high-entropy bytes at a known offset.
        let mut old = Vec::new();
        old.extend(b"firmware configuration block padding ".as_slice());
        old.extend(b"A".repeat(64));
        old.extend(b"trailing structure here".as_slice());
        let mut new = old.clone();
        let crypto = Prng(42).bytes(64);
        new[37..37 + 64].copy_from_slice(&crypto);
        let result = parse(binary_compare(&pair_doc(&old, &new), "{}"));
        assert_eq!(result["region_count"], 1);
        let region = &result["regions"][0];
        assert_eq!(region["old_class"], "ascii");
        assert_eq!(region["new_class"], "high");
        assert!(region["new_entropy"].as_f64().unwrap() > region["old_entropy"].as_f64().unwrap());
    }

    // ---- binary_regions ---------------------------------------------------

    #[test]
    fn regions_equal_size_aligned_scan() {
        let old = Prng(13).bytes(2048);
        let mut new = old.clone();
        new[100] ^= 1;
        new[1000] ^= 1;
        let result = parse(binary_regions(&pair_doc(&old, &new), "{}"));
        assert_eq!(result["method"], "aligned-scan");
        assert_eq!(result["region_count"], 2);
        assert_eq!(result["regions"][0]["offset"], 100);
        assert_eq!(result["regions"][1]["offset"], 1000);
        assert_eq!(result["matched_bytes"], 2046);
    }

    #[test]
    fn regions_rolling_hash_tracks_insertion() {
        // Insertion inside high-entropy content: anchors before and after the
        // insert keep the region tight around the inserted bytes.
        let old = Prng(21).bytes(4096);
        let insert = Prng(22).bytes(96);
        let mut new = old[..1024].to_vec();
        new.extend(&insert);
        new.extend(&old[1024..]);
        let result = parse(binary_regions(&pair_doc(&old, &new), "{}"));
        assert_eq!(result["method"], "rolling-hash");
        assert!(result["anchor_count"].as_u64().unwrap() >= 1);
        let regions = result["regions"].as_array().unwrap();
        // The changed span is exactly the inserted block.
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0]["offset"], 1024);
        assert_eq!(regions[0]["new_len"], 96);
        assert_eq!(regions[0]["old_len"], 0);
        assert_eq!(
            regions[0]["preview"].as_str().unwrap(),
            hex_string(&insert[..32])
        );
        assert_eq!(result["matched_bytes"], old.len());
        assert_eq!(result["matching_ratio"], 0.9771); // 4096/4192 rounded
    }

    #[test]
    fn regions_rolling_hash_unaligned_insertion() {
        // Insert at an offset that is not a multiple of the 64-byte anchor
        // grid: the first anchor after the insert extends left over the
        // matching prefix. Regression: the match's old-side end must stay at
        // the anchor end, or a phantom trailing region appears.
        let old = Prng(7).bytes(8192);
        let insert = Prng(9).bytes(300);
        let mut new = old[..1000].to_vec();
        new.extend(&insert);
        new.extend(&old[1000..]);
        let result = parse(binary_regions(&pair_doc(&old, &new), "{}"));
        assert_eq!(result["method"], "rolling-hash");
        let regions = result["regions"].as_array().unwrap();
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0]["offset"], 1000);
        assert_eq!(regions[0]["old_len"], 0);
        assert_eq!(regions[0]["new_len"], 300);
        assert_eq!(result["matched_bytes"], old.len());
    }

    #[test]
    fn regions_rolling_hash_unaligned_deletion() {
        // Same for a deletion whose boundary sits mid-block.
        let old = Prng(23).bytes(6000);
        let mut new = old[..777].to_vec();
        new.extend(&old[777 + 555..]);
        let result = parse(binary_regions(&pair_doc(&old, &new), "{}"));
        let regions = result["regions"].as_array().unwrap();
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0]["offset"], 777);
        assert_eq!(regions[0]["old_len"], 555);
        assert_eq!(regions[0]["new_len"], 0);
        assert_eq!(result["matched_bytes"], new.len());
    }

    #[test]
    fn regions_rolling_hash_tracks_deletion() {
        let old = Prng(31).bytes(4096);
        let mut new = old[..512].to_vec();
        new.extend(&old[512 + 256..]);
        let result = parse(binary_regions(&pair_doc(&old, &new), "{}"));
        assert_eq!(result["method"], "rolling-hash");
        let regions = result["regions"].as_array().unwrap();
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0]["offset"], 512);
        assert_eq!(regions[0]["old_len"], 256);
        assert_eq!(regions[0]["new_len"], 0);
    }

    #[test]
    fn regions_no_anchors_falls_back() {
        // Inputs too small for the 64-byte anchor grid report one middle span.
        let result = parse(binary_regions(&pair_doc(b"tiny", b"tiny!"), "{}"));
        assert_eq!(result["method"], "rolling-hash");
        assert_eq!(result["region_count"], 1);
        assert_eq!(result["regions"][0]["new_len"], 1);
        assert_eq!(result["regions"][0]["preview"], "21"); // "!"
    }

    #[test]
    fn regions_identical() {
        let data = Prng(8).bytes(512);
        let result = parse(binary_regions(&pair_doc(&data, &data), "{}"));
        assert_eq!(result["identical"], true);
        assert_eq!(result["region_count"], 0);
        assert_eq!(result["matching_ratio"], 1.0);
    }

    // ---- binary_diff / binary_patch round trips ----------------------------

    #[test]
    fn diff_patch_round_trip_cases() {
        let mut prng = Prng(0xC0FFEE);
        let base = prng.bytes(64 * 1024);
        let mut cases: Vec<(Vec<u8>, Vec<u8>)> = vec![
            (Vec::new(), Vec::new()),
            (Vec::new(), prng.bytes(300)),
            (base.clone(), Vec::new()),
            (base.clone(), base.clone()),
            (b"hello".to_vec(), b"hello".to_vec()),
            (b"hello world".to_vec(), b"hello wasm world".to_vec()),
        ];
        // single-byte change
        let mut new = base.clone();
        new[12345] ^= 0xa5;
        cases.push((base.clone(), new));
        // inserted block
        let mut new = base[..30000].to_vec();
        new.extend(prng.bytes(4096));
        new.extend(&base[30000..]);
        cases.push((base.clone(), new));
        // deleted block
        let mut new = base[..10000].to_vec();
        new.extend(&base[50000..]);
        cases.push((base.clone(), new));
        // scattered changes
        let mut new = base.clone();
        for i in (0..new.len()).step_by(997) {
            new[i] ^= 0x5c;
        }
        cases.push((base.clone(), new));
        // shuffle: new is old rotated by 8192
        let mut new = base[8192..].to_vec();
        new.extend(&base[..8192]);
        cases.push((base.clone(), new));
        // same content twice in old, half removed in new
        let mut old2 = base[..8192].to_vec();
        old2.extend(base[..8192].to_vec());
        cases.push((old2, base[..8192].to_vec()));

        for (index, (old, new)) in cases.iter().enumerate() {
            let patch = diff_bytes(old, new);
            // bipatch header
            assert_eq!(&patch[..4], &[0xdf, 0xb1, 0x00, 0x00], "case {index}");
            assert_eq!(&patch[4..8], &[0x00, 0x10, 0x00, 0x00], "case {index}");
            let applied = patch_ok(old, &patch);
            assert_eq!(&applied, new, "case {index} round trip");
            // determinism
            assert_eq!(diff_bytes(old, new), patch, "case {index} deterministic");
        }
    }

    #[test]
    fn diff_patch_round_trip_large_prng() {
        // 1 MiB of PRNG content with an insertion and scattered edits.
        let mut prng = Prng(0xDEADBEEF);
        let old = prng.bytes(1024 * 1024);
        let mut new = old[..400_000].to_vec();
        new.extend(prng.bytes(7777));
        new.extend(&old[400_000..900_000]);
        for i in (900_000..old.len()).step_by(13_337) {
            new.push(old[i] ^ 0x11);
        }
        // bipatch stores diff/copy bytes uncompressed: patch ~= new + control
        // overhead even when most of `new` matches `old`.
        let patch = diff_bytes(&old, &new);
        assert_eq!(patch_ok(&old, &patch), new);
        let info = parse(binary_patch_info(&patch, "{}"));
        assert_eq!(info["format"], "bipatch");
        assert_eq!(info["well_formed"], true);
        assert_eq!(info["complete"], true);
        assert_eq!(info["output_bytes"], new.len() as u64);
        assert!(info["control_count"].as_u64().unwrap() >= 1);
        assert_eq!(info["old_bytes_touched"].as_u64().unwrap() <= old.len() as u64, true);
    }

    #[test]
    fn patch_expected_sha256() {
        let old = b"firmware image v1".to_vec();
        let new = b"firmware image v2 extended".to_vec();
        let patch = diff_bytes(&old, &new);
        let good = sha256_hex(&new);
        let applied = patch_bytes(&old, &patch, &json!({"expectedSha256": good}).to_string())
            .expect("matching digest must apply");
        assert_eq!(applied, new);

        let wrong = "0".repeat(64);
        let error = patch_bytes(&old, &patch, &json!({"expectedSha256": wrong}).to_string())
            .expect_err("wrong digest must fail");
        let parsed = parse(error);
        assert_eq!(parsed["error"], "checksum_mismatch");
        assert_eq!(parsed["expected"].as_str().unwrap(), wrong);
        assert_eq!(parsed["actual"].as_str().unwrap(), good);

        // uppercase hex is accepted
        let upper = json!({"expectedSha256": good.to_uppercase()}).to_string();
        assert_eq!(patch_bytes(&old, &patch, &upper).unwrap(), new);
    }

    #[test]
    fn patch_tampering_errors() {
        let old = Prng(99).bytes(8192);
        let mut new = old.clone();
        new[100..108].copy_from_slice(b"INJECTED");
        new.extend(b"appended tail");
        let patch = diff_bytes(&old, &new);

        // truncated patch
        assert_eq!(patch_error(&old, &patch[..patch.len() - 2]), "invalid_patch");
        // bad magic
        let mut tampered = patch.clone();
        tampered[0] ^= 0xff;
        assert_eq!(patch_error(&old, &tampered), "invalid_patch");
        // bad version
        let mut tampered = patch.clone();
        tampered[4] ^= 0xff;
        assert_eq!(patch_error(&old, &tampered), "invalid_patch");
        // empty patch
        assert_eq!(patch_error(&old, &[]), "invalid_patch");
        // not a patch at all
        assert_eq!(patch_error(&old, b"BSDIFF40xxxxxxxx"), "invalid_patch");
        // corrupted control varint inflates add_len past `old`
        let mut tampered = patch.clone();
        tampered[8] = 0xff;
        tampered[9] = 0xff;
        tampered[10] = 0xff;
        tampered[11] = 0xff;
        tampered[12] = 0x0f; // varint add_len ~ u32::MAX
        assert_eq!(patch_error(&old, &tampered), "invalid_patch");
    }

    #[test]
    fn patch_silent_payload_corruption_detected_by_checksum() {
        let old = b"the quick brown fox jumps over the lazy dog".to_vec();
        let new = b"the quick brown fox jumps over the lazy cat".to_vec();
        let patch = diff_bytes(&old, &new);
        // Flip a payload byte inside the copy region (last byte of the patch
        // data section, before the trailing varints).
        let mut tampered = patch.clone();
        let i = patch.len() - 4;
        tampered[i] ^= 0x01;
        // Without a checksum the patch still applies — to the wrong bytes.
        let applied = patch_ok(&old, &tampered);
        assert_eq!(applied.len(), new.len());
        assert_ne!(applied, new);
        // With expectedSha256 the same corruption is a hard error.
        let options = json!({"expectedSha256": sha256_hex(&new)}).to_string();
        let error =
            patch_bytes(&old, &tampered, &options).expect_err("checksum must catch tamper");
        assert_eq!(parse(error)["error"], "checksum_mismatch");
    }

    #[test]
    fn patch_header_only_produces_empty() {
        let header_only = [0xdf, 0xb1, 0, 0, 0, 0x10, 0, 0];
        assert_eq!(patch_ok(b"anything at all", &header_only), Vec::<u8>::new());
    }

    // ---- binary_patch_info -------------------------------------------------

    #[test]
    fn patch_info_reports() {
        let old = b"hello".to_vec();
        let new = b"hello brave new world".to_vec();
        let patch = diff_bytes(&old, &new);
        let info = parse(binary_patch_info(&patch, "{}"));
        assert_eq!(info["schema_version"], 1);
        assert_eq!(info["format"], "bipatch");
        assert_eq!(info["magic"], "0xb1df");
        assert_eq!(info["version"], "0x1000");
        assert_eq!(info["well_formed"], true);
        assert_eq!(info["complete"], true);
        assert_eq!(info["output_bytes"], new.len() as u64);
        assert_eq!(info["patch_bytes"], patch.len() as u64);
        assert!(info["control_count"].as_u64().unwrap() >= 1);
        assert_eq!(info["truncated"], false);
    }

    #[test]
    fn patch_info_triage() {
        // non-patch
        let info = parse(binary_patch_info(b"not a patch at all", "{}"));
        assert_eq!(info["format"], "unknown");
        assert_eq!(info["well_formed"], false);
        assert_eq!(info["warnings"], json!(["unrecognized_header"]));

        // short header
        let info = parse(binary_patch_info(&[0xdf, 0xb1], "{}"));
        assert_eq!(info["warnings"], json!(["short_header"]));

        // header only: complete, zero controls
        let info = parse(binary_patch_info(&[0xdf, 0xb1, 0, 0, 0, 0x10, 0, 0], "{}"));
        assert_eq!(info["well_formed"], true);
        assert_eq!(info["complete"], true);
        assert_eq!(info["control_count"], 0);
        assert_eq!(info["output_bytes"], 0);

        // truncated mid-record: add_len 5 declared, only 2 payload bytes
        let info = parse(binary_patch_info(
            &[0xdf, 0xb1, 0, 0, 0, 0x10, 0, 0, 0x05, 0xaa, 0xbb],
            "{}",
        ));
        assert_eq!(info["complete"], false);
        assert_eq!(info["warnings"], json!(["truncated_record"]));
        assert_eq!(info["control_count"], 0);
    }

    // ---- input document and options handling --------------------------------

    #[test]
    fn malformed_input_documents() {
        // not JSON
        for bad in [&b""[..], b"not json", b"[1,2,3]", b"42", b"\"string\""] {
            let result = parse(binary_compare(bad, "{}"));
            assert_eq!(result["error"], "invalid_input", "input {bad:?}");
        }
        // missing fields
        let result = parse(binary_compare(b"{}", "{}"));
        assert_eq!(result["error"], "invalid_input");
        let result = parse(binary_compare(&pair_doc(b"a", b"b")[..], "{}"));
        assert!(result.get("error").is_none());
        // field not a string
        let doc = serde_json::to_vec(&json!({"old": 5, "new": b64(b"x")})).unwrap();
        assert_eq!(parse(binary_compare(&doc, "{}"))["error"], "invalid_input");
        // bad base64
        let doc = serde_json::to_vec(&json!({"old": "!!!", "new": b64(b"x")})).unwrap();
        assert_eq!(parse(binary_compare(&doc, "{}"))["error"], "invalid_base64");
        let doc = serde_json::to_vec(&json!({"old": "AAAA", "new": "not-canonical!"})).unwrap();
        assert_eq!(parse(binary_compare(&doc, "{}"))["error"], "invalid_base64");
        // same errors through every op
        assert_eq!(parse(binary_regions(b"{}", "{}"))["error"], "invalid_input");
        let error = binary_diff_impl(b"{}", "{}").expect_err("must fail");
        assert_eq!(parse(error)["error"], "invalid_input");
        let error = binary_patch_impl(b"{}", "{}").expect_err("must fail");
        assert_eq!(parse(error)["error"], "invalid_input");
    }

    #[test]
    fn oversized_embedded_input() {
        let oversized = vec![0u8; MAX_EMBEDDED_BYTES + 1];
        let doc = pair_doc(&oversized, b"small");
        let result = parse(binary_compare(&doc, "{}"));
        assert_eq!(result["error"], "input_too_large");
        let result = parse(binary_regions(&doc, "{}"));
        assert_eq!(result["error"], "input_too_large");
        let error = binary_diff_impl(&doc, "{}").expect_err("must fail");
        assert_eq!(parse(error)["error"], "input_too_large");
        // the patch field is size-checked too
        let error = binary_patch_impl(&patch_doc(b"old", &oversized), "{}").expect_err("must fail");
        assert_eq!(parse(error)["error"], "input_too_large");
        // patch_info raw input
        let result = parse(binary_patch_info(&vec![0u8; MAX_PATCH_INFO_BYTES + 1], "{}"));
        assert_eq!(result["error"], "input_too_large");
    }

    #[test]
    fn options_handling() {
        let doc = pair_doc(b"abc", b"abd");
        // options too large
        let big = "x".repeat(MAX_OPTIONS_BYTES + 1);
        assert_eq!(parse(binary_compare(&doc, &big))["error"], "options_too_large");
        assert_eq!(parse(binary_regions(&doc, &big))["error"], "options_too_large");
        assert_eq!(parse(binary_patch_info(&[0u8; 8], &big))["error"], "options_too_large");
        // invalid options shapes
        assert_eq!(parse(binary_compare(&doc, "{nope"))["error"], "invalid_options");
        assert_eq!(parse(binary_compare(&doc, "[1]"))["error"], "invalid_options");
        assert_eq!(
            parse(binary_compare(&doc, "{\"maxRegions\":-1}"))["error"],
            "invalid_options"
        );
        assert_eq!(
            parse(binary_compare(&doc, "{\"maxRegions\":\"many\"}"))["error"],
            "invalid_options"
        );
        // empty / whitespace options are defaults
        assert_eq!(parse(binary_compare(&doc, ""))["schema_version"], 1);
        assert_eq!(parse(binary_compare(&doc, "   "))["schema_version"], 1);
        // maxRegions clamps the region list
        let mut new = Prng(77).bytes(2048);
        let old = new.clone();
        for i in 0..64 {
            new[i * 16] ^= 0xff;
        }
        let doc = pair_doc(&old, &new);
        let result = parse(binary_compare(&doc, "{\"maxRegions\":4}"));
        assert_eq!(result["region_count"], 64);
        assert_eq!(result["regions"].as_array().unwrap().len(), 4);
        assert_eq!(result["truncated"], true);
        // bad expectedSha256 shapes
        for bad in ["", "xyz", &"a".repeat(63), &"g".repeat(64)] {
            let options = json!({"expectedSha256": bad}).to_string();
            let error = binary_patch_impl(&patch_doc(b"a", &diff_bytes(b"a", b"b")), &options)
                .expect_err("must fail");
            assert_eq!(parse(error)["error"], "invalid_options");
        }
    }

    #[test]
    fn max_output_bytes_option() {
        let old = vec![0u8; 4096];
        let new = Prng(55).bytes(4096);
        let error = binary_diff_impl(&pair_doc(&old, &new), "{\"maxOutputBytes\":64}")
            .expect_err("tiny cap must fail");
        assert_eq!(parse(error)["error"], "output_too_large");
        // patch side
        let patch = diff_bytes(&old, &new);
        let error = binary_patch_impl(&patch_doc(&old, &patch), "{\"maxOutputBytes\":64}")
            .expect_err("tiny cap must fail");
        let parsed = parse(error);
        assert!(parsed["error"] == "output_too_large" || parsed["error"] == "invalid_patch");
    }

    // ---- determinism / no panics --------------------------------------------

    #[test]
    fn determinism_all_ops() {
        let mut prng = Prng(0xBADC0DE);
        let old = prng.bytes(32 * 1024);
        let mut new = old.clone();
        new.extend(prng.bytes(1024));
        new[100] ^= 0x77;
        let doc = pair_doc(&old, &new);
        assert_eq!(binary_compare(&doc, "{}"), binary_compare(&doc, "{}"));
        assert_eq!(binary_regions(&doc, "{}"), binary_regions(&doc, "{}"));
        assert_eq!(diff_bytes(&old, &new), diff_bytes(&old, &new));
        let patch = diff_bytes(&old, &new);
        assert_eq!(
            binary_patch_info(&patch, "{}"),
            binary_patch_info(&patch, "{}")
        );
        assert_eq!(patch_ok(&old, &patch), patch_ok(&old, &patch));
    }

    #[test]
    fn no_panics_on_arbitrary_docs() {
        // Fuzz the document parser and every op with garbage; outputs must
        // always be the error envelope, never a panic.
        let mut prng = Prng(0xFEEDFACE);
        for _ in 0..256 {
            let garbage_len = prng.next() as usize % 512;
            let garbage = prng.bytes(garbage_len);
            assert_eq!(parse(binary_compare(&garbage, "{}"))["schema_version"], 1);
            assert_eq!(parse(binary_regions(&garbage, "{}"))["schema_version"], 1);
            assert_eq!(parse(binary_patch_info(&garbage, "{}"))["schema_version"], 1);
            let _ = binary_diff_impl(&garbage, "{}");
            let _ = binary_patch_impl(&garbage, "{}");
        }
        // garbage base64 fields of random content
        for _ in 0..64 {
            let old_len = prng.next() as usize % 2048;
            let old = prng.bytes(old_len);
            let new_len = prng.next() as usize % 2048;
            let new = prng.bytes(new_len);
            let mut patch = diff_bytes(&old, &new);
            // random truncation / corruption must never panic in patch
            if !patch.is_empty() {
                let cut = prng.next() as usize % (patch.len() + 1);
                patch.truncate(cut);
                if cut > 0 {
                    patch[cut - 1] ^= (prng.next() as u8) | 1;
                }
            }
            let _ = binary_patch_impl(&patch_doc(&old, &patch), "{}");
        }
    }
}
