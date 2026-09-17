//! Bounded, offline source-map decoding for minified-JS analysis in Turen
//! (developer debugging and JavaScript deobfuscation support).
//!
//! Five wasm-bindgen operations accept `.map` bytes plus a small JSON options
//! document. The module never fetches referenced URLs, never resolves file
//! paths, and exposes no filesystem, network, environment, subprocess, or
//! code-execution capability. All positions are 0-indexed, matching the
//! source-map v3 token convention.
//!
//! - `sourcemap_inspect` — parse a `.map` and summarize it: version, file,
//!   sourceRoot, debugId, source list (names + per-source `sourcesContent`
//!   presence, byte size and SHA-256 — contents are never inlined), name and
//!   mapping counts, `ignoreList`/`x_google_ignoreList` presence, and index-map
//!   section metadata.
//! - `sourcemap_lookup` — generated `{line, column}` in the minified file to
//!   the closest original `{source, line, column, name}` token.
//! - `sourcemap_reverse_lookup` — original `{source|sourceIndex, line,
//!   column?}` to the generated positions it maps to (capped at 4,096).
//! - `sourcemap_source` — extract one embedded `sourcesContent` entry by
//!   `index` or `path`, returned as one bounded byte vector (UTF-8, max 8 MiB).
//! - `sourcemap_flatten` — resolve a sectioned index sourcemap into a regular
//!   v3 map, returned as one bounded byte vector (JSON text, max 32 MiB).
//!
//! `sourcemap_inspect`, `sourcemap_lookup` and `sourcemap_reverse_lookup`
//! return a JSON string. `sourcemap_source` and `sourcemap_flatten` return a
//! byte vector (`Result<Vec<u8>, JsError>`); on failure the thrown `JsError`
//! message is the same error document. Error documents follow the repository
//! convention: `{"schema_version":1,"error":"<code>","message":"<detail>"}`.
//!
//! Hard limits (enforced before allocation/serialization):
//!   input bytes            32 MiB
//!   options JSON            4 KiB
//!   JSON output             4 MiB
//!   list items            4,096 (sources, sections, positions, ignore list)
//!   extracted source        8 MiB
//!   flattened output       32 MiB
//!   emitted strings         1 KiB each (source names, urls, warnings)
//!
//! Index/sectioned maps: `lookup` works natively on embedded sections only
//! (sections that merely reference an external URL are reported as
//! `unresolved_sections` and skipped, matching upstream semantics). `source`
//! and `reverse_lookup` first flatten the index — a section without an
//! embedded map fails with `unresolved_sections`. Flattened sources are
//! deduplicated and renumbered; `index`/`sourceIndex`/`path` then refer to the
//! flattened map's source list. Hermes (Metro/React Native) maps decode
//! natively; `flatten` drops `x_facebook_sources` scope metadata.

use std::borrow::Cow;
use std::collections::BTreeSet;
use std::io::Write;
use std::panic::{catch_unwind, AssertUnwindSafe};

use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;

use sourcemap::{decode_slice, DecodedMap, SourceMap, SourceMapIndex, Token};

const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_OPTIONS_BYTES: usize = 4 * 1024;
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_LIST_ITEMS: usize = 4096;
const MAX_SOURCE_BYTES: usize = 8 * 1024 * 1024;
const MAX_FLATTENED_BYTES: usize = 32 * 1024 * 1024;
const MAX_STRING_CHARS: usize = 1024;
const MAX_MATCHED_SOURCES: usize = 16;

// ---------------------------------------------------------------------------
// Error documents and shared helpers
// ---------------------------------------------------------------------------

fn error_json(code: &str, message: &str) -> String {
    let mut obj = Map::new();
    obj.insert("schema_version".into(), Value::from(1));
    obj.insert("error".into(), Value::from(code));
    obj.insert("message".into(), Value::from(clean(message)));
    Value::Object(obj).to_string()
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
        return Some(error_json(
            "input_too_large",
            "input exceeds 32 MiB limit",
        ));
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

/// Run `op` under `catch_unwind` so a panic in the parser can never escape to
/// the host as a trap; it degrades to `internal_panic` JSON.
fn run_json(op: impl FnOnce() -> Result<Value, String>) -> String {
    match catch_unwind(AssertUnwindSafe(op)) {
        Ok(Ok(value)) => finish(value),
        Ok(Err(document)) => document,
        Err(_) => error_json("internal_panic", "parser panic caught"),
    }
}

fn run_bytes(op: impl FnOnce() -> Result<Vec<u8>, String>) -> Result<Vec<u8>, JsError> {
    match catch_unwind(AssertUnwindSafe(op)) {
        Ok(Ok(bytes)) => Ok(bytes),
        Ok(Err(document)) => Err(JsError::new(&document)),
        Err(_) => Err(JsError::new(&error_json(
            "internal_panic",
            "parser panic caught",
        ))),
    }
}

fn clean(value: &str) -> String {
    value.chars().take(MAX_STRING_CHARS).collect()
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(64);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// Strip the `)]}'` anti-XSSI garbage header the way upstream does before a
/// cheap shallow header parse (the full decode does the same internally).
fn strip_junk_header(slice: &[u8]) -> &[u8] {
    fn is_junk(byte: u8) -> bool {
        byte == b')' || byte == b']' || byte == b'}' || byte == b'\''
    }
    if slice.is_empty() || !is_junk(slice[0]) {
        return slice;
    }
    let mut need_newline = false;
    for (idx, &byte) in slice.iter().enumerate() {
        if need_newline && byte != b'\n' {
            return &slice[..0];
        } else if is_junk(byte) {
            continue;
        } else if byte == b'\r' {
            need_newline = true;
        } else if byte == b'\n' {
            return &slice[idx..];
        }
    }
    &slice[slice.len()..]
}

/// Cheap shallow scan for fields the crate does not expose on the parsed map:
/// the raw `version` value and presence flags for the legacy
/// `x_google_ignoreList`, `rangeMappings`, and Metro/Hermes extension keys.
/// Heavy fields are skipped with `IgnoredAny`, so nothing large is allocated.
#[derive(Deserialize)]
struct RawHeader {
    version: Option<Value>,
    #[serde(rename = "ignoreList")]
    ignore_list: Option<serde::de::IgnoredAny>,
    #[serde(rename = "x_google_ignoreList")]
    x_google_ignore_list: Option<serde::de::IgnoredAny>,
    #[serde(rename = "rangeMappings")]
    range_mappings: Option<serde::de::IgnoredAny>,
    x_facebook_offsets: Option<serde::de::IgnoredAny>,
    x_metro_module_paths: Option<serde::de::IgnoredAny>,
    x_facebook_sources: Option<serde::de::IgnoredAny>,
}

fn scan_header(bytes: &[u8]) -> RawHeader {
    serde_json::from_slice(strip_junk_header(bytes)).unwrap_or(RawHeader {
        version: None,
        ignore_list: None,
        x_google_ignore_list: None,
        range_mappings: None,
        x_facebook_offsets: None,
        x_metro_module_paths: None,
        x_facebook_sources: None,
    })
}

fn error_code(error: &sourcemap::Error) -> &'static str {
    use sourcemap::Error as E;
    match error {
        E::BadJson(_) => "invalid_json",
        E::Utf8(_) => "invalid_utf8",
        E::VlqLeftover | E::VlqNoValues | E::VlqOverflow | E::BadSegmentSize(_) => {
            "invalid_mappings"
        }
        E::InvalidBase64(_) | E::InvalidRangeMappingIndex(_) => "invalid_mappings",
        E::BadSourceReference(_) => "bad_source_reference",
        E::BadNameReference(_) => "bad_name_reference",
        E::IncompatibleSourceMap => "not_a_sourcemap",
        E::InvalidDataUrl => "invalid_data_url",
        E::CannotFlatten(_) => "unresolved_sections",
        // Io and the RAM-bundle variants are unreachable with default
        // features; anything unrecognized still maps to a stable code.
        _ => "parse_failed",
    }
}

fn decode_map(bytes: &[u8]) -> Result<DecodedMap, String> {
    decode_slice(bytes)
        .map_err(|error| error_json(error_code(&error), &clean(&error.to_string())))
}

/// Resolve a `DecodedMap` to a regular `SourceMap`, flattening index maps
/// (which fails with `unresolved_sections` when a section only references an
/// external URL). Hermes maps deref to their inner regular map.
fn as_regular(decoded: &DecodedMap) -> Result<Cow<'_, SourceMap>, String> {
    match decoded {
        DecodedMap::Regular(sm) => Ok(Cow::Borrowed(sm)),
        DecodedMap::Hermes(smh) => Ok(Cow::Borrowed(&**smh)),
        DecodedMap::Index(smi) => Ok(Cow::Owned(smi.flatten().map_err(|error| {
            error_json(error_code(&error), &clean(&error.to_string()))
        })?)),
    }
}

fn kind_of(decoded: &DecodedMap) -> &'static str {
    match decoded {
        DecodedMap::Regular(_) => "regular",
        DecodedMap::Index(_) => "index",
        DecodedMap::Hermes(_) => "hermes",
    }
}

fn unresolved_sections(smi: &SourceMapIndex) -> usize {
    smi.sections()
        .filter(|section| section.get_sourcemap().is_none())
        .count()
}

/// Resolve a user-supplied source string to source indexes. Matching is, in
/// order: exact, then after stripping leading `./` from both sides, then a
/// `/`-boundary suffix match (`app.js` matches `webpack://x/./app.js`). The
/// first rule that matches anything wins; the resolved source names are
/// reported back in `matched_sources`.
fn resolve_source_query(sm: &SourceMap, query: &str) -> Vec<u32> {
    let count = sm.get_source_count();
    let exact: Vec<u32> = (0..count)
        .filter(|index| sm.get_source(*index) == Some(query))
        .collect();
    if !exact.is_empty() {
        return exact;
    }
    let wanted = query.trim_start_matches("./");
    (0..count)
        .filter(|index| {
            let source = sm
                .get_source(*index)
                .unwrap_or_default()
                .trim_start_matches("./");
            source == wanted || source.ends_with(&format!("/{wanted}"))
        })
        .collect()
}

fn token_json(token: &Token<'_>) -> Value {
    let mapped = token.has_source() && token.get_src_line() != u32::MAX;
    json!({
        "generated": {
            "line": token.get_dst_line(),
            "column": token.get_dst_col(),
        },
        "mapped": mapped,
        "source": if mapped { token.get_source() } else { None },
        "source_index": if mapped { Some(token.get_src_id()) } else { None },
        "original": if mapped {
            Some(json!({
                "line": token.get_src_line(),
                "column": token.get_src_col(),
            }))
        } else {
            None
        },
        "name": token.get_name(),
        "is_range": token.is_range(),
    })
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct InspectOptionsIn {
    /// Cap on the `sources` list, clamped to 0..=4096.
    max_sources: Option<usize>,
    /// Cap on the `sections` list (index maps), clamped to 0..=4096.
    max_sections: Option<usize>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct LookupOptionsIn {
    /// Generated (minified) 0-indexed line. Required.
    line: Option<u32>,
    /// Generated (minified) 0-indexed column. Required.
    column: Option<u32>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ReverseOptionsIn {
    /// Original source path; resolved by exact, normalized, then suffix match.
    source: Option<String>,
    /// Original source index; takes precedence over `source`.
    source_index: Option<u32>,
    /// Original 0-indexed line. Required.
    line: Option<u32>,
    /// Original 0-indexed column; when omitted all columns on `line` match.
    column: Option<u32>,
    /// Cap on returned positions, clamped to 0..=4096.
    max_positions: Option<usize>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct SourceOptionsIn {
    /// Index into the (flattened) map's source list; takes precedence.
    index: Option<u32>,
    /// Source path resolved like `reverse_lookup`'s `source`.
    path: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct FlattenOptionsIn {}

// ---------------------------------------------------------------------------
// Operation implementations
// ---------------------------------------------------------------------------

fn inspect_impl(bytes: &[u8], options: &InspectOptionsIn) -> Result<Value, String> {
    let decoded = decode_map(bytes)?;
    let header = scan_header(bytes);
    let mut warnings: Vec<String> = Vec::new();
    let mut truncated = false;

    let mut report = json!({
        "schema_version": 1,
        "kind": kind_of(&decoded),
        "input_bytes": bytes.len(),
        // The crate accepts maps without a numeric version; report what was
        // actually present, null when absent or not a number.
        "version": header.version.as_ref().and_then(Value::as_u64),
        "file": match &decoded {
            DecodedMap::Regular(sm) => sm.get_file(),
            DecodedMap::Index(smi) => smi.get_file(),
            DecodedMap::Hermes(smh) => smh.get_file(),
        },
        "debug_id": decoded.debug_id().map(|id| id.to_string()),
        "ignore_list_present": header.ignore_list.is_some(),
        "x_google_ignore_list_present": header.x_google_ignore_list.is_some(),
        "range_mappings_present": header.range_mappings.is_some(),
        "x_facebook_sources_present": header.x_facebook_sources.is_some(),
        "x_facebook_offsets_present": header.x_facebook_offsets.is_some(),
        "x_metro_module_paths_present": header.x_metro_module_paths.is_some(),
        // Regular-map fields; stay null on index maps.
        "source_root": Value::Null,
        "sources_count": Value::Null,
        "names_count": Value::Null,
        "mappings_count": Value::Null,
        "ignore_list": Value::Array(Vec::new()),
        "ignore_list_count": 0,
        // Index-map fields; stay null on regular and hermes maps.
        "sections_count": Value::Null,
        "unresolved_sections": Value::Null,
        "sections": Value::Array(Vec::new()),
        "sources": Value::Array(Vec::new()),
    });

    match &decoded {
        DecodedMap::Index(smi) => {
            let max_sections = options
                .max_sections
                .unwrap_or(MAX_LIST_ITEMS)
                .min(MAX_LIST_ITEMS);
            let total = smi.get_section_count() as usize;
            let mut sections = Vec::new();
            for (index, section) in smi.sections().enumerate().take(max_sections) {
                let (line, column) = section.get_offset();
                let mut entry = json!({
                    "index": index,
                    "offset": { "line": line, "column": column },
                    "url": section.get_url().map(clean),
                    "embedded": section.get_sourcemap().is_some(),
                });
                if let Some(map) = section.get_sourcemap() {
                    entry["embedded_kind"] = json!(kind_of(map));
                    match map {
                        DecodedMap::Regular(sm) => {
                            entry["sources_count"] = json!(sm.get_source_count());
                            entry["names_count"] = json!(sm.get_name_count());
                            entry["mappings_count"] = json!(sm.get_token_count());
                        }
                        DecodedMap::Hermes(smh) => {
                            entry["sources_count"] = json!(smh.get_source_count());
                            entry["names_count"] = json!(smh.get_name_count());
                            entry["mappings_count"] = json!(smh.get_token_count());
                        }
                        DecodedMap::Index(nested) => {
                            entry["sections_count"] = json!(nested.get_section_count());
                        }
                    }
                }
                sections.push(entry);
            }
            let unresolved = unresolved_sections(smi);
            if total > max_sections {
                truncated = true;
                warnings.push(format!(
                    "sections truncated from {total} to {max_sections}"
                ));
            }
            if unresolved > 0 {
                warnings.push(format!(
                    "{unresolved} section(s) reference external maps that are not embedded"
                ));
            }
            report["sections_count"] = json!(total);
            report["unresolved_sections"] = json!(unresolved);
            report["sections"] = Value::Array(sections);
        }
        DecodedMap::Regular(_) | DecodedMap::Hermes(_) => {
            let sm: &SourceMap = match &decoded {
                DecodedMap::Regular(sm) => sm,
                DecodedMap::Hermes(smh) => &**smh,
                DecodedMap::Index(_) => unreachable!(),
            };
            let ignored: BTreeSet<u32> = sm.ignore_list().copied().collect();
            let max_sources = options
                .max_sources
                .unwrap_or(MAX_LIST_ITEMS)
                .min(MAX_LIST_ITEMS);
            let total = sm.get_source_count() as usize;
            let mut sources = Vec::new();
            for index in 0..total.min(max_sources) {
                let index = index as u32;
                let name = sm.get_source(index).unwrap_or_default();
                let contents = sm.get_source_contents(index);
                sources.push(json!({
                    "index": index,
                    "source": clean(name),
                    "source_truncated": name.chars().count() > MAX_STRING_CHARS,
                    "ignored": ignored.contains(&index),
                    "has_content": contents.is_some(),
                    "content_bytes": contents.map(|value| value.len()),
                    "content_sha256": contents.map(|value| sha256_hex(value.as_bytes())),
                }));
            }
            if total > max_sources {
                truncated = true;
                warnings.push(format!(
                    "sources truncated from {total} to {max_sources}"
                ));
            }
            let ignore_list: Vec<u32> =
                ignored.iter().copied().take(MAX_LIST_ITEMS).collect();
            if ignored.len() > MAX_LIST_ITEMS {
                truncated = true;
                warnings.push("ignore_list truncated to 4096 entries".to_string());
            }
            report["source_root"] = json!(sm.get_source_root());
            report["sources_count"] = json!(total);
            report["names_count"] = json!(sm.get_name_count());
            report["mappings_count"] = json!(sm.get_token_count());
            report["ignore_list"] = json!(ignore_list);
            report["ignore_list_count"] = json!(ignored.len());
            report["sources"] = Value::Array(sources);
        }
    }

    report["warnings"] = json!(warnings);
    report["truncated"] = json!(truncated);
    Ok(report)
}

fn lookup_impl(bytes: &[u8], options: &LookupOptionsIn) -> Result<Value, String> {
    let line = options
        .line
        .ok_or_else(|| error_json("missing_option", "required option: line"))?;
    let column = options
        .column
        .ok_or_else(|| error_json("missing_option", "required option: column"))?;
    let decoded = decode_map(bytes)?;

    let mut warnings: Vec<String> = Vec::new();
    match &decoded {
        DecodedMap::Index(smi) => {
            let unresolved = unresolved_sections(smi);
            if unresolved > 0 {
                warnings.push(format!(
                    "{unresolved} section(s) reference external maps; lookups there return no token"
                ));
            }
            // Resolve the section ourselves so the reported generated
            // coordinates are global: tokens inside an embedded section map
            // carry section-local dst positions. Mirrors upstream
            // `SourceMapIndex::lookup_token`, including its semantics that a
            // section without an embedded map shadows everything after it.
            let mut selected = None;
            for section in smi.sections() {
                let offset = section.get_offset();
                if offset > (line, column) {
                    break;
                }
                selected = Some(section);
            }
            let Some(section) = selected else {
                return Ok(json!({
                    "schema_version": 1,
                    "found": false,
                    "warnings": warnings,
                }));
            };
            let (off_line, off_col) = section.get_offset();
            let Some(map) = section.get_sourcemap() else {
                return Ok(json!({
                    "schema_version": 1,
                    "found": false,
                    "warnings": warnings,
                }));
            };
            return match map.lookup_token(
                line - off_line,
                if line == off_line {
                    column - off_col
                } else {
                    column
                },
            ) {
                Some(token) => {
                    let mut entry = token_json(&token);
                    entry["generated"] = json!({
                        "line": token.get_dst_line().saturating_add(off_line),
                        "column": if token.get_dst_line() == 0 {
                            token.get_dst_col().saturating_add(off_col)
                        } else {
                            token.get_dst_col()
                        },
                    });
                    Ok(json!({
                        "schema_version": 1,
                        "found": true,
                        "token": entry,
                        "warnings": warnings,
                    }))
                }
                None => Ok(json!({
                    "schema_version": 1,
                    "found": false,
                    "warnings": warnings,
                })),
            };
        }
        _ => {}
    }

    match decoded.lookup_token(line, column) {
        Some(token) => Ok(json!({
            "schema_version": 1,
            "found": true,
            "token": token_json(&token),
            "warnings": warnings,
        })),
        None => Ok(json!({
            "schema_version": 1,
            "found": false,
            "warnings": warnings,
        })),
    }
}

fn reverse_lookup_impl(bytes: &[u8], options: &ReverseOptionsIn) -> Result<Value, String> {
    let line = options
        .line
        .ok_or_else(|| error_json("missing_option", "required option: line"))?;
    let decoded = decode_map(bytes)?;
    let sm = as_regular(&decoded)?;

    let candidates: Vec<u32> = if let Some(index) = options.source_index {
        if index != u32::MAX && index >= sm.get_source_count() {
            return Err(error_json(
                "source_not_found",
                "sourceIndex exceeds the map's source count",
            ));
        }
        vec![index]
    } else if let Some(query) = options.source.as_deref() {
        resolve_source_query(&sm, query)
    } else {
        return Err(error_json(
            "missing_option",
            "required option: source or sourceIndex",
        ));
    };
    let wanted: BTreeSet<u32> = candidates.iter().copied().collect();
    let matched_sources: Vec<String> = candidates
        .iter()
        .take(MAX_MATCHED_SOURCES)
        .filter_map(|index| sm.get_source(*index).map(clean))
        .collect();

    let max_positions = options
        .max_positions
        .unwrap_or(MAX_LIST_ITEMS)
        .min(MAX_LIST_ITEMS);
    let mut positions = Vec::new();
    let mut matched = 0usize;
    let mut scanned = 0usize;
    for token in sm.tokens() {
        scanned += 1;
        if !wanted.contains(&token.get_src_id()) || token.get_src_line() != line {
            continue;
        }
        if let Some(column) = options.column {
            if token.get_src_col() != column {
                continue;
            }
        }
        matched += 1;
        if positions.len() < max_positions {
            positions.push(json!({
                "line": token.get_dst_line(),
                "column": token.get_dst_col(),
                "name": token.get_name(),
                "is_range": token.is_range(),
            }));
        }
    }

    Ok(json!({
        "schema_version": 1,
        "found": !positions.is_empty(),
        "matched_sources": matched_sources,
        "matched_sources_truncated": candidates.len() > MAX_MATCHED_SOURCES,
        "positions": positions,
        "position_count": positions.len(),
        "match_count": matched,
        "scanned_tokens": scanned,
        "truncated": matched > positions.len(),
        "warnings": [],
    }))
}

fn source_impl(bytes: &[u8], options: &SourceOptionsIn) -> Result<Vec<u8>, String> {
    let decoded = decode_map(bytes)?;
    let sm = as_regular(&decoded)?;

    let index = if let Some(index) = options.index {
        index
    } else if let Some(path) = options.path.as_deref() {
        resolve_source_query(&sm, path)
            .first()
            .copied()
            .ok_or_else(|| error_json("source_not_found", "no source matches path"))?
    } else {
        return Err(error_json(
            "missing_option",
            "required option: index or path",
        ));
    };

    if index >= sm.get_source_count() {
        return Err(error_json(
            "source_not_found",
            "index exceeds the map's source count",
        ));
    }
    let contents = sm
        .get_source_contents(index)
        .ok_or_else(|| error_json("no_source_content", "source has no embedded content"))?;
    if contents.len() > MAX_SOURCE_BYTES {
        return Err(error_json(
            "source_too_large",
            "embedded source exceeds 8 MiB limit",
        ));
    }
    Ok(contents.as_bytes().to_vec())
}

/// A `Write` sink that fails once the accumulated output exceeds `limit`.
struct CappedWriter {
    inner: Vec<u8>,
    limit: usize,
    exceeded: bool,
}

impl Write for CappedWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        if self.inner.len().saturating_add(data.len()) > self.limit {
            self.exceeded = true;
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "output cap exceeded",
            ));
        }
        self.inner.extend_from_slice(data);
        Ok(data.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn flatten_impl(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let decoded = decode_map(bytes)?;
    let flat = as_regular(&decoded)?;
    let mut out = CappedWriter {
        inner: Vec::new(),
        limit: MAX_FLATTENED_BYTES,
        exceeded: false,
    };
    if let Err(error) = flat.to_writer(&mut out) {
        if out.exceeded {
            return Err(error_json(
                "flattened_too_large",
                "flattened map exceeds 32 MiB limit",
            ));
        }
        return Err(error_json(error_code(&error), &clean(&error.to_string())));
    }
    Ok(out.inner)
}

// ---------------------------------------------------------------------------
// Public WASM API
// ---------------------------------------------------------------------------

/// Summarize a `.map` document: kind (regular/index/hermes), version, file,
/// sourceRoot, debugId, bounded source list with per-source content
/// size + SHA-256 (contents are never inlined), name/mapping counts,
/// ignore-list entries, and index-map section metadata.
///
/// Options: `{"maxSources": <usize, default 4096>, "maxSections": <usize,
/// default 4096>}`
#[wasm_bindgen]
pub fn sourcemap_inspect(bytes: &[u8], options_json: &str) -> String {
    if let Some(error) = check_limits(bytes, options_json) {
        return error;
    }
    let options: InspectOptionsIn = match parse_options(options_json) {
        Ok(options) => options,
        Err(error) => return error,
    };
    run_json(|| inspect_impl(bytes, &options))
}

/// Map a generated (minified) 0-indexed `{line, column}` to the closest
/// original token: `{source, sourceIndex, original:{line,column}, name,
/// isRange, mapped}`.
///
/// Options: `{"line": <u32, required>, "column": <u32, required>}`
#[wasm_bindgen]
pub fn sourcemap_lookup(bytes: &[u8], options_json: &str) -> String {
    if let Some(error) = check_limits(bytes, options_json) {
        return error;
    }
    let options: LookupOptionsIn = match parse_options(options_json) {
        Ok(options) => options,
        Err(error) => return error,
    };
    run_json(|| lookup_impl(bytes, &options))
}

/// Map an original `{source|sourceIndex, line, column?}` to the generated
/// (minified) positions it produced. Index maps are flattened first.
///
/// Options: `{"source": <string> | "sourceIndex": <u32>, "line": <u32,
/// required>, "column": <u32, optional>, "maxPositions": <usize, default
/// 4096>}`
#[wasm_bindgen]
pub fn sourcemap_reverse_lookup(bytes: &[u8], options_json: &str) -> String {
    if let Some(error) = check_limits(bytes, options_json) {
        return error;
    }
    let options: ReverseOptionsIn = match parse_options(options_json) {
        Ok(options) => options,
        Err(error) => return error,
    };
    run_json(|| reverse_lookup_impl(bytes, &options))
}

/// Extract one embedded `sourcesContent` entry as UTF-8 bytes by `index` or
/// `path`. Index maps are flattened first; indexes then refer to the flattened
/// source list. Errors are thrown as `JsError` whose message is the JSON
/// error document.
///
/// Options: `{"index": <u32> | "path": <string>}`
#[wasm_bindgen]
pub fn sourcemap_source(bytes: &[u8], options_json: &str) -> Result<Vec<u8>, JsError> {
    if let Some(error) = check_limits(bytes, options_json) {
        return Err(JsError::new(&error));
    }
    let options: SourceOptionsIn = match parse_options(options_json) {
        Ok(options) => options,
        Err(error) => return Err(JsError::new(&error)),
    };
    run_bytes(|| source_impl(bytes, &options))
}

/// Resolve a sectioned index sourcemap (or normalize a regular one) into a
/// regular v3 sourcemap, returned as JSON text bytes capped at 32 MiB. Hermes
/// maps flatten to a regular map without `x_facebook_sources` scope metadata.
/// Errors are thrown as `JsError` whose message is the JSON error document.
#[wasm_bindgen]
pub fn sourcemap_flatten(bytes: &[u8], options_json: &str) -> Result<Vec<u8>, JsError> {
    if let Some(error) = check_limits(bytes, options_json) {
        return Err(JsError::new(&error));
    }
    let _options: FlattenOptionsIn = match parse_options(options_json) {
        Ok(options) => options,
        Err(error) => return Err(JsError::new(&error)),
    };
    run_bytes(|| flatten_impl(bytes))
}

#[cfg(test)]
mod tests;
