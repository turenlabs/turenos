//! Bounded, offline Java `.class` and `.jar` static inspection for TurenOS
//! triage — the JVM counterpart to the `monodis` (.NET CIL) target. The
//! class-file parser, constant-pool model, bytecode disassembler, and JAR
//! walker are original parse-only code: no class is ever loaded, verified,
//! or executed, and the module has no network, filesystem, or process
//! access. Malformed input degrades to stable error JSON or explicit
//! `// WARNING` markers — nothing is silently skipped.

mod classfile;
mod disasm;
mod inspect;
mod jar;
mod opcode;

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
/// Hard bound on collected lists (fields, methods, interfaces, findings,
/// constant-pool dump entries, jar entry table).
pub(crate) const MAX_RESULTS: usize = 4096;
/// Per-value cap on a single reported string (names, descriptors, CP text).
pub(crate) const MAX_STRING_CHARS: usize = 1024;
/// Bound on decoded annotation elements across one annotation array.
pub(crate) const MAX_ANNOTATION_ELEMENTS: usize = 512;
/// Bound on rendered tableswitch/lookupswitch cases per instruction.
pub(crate) const MAX_SWITCH_CASES: usize = 4096;
/// Bound on anomaly/warning strings.
pub(crate) const MAX_WARNINGS: usize = 64;
/// Bound on decompressed MANIFEST.MF bytes inside a JAR.
pub(crate) const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
/// Bound on one selected JAR entry's decompressed size.
pub(crate) const MAX_ENTRY_BYTES: u64 = MAX_INPUT_BYTES as u64;
/// Bound on JAR central-directory entries walked for statistics.
pub(crate) const MAX_JAR_SCAN: usize = 65536;
/// Bound on generated disassembly text (spec: ~2 MiB).
pub(crate) const MAX_DISASM_BYTES: usize = 2 * 1024 * 1024;

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

pub(crate) type OpResult = Result<serde_json::Value, Fail>;

pub(crate) fn error_json(code: &str) -> String {
    serde_json::json!({ "schema_version": 1, "error": code }).to_string()
}

/// Fail -> its JSON object form (also used to embed a sub-operation's error
/// inside a JAR `selected_entry` report).
pub(crate) fn fail_value(fail: Fail) -> serde_json::Value {
    let mut object = serde_json::Map::new();
    object.insert("schema_version".to_string(), 1.into());
    object.insert("error".to_string(), fail.code.into());
    object.extend(fail.extra);
    serde_json::Value::Object(object)
}

fn fail_json(fail: Fail) -> String {
    fail_value(fail).to_string()
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
fn dispatch<T, F>(bytes: &[u8], options_json: &str, op: F) -> String
where
    T: DeserializeOwned + Default,
    F: FnOnce(&[u8], &T) -> OpResult,
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
        op(bytes, &options)
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

/// Parse one `.class` file: version (major/minor -> JDK name), access flags,
/// this/super class, interfaces, constant-pool tag summary (full bounded dump
/// via `dump_constant_pool`), fields, methods with Code metrics, class
/// attributes (SourceFile, InnerClasses, Signature, annotations summary),
/// bootstrap methods (invokedynamic/lambda targets), and a findings array for
/// reflection, Unsafe, ClassLoader.defineClass, ProcessBuilder/Runtime.exec,
/// native methods, serialization, and script-engine references — each tagged
/// with its constant-pool index.
///
/// Options: `dump_constant_pool` (default false), `max_entries` (cap 4096).
#[wasm_bindgen]
pub fn class_inspect(bytes: &[u8], options_json: &str) -> String {
    dispatch::<inspect::InspectOptions, _>(bytes, options_json, |b, o| {
        inspect::run(b, o)
    })
}

/// javap-style bytecode listing for one class (all methods with Code) or one
/// method selected by `method_index`/`method_name`. Constant-pool references
/// resolve inline as `// ...` comments. Unknown opcodes and truncated
/// operands emit explicit `// WARNING` markers; listing text is capped at
/// 2 MiB with a `truncated` flag.
///
/// Options: `method_index`, `method_name` (exact match, all overloads),
/// `max_methods` (cap 4096).
#[wasm_bindgen]
pub fn class_disassemble(bytes: &[u8], options_json: &str) -> String {
    dispatch::<disasm::DisasmOptions, _>(bytes, options_json, |b, o| {
        disasm::run(b, o)
    })
}

/// JAR (ZIP) inspection: bounded entry table, META-INF/MANIFEST.MF decoded
/// (256 KiB cap, main attributes + digest attributes parsed), signing files
/// (.SF/.RSA/.DSA/.EC listed), .class entry count, multi-release flag, and
/// module-info.class presence. `entry_index` decompresses exactly one entry
/// (32 MiB cap) and embeds its `class_inspect` report — the
/// retrieve-one-entry path. Entries are read one at a time; nothing is
/// written to disk.
///
/// Options: `max_entries` (cap 4096), `entry_index` (optional).
#[wasm_bindgen]
pub fn jar_inspect(bytes: &[u8], options_json: &str) -> String {
    dispatch::<jar::JarOptions, _>(bytes, options_json, |b, o| jar::run(b, o))
}

/// Truncate to `limit` bytes on a char boundary.
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
