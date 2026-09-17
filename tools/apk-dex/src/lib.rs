//! Bounded, offline, parse-only Android APK/DEX static inspection for Turen.
//!
//! Three wasm-bindgen operations accept input bytes plus a small JSON options
//! document and return bounded JSON. The module never executes or emulates
//! Dalvik bytecode, never resolves URLs, and exposes no filesystem, network,
//! environment, subprocess, or host-path capability.
//!
//! - `axml_decode` — Android binary XML (`ResXMLTree`) → text XML plus a
//!   string-pool summary. Works on `AndroidManifest.xml` or any compiled
//!   `res/` XML passed as raw bytes.
//! - `dex_inspect` — one `.dex` file: header stats, string/type/proto/field/
//!   method tables, class list with member counts, plus findings for
//!   reflection, dynamic loading, crypto, exec/su, and native usage.
//! - `apk_inspect` — an APK (ZIP): bounded entry table, manifest
//!   auto-decode, `classesN.dex` enumeration with SHA-256, `resources.arsc`
//!   package names, and APK v2/v3 + v1 signing signals.
//!
//! Error documents follow the repository convention:
//! `{"schema_version":1,"error":"<code>","message":"<detail>"}`.
//!
//! Hard limits (enforced before allocation/serialization):
//!   input bytes            32 MiB  (callers pass classesN.dex or the
//!                                    manifest alone for larger APKs)
//!   options JSON            4 KiB
//!   JSON output             4 MiB
//!   list items            4,096
//!   decoded XML             1 MiB
//!   DEX strings          4,096 x 512 chars
//!   ZIP entries         65,536 pre-parse, 4,096 reported
//!   per-entry decompressed 32 MiB
//!   AXML elements       65,536, depth 256
//!   findings            1,024

mod apk;
mod axml;
mod dex;
mod util;

#[cfg(test)]
mod fixtures;
#[cfg(test)]
mod tests;

use std::panic::{catch_unwind, AssertUnwindSafe};

use serde::Deserialize;
use serde_json::{Map, Value};
use wasm_bindgen::prelude::*;

use apk::{inspect_apk, ApkOptions, MAX_ENTRY_BYTES, MAX_XML_BYTES};
use axml::decode_axml;
use dex::{inspect_dex, DexOptions, MAX_LIST};

const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_OPTIONS_BYTES: usize = 4 * 1024;
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

fn error_json(code: &str, message: &str) -> String {
    let mut obj = Map::new();
    obj.insert("schema_version".into(), Value::from(1));
    obj.insert("error".into(), Value::from(code));
    obj.insert("message".into(), Value::from(util::cap_str(message, 1024)));
    Value::Object(obj).to_string()
}

/// Map a `code[:detail]` parser error to an error document.
fn parse_error(text: &str) -> String {
    let (code, detail) = text.split_once(':').unwrap_or((text, ""));
    if detail.is_empty() {
        error_json(code, code)
    } else {
        error_json(code, detail)
    }
}

fn finish(value: Value) -> String {
    match serde_json::to_string(&value) {
        Ok(text) if text.len() <= MAX_OUTPUT_BYTES => text,
        Ok(_) => error_json("output_too_large", "serialized output exceeds 4 MiB limit"),
        Err(error) => error_json("serialize_failed", &error.to_string()),
    }
}

fn check_limits(bytes: &[u8], options_json: &str) -> Option<String> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Some(error_json("input_too_large", "input exceeds 32 MiB limit"));
    }
    if options_json.len() > MAX_OPTIONS_BYTES {
        return Some(error_json(
            "options_too_large",
            "options exceed 4 KiB limit",
        ));
    }
    None
}

fn parse_options<T: for<'de> Deserialize<'de> + Default>(
    options_json: &str,
) -> Result<T, String> {
    if options_json.trim().is_empty() {
        return Ok(T::default());
    }
    // serde deserializes a struct positionally from a JSON sequence, so gate
    // on "is an object" first — `[1]` or `42` must be options_invalid.
    let value: Value = serde_json::from_str(options_json)
        .map_err(|error| error_json("options_invalid", &error.to_string()))?;
    if !value.is_object() {
        return Err(error_json(
            "options_invalid",
            "options must be a JSON object",
        ));
    }
    serde_json::from_value(value)
        .map_err(|error| error_json("options_invalid", &error.to_string()))
}

/// Run `op` under `catch_unwind` so a panic in a dependency can never
/// escape to the host as a trap; it degrades to `internal_panic` JSON.
fn guarded(op: impl FnOnce() -> Result<Value, String>) -> String {
    match catch_unwind(AssertUnwindSafe(op)) {
        Ok(Ok(value)) => finish(value),
        Ok(Err(code)) => parse_error(&code),
        Err(_) => error_json("internal_panic", "parser panic caught"),
    }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AxmlOptionsIn {
    /// Cap on emitted XML bytes; clamped to 1..=1 MiB.
    max_xml_bytes: Option<usize>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct DexOptionsIn {
    /// When the input is an APK/ZIP: which classesN.dex to inspect
    /// (1 = classes.dex, 2 = classes2.dex, ...). Ignored for raw DEX.
    dex_index: Option<u32>,
    /// Cap on strings/classes/protos list sizes, clamped to 0..=4096.
    limit: Option<usize>,
    /// Include the full string list (default true).
    include_strings: Option<bool>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ApkOptionsIn {
    /// Auto-decode AndroidManifest.xml (default true).
    decode_manifest: Option<bool>,
    /// Embed compact DEX stats per classesN.dex (default false).
    dex_details: Option<bool>,
    /// Entry table cap, clamped to 0..=4096.
    max_entries: Option<usize>,
    /// Per-entry decompressed read cap, clamped to ≤32 MiB.
    max_entry_bytes: Option<u64>,
}

// ---------------------------------------------------------------------------
// Public WASM API
// ---------------------------------------------------------------------------

/// Decode Android binary XML (AXML) bytes to text XML.
///
/// Options: `{"maxXmlBytes": <usize, clamped 1..1048576>}`
#[wasm_bindgen]
pub fn axml_decode(bytes: &[u8], options_json: &str) -> String {
    if let Some(error) = check_limits(bytes, options_json) {
        return error;
    }
    let options: AxmlOptionsIn = match parse_options(options_json) {
        Ok(options) => options,
        Err(error) => return error,
    };
    let max_xml = options
        .max_xml_bytes
        .unwrap_or(MAX_XML_BYTES)
        .clamp(1, MAX_XML_BYTES);
    guarded(|| {
        match decode_axml(bytes, max_xml) {
            Ok(report) => Ok(serde_json::json!({
                "schema_version": 1,
                "kind": "axml",
                "input_bytes": bytes.len(),
                "xml": report.xml,
                "xml_truncated": report.xml_truncated,
                "elements": report.elements,
                "attributes": report.attributes,
                "max_depth": report.max_depth,
                "namespaces": report
                    .namespaces
                    .iter()
                    .map(|(p, u)| serde_json::json!({"prefix": p, "uri": u}))
                    .collect::<Vec<_>>(),
                "string_pool": report.pool.map(|p| serde_json::json!({
                    "count": p.count,
                    "utf8": p.utf8,
                    "sorted": p.sorted,
                    "styles": p.styles,
                })),
                "warnings": report.warnings,
                "truncated": report.xml_truncated,
            })),
            Err(code) => Err(code),
        }
    })
}

/// Inspect one raw `.dex` file (or pick `classesN.dex` out of an APK input).
///
/// Options: `{"dexIndex": <u32, default 1>, "limit": <usize, default 4096>,
/// "includeStrings": <bool, default true>}`
#[wasm_bindgen]
pub fn dex_inspect(bytes: &[u8], options_json: &str) -> String {
    if let Some(error) = check_limits(bytes, options_json) {
        return error;
    }
    let options: DexOptionsIn = match parse_options(options_json) {
        Ok(options) => options,
        Err(error) => return error,
    };
    let dex_options = DexOptions {
        dex_index: options.dex_index.unwrap_or(1).max(1),
        limit: options.limit.unwrap_or(MAX_LIST).min(MAX_LIST),
        include_strings: options.include_strings.unwrap_or(true),
    };
    let dex_index = dex_options.dex_index;
    guarded(|| {
        // An APK/ZIP input selects one classesN.dex entry; anything else is
        // treated as raw DEX bytes.
        let owned;
        let data = if bytes.len() >= 4 && &bytes[0..4] == b"PK\x03\x04" {
            owned = apk::extract_dex(bytes, dex_index)?;
            owned.as_slice()
        } else {
            bytes
        };
        inspect_dex(data, &dex_options)
    })
}

/// Inspect an APK (ZIP) container.
///
/// Options: `{"decodeManifest": <bool, default true>, "dexDetails": <bool,
/// default false>, "maxEntries": <usize, default 4096>,
/// "maxEntryBytes": <u64, default 33554432>}`
#[wasm_bindgen]
pub fn apk_inspect(bytes: &[u8], options_json: &str) -> String {
    if let Some(error) = check_limits(bytes, options_json) {
        return error;
    }
    let options: ApkOptionsIn = match parse_options(options_json) {
        Ok(options) => options,
        Err(error) => return error,
    };
    let apk_options = ApkOptions {
        decode_manifest: options.decode_manifest.unwrap_or(true),
        dex_details: options.dex_details.unwrap_or(false),
        max_entries: options.max_entries.unwrap_or(MAX_LIST).min(MAX_LIST),
        max_entry_bytes: options
            .max_entry_bytes
            .unwrap_or(MAX_ENTRY_BYTES)
            .min(MAX_ENTRY_BYTES),
    };
    guarded(|| inspect_apk(bytes, &apk_options))
}
