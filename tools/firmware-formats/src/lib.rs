#![forbid(unsafe_code)]

//! Bounded decoders for embedded/firmware file formats for Turen agent tools.
//!
//! Nine wasm-bindgen operations accept input bytes plus a small JSON options
//! object and return one bounded JSON report or one bounded byte vector. The
//! module is deterministic, offline, and read-only: no filesystem, network,
//! subprocess, environment, or clock access, and no analyzed-code execution.
//! It pairs with `binwalk-scan` (which identifies these formats) and
//! `squashfs` (which extracts filesystems carried inside them).
//!
//! Operations:
//! - `dtb_decompile` — Flattened Device Tree (DTB, magic 0xd00dfeed) → DTS text
//! - `uimage_inspect` — legacy U-Boot uImage header decode + both CRC checks
//! - `uboot_env_parse` — U-Boot environment blob → key=value entries
//! - `ihex_parse` / `ihex_flatten` — Intel HEX record listing / merged image
//! - `srec_parse` / `srec_flatten` — Motorola S-Record listing / merged image
//! - `android_sparse_parse` / `android_sparse_expand` — Android sparse image
//!
//! Expected errors are reported as a JSON object
//! `{"schema_version":1,"error":"<code>", ...}` carried as the `JsError`
//! message, so JavaScript receives the same error document whether the
//! operation returns JSON or bytes. `catch_unwind` additionally degrades any
//! internal panic to `internal_panic`; nothing panics on untrusted input.
//!
//! Hard limits (enforced before allocation/serialization):
//!   input bytes            32 MiB
//!   options JSON            4 KiB
//!   JSON output             4 MiB
//!   list items            4,096
//!   transformed output    128 MiB

mod crc32;
mod dtb;
mod ihex;
mod sparse;
mod srec;
#[cfg(test)]
mod tests;
mod uimage;

use serde_json::{json, Map, Value};
use std::panic::{catch_unwind, AssertUnwindSafe};
use wasm_bindgen::prelude::*;

/// Maximum input accepted by any operation.
pub(crate) const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
/// Maximum serialized options object accepted by any operation.
pub(crate) const MAX_OPTIONS_BYTES: usize = 4 * 1024;
/// Maximum JSON report produced by any operation.
pub(crate) const MAX_JSON_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
/// Maximum entries in any reported list (records, chunks, env entries, ...).
pub(crate) const MAX_LIST_ITEMS: usize = 4096;
/// Maximum bytes one flatten/expand transform may produce.
pub(crate) const MAX_TRANSFORM_BYTES: u64 = 128 * 1024 * 1024;

/// `{"schema_version":1,"error":code, ...}` — the shared error envelope.
/// Internal functions return this string; the wasm boundary wraps it in
/// `JsError` so JavaScript receives the same JSON as the thrown message.
pub(crate) fn error_json(code: &str, extra: Value) -> String {
    let mut object = Map::new();
    object.insert("schema_version".into(), json!(1));
    object.insert("error".into(), json!(code));
    if let Value::Object(fields) = extra {
        object.extend(fields);
    }
    Value::Object(object).to_string()
}

/// `err("malformed", detail)` — shorthand error document with a detail string.
pub(crate) fn err(code: &str, detail: impl std::fmt::Display) -> String {
    error_json(code, json!({ "detail": detail.to_string() }))
}

/// Render an address as a `0x...` hex string (JSON-safe for 64-bit values).
pub(crate) fn hex(value: u64) -> String {
    format!("0x{value:x}")
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

pub(crate) fn parse_options(options_json: &str) -> Result<Map<String, Value>, String> {
    if options_json.len() > MAX_OPTIONS_BYTES {
        return Err(error_json(
            "options_too_large",
            json!({ "size": options_json.len(), "limit": MAX_OPTIONS_BYTES }),
        ));
    }
    let trimmed = options_json.trim();
    if trimmed.is_empty() {
        return Ok(Map::new());
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

pub(crate) fn option_u64(object: &Map<String, Value>, key: &str) -> Result<Option<u64>, String> {
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

pub(crate) fn option_bool(object: &Map<String, Value>, key: &str) -> Result<Option<bool>, String> {
    match object.get(key) {
        None => Ok(None),
        Some(Value::Bool(flag)) => Ok(Some(*flag)),
        Some(_) => Err(error_json(
            "invalid_options",
            json!({ "detail": format!("{key} must be a boolean") }),
        )),
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

/// Run `f` under `catch_unwind` so a panic can never escape to the host as a
/// bare trap; it degrades to an `internal_panic` JSON document.
fn run_json(f: impl FnOnce() -> Result<String, String>) -> Result<String, JsError> {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(result) => result.map_err(|message| JsError::new(&message)),
        Err(_) => Err(JsError::new(&error_json("internal_panic", json!({})))),
    }
}

fn run_bytes(f: impl FnOnce() -> Result<Vec<u8>, String>) -> Result<Vec<u8>, JsError> {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(result) => result.map_err(|message| JsError::new(&message)),
        Err(_) => Err(JsError::new(&error_json("internal_panic", json!({})))),
    }
}

// ---------------------------------------------------------------------------
// Operation implementations
// ---------------------------------------------------------------------------

fn dtb_decompile_impl(bytes: &[u8], options_json: &str) -> Result<String, String> {
    check_input(bytes)?;
    let object = parse_options(options_json)?;
    let options = dtb::Options {
        max_output_bytes: option_u64(&object, "maxOutputBytes")?
            .map(|value| value.clamp(1024, MAX_JSON_OUTPUT_BYTES as u64) as usize)
            .unwrap_or(MAX_JSON_OUTPUT_BYTES),
        max_nodes: option_u64(&object, "maxNodes")?
            .map(|value| value.min(1_000_000) as usize)
            .unwrap_or(65_536),
    };
    serialize(&dtb::decompile(bytes, &options)?)
}

fn uimage_inspect_impl(bytes: &[u8], options_json: &str) -> Result<String, String> {
    check_input(bytes)?;
    parse_options(options_json)?;
    serialize(&uimage::inspect(bytes)?)
}

fn uboot_env_parse_impl(bytes: &[u8], options_json: &str) -> Result<String, String> {
    check_input(bytes)?;
    let object = parse_options(options_json)?;
    let options = uimage::EnvOptions {
        redundant: option_bool(&object, "redundant")?,
        max_entries: option_u64(&object, "maxEntries")?
            .map(|value| value.min(MAX_LIST_ITEMS as u64) as usize)
            .unwrap_or(MAX_LIST_ITEMS),
    };
    serialize(&uimage::parse_env(bytes, &options)?)
}

fn ihex_parse_impl(bytes: &[u8], options_json: &str) -> Result<String, String> {
    check_input(bytes)?;
    let object = parse_options(options_json)?;
    let options = ihex::ParseOptions {
        max_records: option_u64(&object, "maxRecords")?
            .map(|value| value.min(MAX_LIST_ITEMS as u64) as usize)
            .unwrap_or(MAX_LIST_ITEMS),
    };
    serialize(&ihex::parse(bytes, &options)?)
}

fn ihex_flatten_impl(bytes: &[u8], options_json: &str) -> Result<Vec<u8>, String> {
    check_input(bytes)?;
    let object = parse_options(options_json)?;
    let options = ihex::FlattenOptions {
        fill: option_u64(&object, "fill")?
            .map(|value| value.min(0xff) as u8)
            .unwrap_or(0xff),
        ignore_checksums: option_bool(&object, "ignoreChecksums")?.unwrap_or(false),
        max_output_bytes: option_u64(&object, "maxOutputBytes")?
            .map(|value| value.clamp(1, MAX_TRANSFORM_BYTES))
            .unwrap_or(MAX_TRANSFORM_BYTES),
    };
    ihex::flatten(bytes, &options)
}

fn srec_parse_impl(bytes: &[u8], options_json: &str) -> Result<String, String> {
    check_input(bytes)?;
    let object = parse_options(options_json)?;
    let options = srec::ParseOptions {
        max_records: option_u64(&object, "maxRecords")?
            .map(|value| value.min(MAX_LIST_ITEMS as u64) as usize)
            .unwrap_or(MAX_LIST_ITEMS),
    };
    serialize(&srec::parse(bytes, &options)?)
}

fn srec_flatten_impl(bytes: &[u8], options_json: &str) -> Result<Vec<u8>, String> {
    check_input(bytes)?;
    let object = parse_options(options_json)?;
    let options = srec::FlattenOptions {
        fill: option_u64(&object, "fill")?
            .map(|value| value.min(0xff) as u8)
            .unwrap_or(0xff),
        ignore_checksums: option_bool(&object, "ignoreChecksums")?.unwrap_or(false),
        max_output_bytes: option_u64(&object, "maxOutputBytes")?
            .map(|value| value.clamp(1, MAX_TRANSFORM_BYTES))
            .unwrap_or(MAX_TRANSFORM_BYTES),
    };
    srec::flatten(bytes, &options)
}

fn android_sparse_parse_impl(bytes: &[u8], options_json: &str) -> Result<String, String> {
    check_input(bytes)?;
    let object = parse_options(options_json)?;
    let options = sparse::ParseOptions {
        verify_crc: option_bool(&object, "verifyCrc")?.unwrap_or(true),
        max_chunks: option_u64(&object, "maxChunks")?
            .map(|value| value.min(MAX_LIST_ITEMS as u64) as usize)
            .unwrap_or(MAX_LIST_ITEMS),
    };
    serialize(&sparse::parse(bytes, &options)?)
}

fn android_sparse_expand_impl(bytes: &[u8], options_json: &str) -> Result<Vec<u8>, String> {
    check_input(bytes)?;
    let object = parse_options(options_json)?;
    let options = sparse::ExpandOptions {
        max_output_bytes: option_u64(&object, "maxOutputBytes")?
            .map(|value| value.clamp(1, MAX_TRANSFORM_BYTES))
            .unwrap_or(MAX_TRANSFORM_BYTES),
    };
    sparse::expand(bytes, &options)
}

// ---------------------------------------------------------------------------
// Public WASM API
// ---------------------------------------------------------------------------

/// Decompile a Flattened Device Tree (DTB) to DTS source text.
///
/// Returns a JSON report `{kind:"dtb", version, last_comp_version,
/// boot_cpuid_phys, total_size, memory_reservations, node_count,
/// property_count, dts, dts_bytes, truncated, warnings}`. Property values are
/// typed-decoded: printable NUL-terminated data renders as `"string"[, ...]`,
/// 4-aligned data as `<0x...>` cell arrays, everything else as `[xx ...]` byte
/// arrays. Options: `maxOutputBytes` (DTS text budget, default ~4 MiB),
/// `maxNodes` (default 65,536).
#[wasm_bindgen]
pub fn dtb_decompile(bytes: &[u8], options_json: &str) -> Result<String, JsError> {
    run_json(|| dtb_decompile_impl(bytes, options_json))
}

/// Inspect a legacy U-Boot uImage (magic 0x27051956) 64-byte header.
///
/// Returns a JSON report with name, timestamp, load/entry addresses, data
/// size, decoded os/arch/type/compression enums, and both header and data
/// CRC32 verification results. A header whose data extends past the input
/// still reports with `data_present:false` and `data_crc.valid:null`.
#[wasm_bindgen]
pub fn uimage_inspect(bytes: &[u8], options_json: &str) -> Result<String, JsError> {
    run_json(|| uimage_inspect_impl(bytes, options_json))
}

/// Parse a U-Boot environment blob (CRC32 + NUL-separated `key=value`).
///
/// Returns `{kind:"uboot-env", crc:{stored_le, stored_be, computed, valid,
/// endianness}, redundancy, flag, data_offset, entry_count, entries,
/// terminated, truncated, warnings}`. Options: `redundant` (bool; when omitted
/// the layout is auto-detected from the CRC), `maxEntries` (<= 4096).
#[wasm_bindgen]
pub fn uboot_env_parse(bytes: &[u8], options_json: &str) -> Result<String, JsError> {
    run_json(|| uboot_env_parse_impl(bytes, options_json))
}

/// Parse Intel HEX records into a bounded listing plus merged address map.
///
/// Returns `{kind:"ihex", record_count, records, ranges, gaps, data_bytes,
/// min_address, max_address, eof, start_address, invalid_checksums, ...}`.
/// Gaps between merged ranges are reported explicitly — that is the segment
/// layout signal. Per-record `checksum_valid` flags bad lines without
/// aborting the listing. Options: `maxRecords` (<= 4096).
#[wasm_bindgen]
pub fn ihex_parse(bytes: &[u8], options_json: &str) -> Result<String, JsError> {
    run_json(|| ihex_parse_impl(bytes, options_json))
}

/// Flatten Intel HEX data records into one contiguous image.
///
/// Output covers `[min_address, max_address]` of the data records; gaps are
/// filled with `fill` (default 0xFF, flash convention). The base address is
/// `min_address` from `ihex_parse`. Strict by default: any malformed line or
/// bad checksum is an error; `ignoreChecksums:true` skips checksum enforcement.
/// Options: `fill` (0-255), `ignoreChecksums` (bool), `maxOutputBytes`
/// (<= 128 MiB).
#[wasm_bindgen]
pub fn ihex_flatten(bytes: &[u8], options_json: &str) -> Result<Vec<u8>, JsError> {
    run_bytes(|| ihex_flatten_impl(bytes, options_json))
}

/// Parse Motorola S-Record (SREC/S19) lines into a bounded listing plus
/// merged address map. Same shape as `ihex_parse` plus `header` (S0 text) and
/// `count_check` (S5/S6 declared vs actual data record count).
#[wasm_bindgen]
pub fn srec_parse(bytes: &[u8], options_json: &str) -> Result<String, JsError> {
    run_json(|| srec_parse_impl(bytes, options_json))
}

/// Flatten S-Record S1/S2/S3 data records into one contiguous image.
/// Semantics and options are identical to `ihex_flatten`.
#[wasm_bindgen]
pub fn srec_flatten(bytes: &[u8], options_json: &str) -> Result<Vec<u8>, JsError> {
    run_bytes(|| srec_flatten_impl(bytes, options_json))
}

/// Parse an Android sparse image (magic 0xed26ff3a) chunk table.
///
/// Returns `{kind:"android-sparse", version, block_size, total_blocks,
/// chunk_count, chunks, expanded_bytes, crc:{stored,valid}, ...}`. When a
/// CRC32 chunk is present and the expanded image fits the transform cap, the
/// image is expanded in memory and the CRC verified. Options: `verifyCrc`
/// (default true), `maxChunks` (<= 4096).
#[wasm_bindgen]
pub fn android_sparse_parse(bytes: &[u8], options_json: &str) -> Result<String, JsError> {
    run_json(|| android_sparse_parse_impl(bytes, options_json))
}

/// Expand an Android sparse image to the raw output image.
///
/// `raw` chunks copy payload bytes, `fill` chunks tile their fill pattern,
/// `dont_care` chunks emit 0x00. A trailing CRC32 chunk is verified against
/// the expanded image (`crc_mismatch` on failure). Options: `maxOutputBytes`
/// (<= 128 MiB).
#[wasm_bindgen]
pub fn android_sparse_expand(bytes: &[u8], options_json: &str) -> Result<Vec<u8>, JsError> {
    run_bytes(|| android_sparse_expand_impl(bytes, options_json))
}
