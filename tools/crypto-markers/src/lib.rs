//! Bounded findcrypt-style cryptographic-artifact detection plus
//! byte-structure profiling for Turen agent tools.
//!
//! Four deterministic `wasm-bindgen` operations accept raw bytes plus a small
//! JSON options object and return bounded JSON. All input validation happens
//! before allocation; every error is a JSON document
//! `{"schema_version":1,"error":"<code>","message":"<detail>"}` — the module
//! never throws, traps on malformed input, or touches filesystem, network,
//! environment, or clock APIs.
//!
//! Hard bounds (enforced before allocation):
//! - input bytes: 32 MiB
//! - options JSON: 4 KiB
//! - serialized output: 4 MiB
//! - findings/regions/candidates: 4,096 entries

mod entropy;
mod scan;
mod stats;
mod tables;
mod xor;

use serde::Serialize;
use wasm_bindgen::prelude::*;

pub(crate) const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const MAX_OPTIONS_BYTES: usize = 4 * 1024;
pub(crate) const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_RESULTS: usize = 4096;

/// Scan raw bytes for known cryptographic constants, algorithm identifier
/// OIDs, key-structure templates, and keying-material strings.
///
/// Options: `{maxFindings?: number (default 4096, clamped 1..=4096),
/// minConfidence?: "low"|"medium"|"high" (default "low"),
/// algorithms?: string[] (filter by reported algorithm field)}`.
#[wasm_bindgen]
pub fn crypto_constants(bytes: &[u8], options_json: &str) -> String {
    if let Some(error) = check_bounds(bytes, options_json) {
        return error;
    }
    scan::run(bytes, options_json)
}

/// Sliding-window Shannon entropy profile with byte-class summaries and
/// classification hints for triage (packed/encrypted vs code vs padding).
///
/// Options: `{windowSize?: number (default 4096, clamped 16..=4194304),
/// stride?: number (default 4096, clamped 1..=4194304)}`.
#[wasm_bindgen]
pub fn entropy_map(bytes: &[u8], options_json: &str) -> String {
    if let Some(error) = check_bounds(bytes, options_json) {
        return error;
    }
    entropy::run(bytes, options_json)
}

/// Single-byte and short multi-byte XOR key detection. Scores candidate
/// decryptions by printable-ASCII ratio plus magic/content hits (MZ, ELF,
/// ZIP, PDF, PNG, PEM, http(s) URLs, ...). Scoring work is bounded to the
/// first 256 KiB of input unless `scanBytes` overrides.
///
/// Options: `{topK?: number (default 8, clamped 1..=64), scanBytes?: number
/// (default min(262144, input), clamped 1..=4194304), maxKeyLength?: number
/// (default 1 = single-byte exhaustive only, clamped 1..=8; >1 enables
/// per-position multi-byte key recovery), minScore?: number (default 0),
/// keys?: string[] (extra hex-encoded candidate keys, up to 64 keys of at
/// most 32 bytes each)}`.
#[wasm_bindgen]
pub fn xor_probe(bytes: &[u8], options_json: &str) -> String {
    if let Some(error) = check_bounds(bytes, options_json) {
        return error;
    }
    xor::run(bytes, options_json)
}

/// Whole-buffer byte profile: length, entropy, histogram summary, null and
/// printable ratios, line-ending counts, longest run, and ASCII/UTF-16LE
/// string-count estimates.
///
/// Options: `{minStringLength?: number (default 4, clamped 1..=64),
/// topBytes?: number (default 16, clamped 1..=64)}`.
#[wasm_bindgen]
pub fn byte_stats(bytes: &[u8], options_json: &str) -> String {
    if let Some(error) = check_bounds(bytes, options_json) {
        return error;
    }
    stats::run(bytes, options_json)
}

/// Enforce the shared hard bounds before any allocation or parsing work.
/// Returns the error JSON document when a bound is violated.
pub(crate) fn check_bounds(bytes: &[u8], options_json: &str) -> Option<String> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Some(error_json(
            "input_too_large",
            &format!("input size {} exceeds limit {}", bytes.len(), MAX_INPUT_BYTES),
        ));
    }
    if options_json.len() > MAX_OPTIONS_BYTES {
        return Some(error_json(
            "options_too_large",
            &format!(
                "options size {} exceeds limit {}",
                options_json.len(),
                MAX_OPTIONS_BYTES
            ),
        ));
    }
    None
}

/// Serialize a result, enforcing the serialized-output bound.
pub(crate) fn to_json<T: Serialize>(value: &T) -> String {
    match serde_json::to_string(value) {
        Ok(json) if json.len() <= MAX_OUTPUT_BYTES => json,
        Ok(_) => error_json("output_too_large", "serialized output exceeds 4 MiB limit"),
        Err(error) => error_json("serialization_error", &error.to_string()),
    }
}

/// `{"schema_version":1,"error":"<code>","message":"<detail>"}`
pub(crate) fn error_json(code: &str, message: &str) -> String {
    let mut out = String::with_capacity(64 + message.len().min(512));
    out.push_str("{\"schema_version\":1,\"error\":");
    push_json_str(&mut out, code);
    out.push_str(",\"message\":");
    push_json_str(&mut out, &clip(message, 512));
    out.push('}');
    out
}

pub(crate) fn clip(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

/// Append a JSON-escaped string literal (with quotes) to `out`.
pub(crate) fn push_json_str(out: &mut String, value: &str) {
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Lowercase hex encoding used for key bytes and previews.
pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// Shannon entropy in bits/byte (0..=8) of a byte-frequency histogram.
pub(crate) fn shannon(counts: &[u64; 256], total: usize) -> f64 {
    if total == 0 {
        return 0.0;
    }
    let n = total as f64;
    let mut entropy = 0.0;
    for &count in counts.iter() {
        if count == 0 {
            continue;
        }
        let p = count as f64 / n;
        entropy -= p * p.log2();
    }
    entropy
}

/// Histogram over a byte slice.
pub(crate) fn histogram(bytes: &[u8]) -> [u64; 256] {
    let mut counts = [0u64; 256];
    for &b in bytes {
        counts[b as usize] += 1;
    }
    counts
}

/// Round to two decimal places for stable JSON output.
pub(crate) fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

/// Round to four decimal places (ratios).
pub(crate) fn round4(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}

/// Printable ASCII or common whitespace (tab/LF/CR).
pub(crate) fn is_text_byte(b: u8) -> bool {
    (0x20..=0x7e).contains(&b) || matches!(b, 0x09 | 0x0a | 0x0d)
}

#[cfg(test)]
mod tests;
