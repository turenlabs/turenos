//! Bounded deep WebAssembly tooling for Turen agent tools.
//!
//! This target complements `tools/wasm-inspect` (validation plus section
//! listing) with deeper Bytecode Alliance `wasm-tools` functionality:
//!
//! * `wasm_print`    - bounded wasm/component -> `.wat` text rendering.
//! * `wasm_analyze`  - deep static profile: index-space tables, imports and
//!   exports with type signatures, code-size histogram, feature detection via
//!   `wasmparser` validation feature toggles, custom-section inventory,
//!   segments, globals, memories, tables. Parse-only; input is never
//!   instantiated or executed.
//! * `wasm_metadata` - producers section, name-section summary,
//!   `sourceMappingURL`, component-model outline.
//! * `wat_compile`   - `.wat` text -> validated wasm binary (bounded `Vec<u8>`).
//!
//! Hard limits are enforced before expensive allocation or serialization:
//!
//! * input bytes <= 32 MiB (wasm binary or wat text)
//! * options JSON <= 4 KiB
//! * JSON output <= 4 MiB (`wasm_print` text payload <= 8 MiB instead)
//! * every list <= 4,096 entries
//! * compiled output <= 32 MiB
//!
//! Expected failures serialize as `{"schema_version":1,"error":"<code>"}`.
//! `wat_compile` returns raw bytes on success and throws a `JsValue` whose
//! string is the same error JSON shape on failure.

mod analyze;
mod metadata;
mod print;
mod wat_compile;

use serde::Deserialize;
use wasm_bindgen::prelude::*;

/// Maximum accepted input size (wasm binary or wat text).
pub(crate) const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
/// Maximum accepted `options_json` size.
pub(crate) const MAX_OPTIONS_BYTES: usize = 4 * 1024;
/// Maximum serialized JSON output for report operations.
pub(crate) const MAX_JSON_BYTES: usize = 4 * 1024 * 1024;
/// Maximum `.wat` text produced by `wasm_print` before truncation.
pub(crate) const MAX_WAT_BYTES: usize = 8 * 1024 * 1024;
/// Maximum entries in any reported list.
pub(crate) const MAX_LIST: usize = 4096;
/// Maximum warning strings kept in a report.
pub(crate) const MAX_WARNINGS: usize = 64;
/// Maximum `.wat` text accepted by `wat_compile` (same as input cap).
pub(crate) const MAX_WAT_INPUT_BYTES: usize = MAX_INPUT_BYTES;
/// Maximum wasm binary produced by `wat_compile`.
pub(crate) const MAX_COMPILED_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct Options {
    /// `wasm_print`: omit function bodies and data contents.
    pub skeleton: bool,
    /// `wasm_print`: render instructions in folded s-expression form.
    pub fold_expressions: bool,
    /// `wasm_print`: annotate lines with binary offsets.
    pub print_offsets: bool,
    /// `wasm_print`: byte cap for the produced wat text (<= 8 MiB).
    pub max_wat_bytes: Option<u64>,
    /// `wasm_analyze`/`wasm_metadata`: per-list entry cap (<= 4,096).
    pub max_items: Option<u64>,
}

/// Parses the `options_json` argument shared by every operation. An empty or
/// whitespace-only string and JSON `null` mean defaults.
pub(crate) fn parse_options(options_json: &str) -> Result<Options, String> {
    if options_json.len() > MAX_OPTIONS_BYTES {
        return Err("options_too_large".to_string());
    }
    let trimmed = options_json.trim();
    if trimmed.is_empty() || trimmed == "null" {
        return Ok(Options::default());
    }
    serde_json::from_str::<Options>(trimmed).map_err(|_| "invalid_options".to_string())
}

impl Options {
    pub(crate) fn max_items(&self) -> usize {
        self.max_items
            .map(|value| (value as usize).min(MAX_LIST))
            .unwrap_or(MAX_LIST)
    }

    pub(crate) fn max_wat_bytes(&self) -> usize {
        self.max_wat_bytes
            .map(|value| (value as usize).min(MAX_WAT_BYTES))
            .unwrap_or(MAX_WAT_BYTES)
    }
}

/// Canonical error JSON: `{"schema_version":1,"error":"<code>"}`.
pub(crate) fn error_json(code: &str) -> String {
    serde_json::json!({ "schema_version": 1, "error": code }).to_string()
}

/// Error JSON with structured detail fields merged in.
pub(crate) fn error_json_detail(code: &str, detail: serde_json::Value) -> String {
    let mut object = serde_json::json!({ "schema_version": 1, "error": code });
    if let (Some(base), Some(extra)) = (object.as_object_mut(), detail.as_object()) {
        for (key, value) in extra {
            base.insert(key.clone(), value.clone());
        }
    }
    object.to_string()
}

/// Bounded warning collection: pushes while under `MAX_WARNINGS`, then marks
/// `truncated` once and drops further warnings.
pub(crate) fn push_warning(warnings: &mut Vec<String>, truncated: &mut bool, message: String) {
    if warnings.len() < MAX_WARNINGS {
        warnings.push(message);
    } else {
        *truncated = true;
    }
}

/// Serializes a report honoring the 4 MiB JSON ceiling. Over-cap reports are
/// replaced with a compact `output_too_large` body rather than erroring late
/// inside the JavaScript boundary.
pub(crate) fn serialize_bounded<T: serde::Serialize>(report: &T) -> String {
    match serde_json::to_string(report) {
        Ok(output) if output.len() <= MAX_JSON_BYTES => output,
        Ok(_) => error_json("output_too_large"),
        Err(_) => error_json("serialization_failed"),
    }
}

/// Detects the encoding of `bytes`: `"module"`, `"component"`, or `"unknown"`.
pub(crate) fn encoding_of(bytes: &[u8]) -> &'static str {
    if wasmparser::Parser::is_component(bytes) {
        "component"
    } else if wasmparser::Parser::is_core_wasm(bytes) {
        "module"
    } else {
        "unknown"
    }
}

/// Bounded `.wat` rendering of a wasm module or component.
///
/// Options (JSON object, all optional):
///
/// * `skeleton` (bool) - print section/item structure without function bodies.
/// * `foldExpressions` (bool) - folded s-expression instruction form.
/// * `printOffsets` (bool) - annotate printed lines with binary offsets.
/// * `maxWatBytes` (u64) - text cap, clamped to 8 MiB.
///
/// Returns `{"schema_version":1,"encoding":..,"wat":"..","wat_bytes":N,
/// "truncated":bool,"input_bytes":N}` or an error JSON object.
#[wasm_bindgen]
pub fn wasm_print(bytes: &[u8], options_json: &str) -> String {
    if bytes.len() > MAX_INPUT_BYTES {
        return error_json("input_too_large");
    }
    let options = match parse_options(options_json) {
        Ok(options) => options,
        Err(code) => return error_json(&code),
    };
    print::print(bytes, &options)
}

/// Deep static profile of a wasm module or component. Parse-only: the input
/// is validated and decoded but never instantiated or executed.
///
/// Options: `maxItems` (u64) clamps every reported list (default 4,096).
#[wasm_bindgen]
pub fn wasm_analyze(bytes: &[u8], options_json: &str) -> String {
    if bytes.len() > MAX_INPUT_BYTES {
        return error_json("input_too_large");
    }
    let options = match parse_options(options_json) {
        Ok(options) => options,
        Err(code) => return error_json(&code),
    };
    analyze::analyze(bytes, &options)
}

/// Metadata extraction: producers section, name-section summary,
/// `sourceMappingURL`, recognized custom sections, and component outline.
///
/// Options: `maxItems` (u64) clamps every reported list (default 4,096).
#[wasm_bindgen]
pub fn wasm_metadata(bytes: &[u8], options_json: &str) -> String {
    if bytes.len() > MAX_INPUT_BYTES {
        return error_json("input_too_large");
    }
    let options = match parse_options(options_json) {
        Ok(options) => options,
        Err(code) => return error_json(&code),
    };
    metadata::metadata(bytes, &options)
}

/// Compiles WebAssembly text format to a validated wasm binary.
///
/// Input is UTF-8 `.wat` text (module or component), output the binary bytes
/// (<= 32 MiB) as a `Uint8Array`. Failures throw a JS string containing the
/// error JSON; parse errors include `line`, `column`, and `offset`.
#[wasm_bindgen]
pub fn wat_compile(bytes: &[u8], options_json: &str) -> Result<Vec<u8>, JsValue> {
    if let Err(code) = parse_options(options_json) {
        return Err(JsValue::from_str(&error_json(&code)));
    }
    wat_compile::compile(bytes).map_err(|json| JsValue::from_str(&json))
}

#[cfg(test)]
mod tests;
