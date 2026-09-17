//! Bounded, offline macOS forensic-artifact parser for TurenOS triage — the
//! macOS counterpart to the `windows-artifacts` target. Each operation accepts
//! one artifact's raw bytes plus a JSON options string and returns bounded,
//! deterministic JSON. The module never touches the network, filesystem,
//! process, or environment; expected failures degrade to stable error JSON
//! (`{"schema_version":1,"error":"<code>"}`) or explicit warnings — nothing is
//! silently skipped.

mod dsstore;
mod fsevents;
mod plistdoc;
mod tracev3;

#[cfg(test)]
mod tests;

use serde::de::DeserializeOwned;
use wasm_bindgen::prelude::*;

/// Hard input bound enforced before any parsing or allocation.
pub(crate) const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
/// Hard bound on the JSON options string.
pub(crate) const MAX_OPTIONS_BYTES: usize = 4 * 1024;
/// Hard bound on serialized JSON output.
pub(crate) const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
/// Hard bound on collected result lists (records, entries, log rows).
pub(crate) const MAX_RESULTS: usize = 4096;
/// Default result-list bound when the caller does not set `max_results`.
pub(crate) const DEFAULT_RESULTS: usize = 256;
/// Per-value cap on a single reported string (paths, messages, keys).
pub(crate) const MAX_STRING_CHARS: usize = 1024;
/// Bound on warning strings collected per call.
pub(crate) const MAX_WARNINGS: usize = 64;
/// Bound on plist nesting depth walked during JSON conversion.
pub(crate) const MAX_PLIST_DEPTH: usize = 32;
/// Bound on plist items emitted per container.
pub(crate) const MAX_PLIST_ITEMS: usize = 4096;
/// Bound on total plist events consumed from the parser stream.
pub(crate) const MAX_PLIST_EVENTS: u64 = 4 * 1024 * 1024;
/// Bound on decompressed fsevents stream bytes (gzip members concatenated).
pub(crate) const MAX_DECOMPRESSED_BYTES: u64 = 64 * 1024 * 1024;
/// Bound on a single fsevents record path.
pub(crate) const MAX_PATH_CHARS: usize = 4096;
/// Bound on DS_Store blocks walked (records nodes + allocator blocks).
pub(crate) const MAX_DSSTORE_BLOCKS: usize = 4096;
/// Bound on DS_Store B-tree depth (mirrors the host recursion bound).
pub(crate) const MAX_DSSTORE_DEPTH: usize = 4;
/// Preview hex bytes shown for opaque data values.
pub(crate) const PREVIEW_BYTES: usize = 32;

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


/// Success envelope shared by every operation: `{schema_version, format,
/// truncated, warnings, result}`.
#[derive(serde::Serialize)]
pub(crate) struct Envelope {
    schema_version: u8,
    format: &'static str,
    truncated: bool,
    warnings: Vec<String>,
    result: serde_json::Value,
}

impl Envelope {
    pub(crate) fn new(format: &'static str) -> Self {
        Self {
            schema_version: 1,
            format,
            truncated: false,
            warnings: Vec::new(),
            result: serde_json::Value::Null,
        }
    }

    /// Push a bounded warning string; duplicate saturation collapses into a
    /// single count so the warnings list itself stays bounded.
    pub(crate) fn warn(&mut self, message: impl Into<String>) {
        if self.warnings.len() < MAX_WARNINGS {
            self.warnings.push(message.into());
        } else if self.warnings.len() == MAX_WARNINGS {
            self.warnings
                .push("additional warnings suppressed".to_string());
        }
    }

    pub(crate) fn finish(self, result: serde_json::Value) -> serde_json::Value {
        serde_json::to_value(Envelope {
            result,
            ..self
        })
        .unwrap_or_else(|_| serde_json::json!({ "schema_version": 1, "error": "serialization_error" }))
    }
}

pub(crate) fn error_json(code: &str) -> String {
    serde_json::json!({ "schema_version": 1, "error": code }).to_string()
}

fn fail_json(fail: Fail) -> String {
    let mut object = serde_json::Map::new();
    object.insert("schema_version".to_string(), 1.into());
    object.insert("error".to_string(), fail.code.into());
    object.extend(fail.extra);
    serde_json::Value::Object(object).to_string()
}

/// Parse the options JSON. An empty string means defaults; anything else must
/// be a valid JSON object (never an array — that would allow positional
/// option smuggling). Size is checked by the dispatcher before this runs.
fn parse_options<T: DeserializeOwned + Default>(options_json: &str) -> Result<T, Fail> {
    let trimmed = options_json.trim();
    if trimmed.is_empty() {
        return Ok(T::default());
    }
    let value: serde_json::Value =
        serde_json::from_str(trimmed).map_err(|_| Fail::new("invalid_options"))?;
    if !value.is_object() {
        return Err(Fail::new("invalid_options"));
    }
    serde_json::from_value(value).map_err(|_| Fail::new("invalid_options"))
}

/// Shared dispatcher: enforce input/options bounds before any allocation,
/// run the operation under `catch_unwind` so a parser panic on malformed
/// input degrades to `internal_error` instead of trapping the worker, then
/// bound serialized output.
fn dispatch<T, F>(bytes: &[u8], options_json: &str, format: &'static str, op: F) -> String
where
    T: DeserializeOwned + Default,
    F: FnOnce(&[u8], &T, &mut Envelope) -> Result<serde_json::Value, Fail>,
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
    let value = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut envelope = Envelope::new(format);
        let result = op(bytes, &options, &mut envelope)?;
        Ok(envelope.finish(result))
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

/// Auto-detect the artifact kind and run the matching parser. The returned
/// JSON is identical to calling the named operation directly; unrecognized
/// input yields `{"schema_version":1,"error":"unknown_artifact"}`.
///
/// Detection order: binary/XML plist, gzip-wrapped or raw FSEvents disk log
/// pages, `.DS_Store` buddy-allocator magic, then a tracev3 chunk preamble.
/// Options: same as the resolved operation.
#[wasm_bindgen]
pub fn analyze(bytes: &[u8], options_json: &str) -> String {
    match detect_kind(bytes) {
        "plist" => plist_parse(bytes, options_json),
        "fsevents" => fsevents_parse(bytes, options_json),
        "ds_store" => ds_store_parse(bytes, options_json),
        "unified_log" => unified_log_parse(bytes, options_json),
        _ => {
            if bytes.is_empty() {
                error_json("empty_input")
            } else {
                error_json("unknown_artifact")
            }
        }
    }
}

/// Parse one Apple property list (binary `bplist00` or XML) into
/// bounded JSON: the full structure with depth capped at 32, per-container
/// items capped at 4096, strings capped at 1024 chars, `data` values rendered
/// as `{length, sha256, preview}`, `date`/`uid` wrapped with explicit type
/// markers, plus typed node counts and a maximum observed depth.
///
/// Options: `max_depth` (cap 32), `max_items` (cap 4096),
/// `max_string_chars` (cap 1024).
#[wasm_bindgen]
pub fn plist_parse(bytes: &[u8], options_json: &str) -> String {
    dispatch::<plistdoc::PlistOptions, _>(bytes, options_json, "plist", plistdoc::run)
}

/// Parse one `.fseventsd` disk-log file (gzip-wrapped or already
/// decompressed): `1SLD`/`2SLD`/`3SLD` record pages decoded to
/// `{event_id, path, flags {raw, names}, node_id}` rows, capped at 4096.
/// Decompression is capped at 64 MiB; a corrupt tail truncates with a warning
/// instead of failing the parse.
///
/// Options: `max_results` (cap 4096, default 256).
#[wasm_bindgen]
pub fn fsevents_parse(bytes: &[u8], options_json: &str) -> String {
    dispatch::<fsevents::FseventsOptions, _>(bytes, options_json, "fsevents", fsevents::run)
}

/// Parse one `.tracev3` unified-log file: header metadata (mach timebase,
/// boot UUID, build, hardware model, timezone), catalog statistics, and
/// reconstructed log entries `{timestamp, process, subsystem, category,
/// level, message}` capped at 4096. The module is byte-only: uuidtext/dsc
/// string tables and timesync records are unavailable, so unresolved format
/// strings surface as explicit `<Missing message data>` markers plus a
/// counted warning — never silently dropped.
///
/// Options: `max_results` (cap 4096, default 256).
#[wasm_bindgen]
pub fn unified_log_parse(bytes: &[u8], options_json: &str) -> String {
    dispatch::<tracev3::TraceOptions, _>(bytes, options_json, "unified_log", tracev3::run)
}

/// Parse one `.DS_Store` file: buddy-allocator header and TOC, the `DSDB`
/// superblock (root node, level count, record count, page size), then a
/// depth-limited (<=4) B-tree walk yielding `{filename, code, type, value}`
/// records capped at 4096. `blob` values render as `{length, sha256,
/// preview}`; `Iloc` blobs decode to `{x, y}`; `bwsp`/`lsvp`/`lsvP`/`icvp`
/// blobs decode inline as bounded plist JSON. Visited-node tracking makes
/// cyclic block graphs safe.
///
/// Options: `max_results` (cap 4096, default 256).
#[wasm_bindgen]
pub fn ds_store_parse(bytes: &[u8], options_json: &str) -> String {
    dispatch::<dsstore::DsStoreOptions, _>(bytes, options_json, "ds_store", dsstore::run)
}

fn detect_kind(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"bplist") || plistdoc::looks_like_xml_plist(bytes) {
        return "plist";
    }
    if bytes.starts_with(&[0x1f, 0x8b])
        || bytes.starts_with(b"1SLD")
        || bytes.starts_with(b"2SLD")
        || bytes.starts_with(b"3SLD")
    {
        return "fsevents";
    }
    if bytes.len() >= 8 && bytes[4..8] == *b"Bud1" {
        return "ds_store";
    }
    if tracev3::looks_like_tracev3(bytes) {
        return "unified_log";
    }
    "unknown"
}

/// Bounded string copy used by every artifact parser.
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

/// SHA-256 of a byte slice as lowercase hex.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Lowercase hex of at most `PREVIEW_BYTES` leading bytes.
pub(crate) fn hex_preview(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(PREVIEW_BYTES * 2);
    for byte in bytes.iter().take(PREVIEW_BYTES) {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Clamp a caller-supplied limit to `[1, cap]`.
pub(crate) fn clamp_limit(value: Option<u64>, default: usize, cap: usize) -> usize {
    value
        .map(|v| usize::try_from(v).unwrap_or(usize::MAX))
        .unwrap_or(default)
        .clamp(1, cap)
}
