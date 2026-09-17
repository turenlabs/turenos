//! Bounded jq-style JSON interrogation for Turen agent tools.
//!
//! Wraps the jaq library crates (jaq-core, jaq-json, jaq-std), a pure-Rust
//! MIT-licensed jq implementation, behind four deterministic wasm-bindgen
//! entry points that accept bytes plus structured options and return bounded
//! JSON. No filesystem, network, environment, clock, or subprocess access is
//! exposed: the `env` and `now` filters are removed at compile time, module
//! loading is unsupported, and `halt` surfaces as a JSON error instead of a
//! process exit.
//!
//! Untrusted filters can still burn unbounded CPU, memory, or stack inside a
//! single evaluation (jaq has no fuel/operation limiter). The result count and
//! serialized output byte caps below always apply, but the host worker must
//! enforce the 60 s wall-clock and memory bounds and terminate the worker on
//! cancellation, per AGENTS.md.
//!
//! Accepted input is the jaq JSON superset (comments via `#`, NaN, Infinity,
//! `+`-prefixed and byte-string literals are accepted) except in
//! `json_validate`, which checks strict RFC 8259 JSON via serde_json.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use jaq_core::data::{DataT, HasLut};
use jaq_core::load::{self, Arena, File, Loader};
use jaq_core::{compile, Compiler, Ctx, Vars};
use jaq_json::{read, Num, Val};
use jaq_std::input::{self, HasInputs, Inputs, RcIter};
use serde::Deserialize;
use wasm_bindgen::prelude::*;

const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
/// Options are capped at 64 KiB for this target (default elsewhere is 1-4 KiB)
/// because jq filters can legitimately be long programs.
const MAX_OPTIONS_BYTES: usize = 64 * 1024;
const MAX_RESULTS: usize = 4096;
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
/// Maximum JSON container nesting accepted on input. The bound is enforced by
/// an iterative byte-level pre-pass before any recursive parser sees the data,
/// so deeply nested input can never overflow the wasm stack.
const MAX_DEPTH: usize = 512;
const MAX_SLURP_VALUES: usize = 1 << 20;
const MAX_STAT_KEYS: usize = 512;
const MAX_MESSAGE_CHARS: usize = 512;
const MAX_KEY_RENDER: usize = 256;
const MAX_PATH_RENDER: usize = 4096;
const MAX_REPORTED_ERRORS: usize = 16;

/// Filter names removed from the compiled environment: `env` would expose host
/// environment variables and `now` reads a wall clock that does not exist (and
/// would trap) under wasm32-unknown-unknown.
const BLOCKED_FILTERS: &[&str] = &["env", "now"];

/// jaq value/data kind carrying the module LUT plus the shared `inputs` stream.
struct JsonKind;

struct RunData<'a> {
    lut: &'a jaq_core::Lut<JsonKind>,
    inputs: Inputs<'a, Val>,
}

impl DataT for JsonKind {
    type V<'a> = Val;
    type Data<'a> = &'a RunData<'a>;
}

impl<'a> HasLut<'a, JsonKind> for &'a RunData<'a> {
    fn lut(&self) -> &'a jaq_core::Lut<JsonKind> {
        self.lut
    }
}

impl<'a> HasInputs<'a, Val> for &'a RunData<'a> {
    fn inputs(&self) -> Inputs<'a, Val> {
        self.inputs
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct QueryOptions {
    filter: Option<String>,
    #[serde(default)]
    slurp: bool,
    #[serde(default)]
    null_input: bool,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    raw_output: bool,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PathsOptions {
    #[serde(default)]
    limit: Option<usize>,
}

/// Evaluate a jq filter over the input JSON values.
///
/// Options: `{filter: string, slurp?: bool, nullInput?: bool,
/// limit?: number, rawOutput?: bool}`.
///
/// Returns `{"schema_version":1,"results":[...],"truncated":bool}` or an error
/// document `{"schema_version":1,"error":"<code>",...}`. With `rawOutput`,
/// result entries are the jq `-r` text rendering (strings unwrapped, other
/// values as compact JSON) so every entry is a JSON string.
#[wasm_bindgen]
pub fn json_query(bytes: &[u8], options_json: &str) -> String {
    if bytes.len() > MAX_INPUT_BYTES {
        return error_json("input_too_large", "input exceeds 32 MiB limit");
    }
    if options_json.len() > MAX_OPTIONS_BYTES {
        return error_json("options_too_large", "options exceed 64 KiB limit");
    }
    let options: QueryOptions = match serde_json::from_str(options_json) {
        Ok(options) => options,
        Err(error) => return error_json("options_invalid", &error.to_string()),
    };
    let filter_src = match options.filter.as_deref() {
        Some(filter) if !filter.is_empty() => filter,
        _ => return error_json("missing_filter", "options.filter must be a non-empty string"),
    };
    if !options.null_input && scan_json(bytes).max_depth > MAX_DEPTH {
        return error_json("input_too_deep", "input nesting exceeds depth limit 512");
    }
    let filter = match compile_filter(filter_src) {
        Ok(filter) => filter,
        Err(json) => return json,
    };
    run_query(bytes, &options, &filter)
}

/// Validate strict RFC 8259 JSON and report token statistics.
///
/// Returns `{"schema_version":1,"valid":bool,"error"?:..,"message"?:..,
/// "line"?:..,"column"?:..,"stats":{bytes,depth,objectCount,arrayCount,
/// scalarCount}}`. Statistics come from an iterative pre-pass; they are exact
/// for valid input and best-effort otherwise.
#[wasm_bindgen]
pub fn json_validate(bytes: &[u8]) -> String {
    if bytes.len() > MAX_INPUT_BYTES {
        return error_json("input_too_large", "input exceeds 32 MiB limit");
    }
    let stats = scan_json(bytes);
    let mut out = String::with_capacity(160);
    out.push_str("{\"schema_version\":1,\"valid\":");
    if stats.max_depth > MAX_DEPTH {
        out.push_str("false,\"error\":\"depth_exceeded\",\"message\":\"input nesting exceeds depth limit 512\"");
    } else {
        // serde_json's own recursion guard is disabled because the iterative
        // pre-pass already enforced MAX_DEPTH; IgnoredAny validates without
        // materializing a Value tree.
        let mut deserializer = serde_json::Deserializer::from_slice(bytes);
        deserializer.disable_recursion_limit();
        let result = serde::de::IgnoredAny::deserialize(&mut deserializer)
            .and_then(|_| deserializer.end());
        match result {
            Ok(()) => out.push_str("true"),
            Err(error) => {
                out.push_str("false,\"error\":\"invalid_json\",\"message\":");
                push_json_str(&mut out, &clip(&error.to_string(), MAX_MESSAGE_CHARS));
                let _ = write!(out, ",\"line\":{},\"column\":{}", error.line(), error.column());
            }
        }
    }
    out.push_str(",\"stats\":{");
    let _ = write!(
        out,
        "\"bytes\":{},\"depth\":{},\"objectCount\":{},\"arrayCount\":{},\"scalarCount\":{}",
        bytes.len(), stats.max_depth, stats.objects, stats.arrays, stats.scalars
    );
    out.push_str("}}");
    out
}

/// Summarize the top-level shape of a JSON document for agent orientation.
///
/// Returns `{"schema_version":1,"type":..,"bytes":..,"length"?:..,"keys"?:[..],
/// "keyTypes"?:{..},"valueTypes"?:{..},"elementTypes"?:{..},"truncated":bool}`.
#[wasm_bindgen]
pub fn json_stats(bytes: &[u8]) -> String {
    if bytes.len() > MAX_INPUT_BYTES {
        return error_json("input_too_large", "input exceeds 32 MiB limit");
    }
    if scan_json(bytes).max_depth > MAX_DEPTH {
        return error_json("input_too_deep", "input nesting exceeds depth limit 512");
    }
    let value = match read::parse_single(bytes) {
        Ok(value) => value,
        Err(error) => {
            return error_json(
                "input_parse_error",
                &clip(&error.to_string(), MAX_MESSAGE_CHARS),
            )
        }
    };
    let mut out = String::with_capacity(256);
    out.push_str("{\"schema_version\":1,\"type\":");
    push_json_str(&mut out, type_tag(&value));
    let _ = write!(out, ",\"bytes\":{}", bytes.len());
    let mut truncated = false;
    match &value {
        Val::Obj(object) => {
            let _ = write!(out, ",\"length\":{}", object.len());
            out.push_str(",\"keys\":[");
            for (index, (key, _)) in object.iter().take(MAX_STAT_KEYS).enumerate() {
                if index > 0 {
                    out.push(',');
                }
                push_json_str(&mut out, &key_text(key));
            }
            out.push_str("],\"keyTypes\":{");
            for (index, (key, child)) in object.iter().take(MAX_STAT_KEYS).enumerate() {
                if index > 0 {
                    out.push(',');
                }
                push_json_str(&mut out, &key_text(key));
                out.push(':');
                push_json_str(&mut out, type_tag(child));
            }
            out.push('}');
            truncated = object.len() > MAX_STAT_KEYS;
            out.push_str(",\"valueTypes\":");
            push_histogram(&mut out, object.iter().map(|(_, child)| child));
        }
        Val::Arr(array) => {
            let _ = write!(out, ",\"length\":{}", array.len());
            out.push_str(",\"elementTypes\":");
            push_histogram(&mut out, array.iter());
        }
        _ => {}
    }
    let _ = write!(out, ",\"truncated\":{truncated}}}");
    if out.len() > MAX_OUTPUT_BYTES {
        return error_json("output_too_large", "serialized output exceeds 4 MiB limit");
    }
    out
}

/// Enumerate leaf paths (scalars and empty containers) with type tags.
///
/// Options: `{limit?: number}` clamped to 0..=4096 (default 4096).
/// Returns `{"schema_version":1,"paths":[{"path":..,"type":..},..],
/// "count":n,"truncated":bool}`.
#[wasm_bindgen]
pub fn json_paths(bytes: &[u8], options_json: &str) -> String {
    if bytes.len() > MAX_INPUT_BYTES {
        return error_json("input_too_large", "input exceeds 32 MiB limit");
    }
    if options_json.len() > MAX_OPTIONS_BYTES {
        return error_json("options_too_large", "options exceed 64 KiB limit");
    }
    let options: PathsOptions = match serde_json::from_str(options_json) {
        Ok(options) => options,
        Err(error) => return error_json("options_invalid", &error.to_string()),
    };
    if scan_json(bytes).max_depth > MAX_DEPTH {
        return error_json("input_too_deep", "input nesting exceeds depth limit 512");
    }
    let value = match read::parse_single(bytes) {
        Ok(value) => value,
        Err(error) => {
            return error_json(
                "input_parse_error",
                &clip(&error.to_string(), MAX_MESSAGE_CHARS),
            )
        }
    };
    let limit = options.limit.map_or(MAX_RESULTS, |l| l.min(MAX_RESULTS));
    let mut out = String::with_capacity(1024);
    out.push_str("{\"schema_version\":1,\"paths\":[");
    let mut count = 0usize;
    let mut truncated = false;
    // Iterative DFS; every stack entry is a subtree root that yields >=1 leaf,
    // so a non-empty stack at stop time means more leaves exist.
    let mut stack: Vec<(String, &Val)> = vec![(String::from("."), &value)];
    'walk: while let Some((path, node)) = stack.pop() {
        match node {
            Val::Arr(array) if !array.is_empty() => {
                for (index, child) in array.iter().enumerate().rev() {
                    let mut child_path = path.clone();
                    let _ = write!(child_path, "[{index}]");
                    stack.push((clip_path(child_path), child));
                }
            }
            Val::Obj(object) if !object.is_empty() => {
                for (key, child) in object.iter().rev() {
                    stack.push((clip_path(path_key_segment(&path, key)), child));
                }
            }
            _ => {
                if count >= limit {
                    truncated = true;
                    break 'walk;
                }
                if out.len() > MAX_OUTPUT_BYTES - 256 {
                    truncated = true;
                    break 'walk;
                }
                if count > 0 {
                    out.push(',');
                }
                out.push_str("{\"path\":");
                push_json_str(&mut out, &path);
                out.push_str(",\"type\":");
                push_json_str(&mut out, type_tag(node));
                out.push('}');
                count += 1;
            }
        }
    }
    truncated = truncated || !stack.is_empty();
    let _ = write!(out, "],\"count\":{count},\"truncated\":{truncated}}}");
    if out.len() > MAX_OUTPUT_BYTES {
        return error_json("output_too_large", "serialized output exceeds 4 MiB limit");
    }
    out
}

/// Compile the filter source with the core+std+json environment.
fn compile_filter(code: &str) -> Result<jaq_core::Filter<JsonKind>, String> {
    let defs = jaq_core::defs()
        .chain(jaq_std::defs())
        .chain(jaq_json::defs());
    let loader = Loader::new(defs);
    let arena = Arena::default();
    let program = File { code, path: () };
    // Module loading resolves to an error inside the loader; `import`/`include`
    // in a filter therefore reports a clean load error instead of touching a
    // filesystem.
    let modules = loader
        .load(&arena, program)
        .map_err(|errors| load_errors_json("filter_parse_error", &errors))?;
    let input_funs = input::funs::<JsonKind>()
        .into_vec()
        .into_iter()
        .map(jaq_core::native::run::<JsonKind>);
    let funs = jaq_core::funs::<JsonKind>()
        .chain(jaq_std::funs::<JsonKind>())
        .chain(jaq_json::funs::<JsonKind>())
        .chain(input_funs)
        .filter(|(name, _, _)| !BLOCKED_FILTERS.contains(name));
    Compiler::default()
        .with_funs(funs)
        .compile(modules)
        .map_err(|errors| compile_errors_json(&errors))
}

/// Run a compiled filter over the input bytes, honoring slurp/nullInput.
fn run_query(bytes: &[u8], options: &QueryOptions, filter: &jaq_core::Filter<JsonKind>) -> String {
    let limit = options.limit.map_or(MAX_RESULTS, |l| l.min(MAX_RESULTS));

    // Root inputs to the filter. In default mode values stream lazily through
    // the shared RcIter so `input`/`inputs` inside a filter see the remaining
    // documents, matching jq. In slurp/nullInput mode the stream is empty and
    // the single root is the collected array or null.
    let mut roots: Vec<Val> = Vec::new();
    if options.null_input {
        roots.push(Val::Null);
    } else if options.slurp {
        let mut values = Vec::new();
        for item in read::parse_many(bytes) {
            match item {
                Ok(value) => {
                    if values.len() >= MAX_SLURP_VALUES {
                        return error_json(
                            "too_many_input_values",
                            "input document count exceeds slurp limit",
                        );
                    }
                    values.push(value);
                }
                Err(error) => {
                    return error_json(
                        "input_parse_error",
                        &clip(&error.to_string(), MAX_MESSAGE_CHARS),
                    )
                }
            }
        }
        roots.push(values.into_iter().collect());
    }
    let parse_iter: Box<dyn Iterator<Item = Result<Val, String>> + '_> = if roots.is_empty() {
        Box::new(read::parse_many(bytes).map(|r| r.map_err(|e| e.to_string())))
    } else {
        Box::new(core::iter::empty())
    };
    let inputs = RcIter::new(parse_iter);
    let data = RunData {
        lut: &filter.lut,
        inputs: &inputs,
    };
    let ctx = Ctx::<JsonKind>::new(&data, Vars::new([]));

    let mut results = String::new();
    let mut count = 0usize;
    let mut truncated = false;
    let mut warning: Option<&'static str> = None;
    let mut pending_error: Option<(String, String)> = None;
    let mut index = 0usize;

    'inputs: loop {
        let next = if index < roots.len() {
            index += 1;
            Some(Ok(roots[index - 1].clone()))
        } else {
            (&inputs).next()
        };
        let input = match next {
            None => break,
            Some(Ok(value)) => value,
            Some(Err(error)) => {
                pending_error = Some((
                    "input_parse_error".to_string(),
                    clip(&error, MAX_MESSAGE_CHARS),
                ));
                break;
            }
        };
        for item in filter.id.run((ctx.clone(), input)) {
            match item {
                Ok(value) => {
                    if count >= limit {
                        truncated = true;
                        break 'inputs;
                    }
                    let mut piece = String::new();
                    if options.raw_output {
                        let text = match &value {
                            Val::TStr(text) => String::from_utf8_lossy(text).into_owned(),
                            other => {
                                let mut rendered = String::new();
                                let _ = write_val(other, &mut rendered);
                                rendered
                            }
                        };
                        push_json_str(&mut piece, &text);
                    } else if write_val(&value, &mut piece).is_err() {
                        truncated = true;
                        warning = Some("result_too_large");
                        break 'inputs;
                    }
                    if results.len() + piece.len() + 1 > MAX_OUTPUT_BYTES - 256 {
                        truncated = true;
                        warning = Some("output_bytes_limit");
                        break 'inputs;
                    }
                    if count > 0 {
                        results.push(',');
                    }
                    results.push_str(&piece);
                    count += 1;
                }
                Err(exception) => {
                    pending_error = Some(exception_fields(exception));
                    break 'inputs;
                }
            }
        }
    }

    let mut out = String::with_capacity(results.len() + 160);
    if let Some((code, message)) = pending_error {
        out.push_str("{\"schema_version\":1,\"error\":");
        push_json_str(&mut out, &code);
        out.push_str(",\"message\":");
        push_json_str(&mut out, &message);
        out.push_str(",\"results\":[");
        out.push_str(&results);
        out.push(']');
        let _ = write!(out, ",\"resultCount\":{count}}}");
        return out;
    }
    out.push_str("{\"schema_version\":1,\"results\":[");
    out.push_str(&results);
    out.push(']');
    let _ = write!(out, ",\"truncated\":{truncated}");
    if options.raw_output {
        out.push_str(",\"raw\":true");
    }
    if let Some(warning) = warning {
        out.push_str(",\"warning\":");
        push_json_str(&mut out, warning);
    }
    out.push('}');
    out
}

/// Map an evaluation exception to a stable error code and message without ever
/// calling `unwrap_valr` (which would exit the process on `halt`).
fn exception_fields(exception: jaq_core::Exn<'_, Val>) -> (String, String) {
    match exception.get_err() {
        Ok(error) => (
            "eval_error".to_string(),
            clip(&error.to_string(), MAX_MESSAGE_CHARS),
        ),
        Err(exception) => match exception.get_halt() {
            Ok(code) => ("halted".to_string(), format!("halt({code})")),
            Err(_) => (
                "internal_exception".to_string(),
                "internal filter control-flow exception".to_string(),
            ),
        },
    }
}

/// Render load (lex/parse/io) errors with byte positions in the filter source.
fn load_errors_json(code: &str, errors: &load::Errors<&str, ()>) -> String {
    let mut details = String::new();
    let mut reported = 0usize;
    for (file, error) in errors {
        let whole = file.code;
        match error {
            load::Error::Io(list) => {
                for (span, message) in list.iter().take(MAX_REPORTED_ERRORS) {
                    push_error_detail(&mut details, &mut reported, message, whole, span);
                }
            }
            load::Error::Lex(list) => {
                for (expect, span) in list.iter().take(MAX_REPORTED_ERRORS) {
                    let message = format!("lex error: {expect:?}");
                    push_error_detail(&mut details, &mut reported, &message, whole, span);
                }
            }
            load::Error::Parse(list) => {
                for (expect, span) in list.iter().take(MAX_REPORTED_ERRORS) {
                    let message = format!("parse error: {expect:?}");
                    push_error_detail(&mut details, &mut reported, &message, whole, span);
                }
            }
        }
    }
    let mut out = String::with_capacity(details.len() + 96);
    out.push_str("{\"schema_version\":1,\"error\":");
    push_json_str(&mut out, code);
    out.push_str(",\"errors\":[");
    out.push_str(&details);
    out.push_str("]}");
    out
}

/// Render compile (undefined symbol) errors with byte positions.
fn compile_errors_json(errors: &compile::Errors<&str, ()>) -> String {
    let mut details = String::new();
    let mut reported = 0usize;
    for (file, list) in errors {
        let whole = file.code;
        for (span, undefined) in list.iter().take(MAX_REPORTED_ERRORS) {
            let message = match undefined {
                compile::Undefined::Filter(arity) => {
                    format!("undefined filter {span}/{arity}")
                }
                other => format!("undefined {} {span}", other.as_str()),
            };
            push_error_detail(&mut details, &mut reported, &message, whole, span);
        }
    }
    let mut out = String::with_capacity(details.len() + 96);
    out.push_str("{\"schema_version\":1,\"error\":\"filter_compile_error\",\"errors\":[");
    out.push_str(&details);
    out.push_str("]}");
    out
}

fn push_error_detail(
    details: &mut String,
    reported: &mut usize,
    message: &str,
    whole: &str,
    span: &str,
) {
    if *reported >= MAX_REPORTED_ERRORS {
        return;
    }
    if *reported > 0 {
        details.push(',');
    }
    details.push_str("{\"message\":");
    push_json_str(details, &clip(message, MAX_MESSAGE_CHARS));
    if let Some((start, end)) = span_range(whole, span) {
        let _ = write!(details, ",\"offset\":{start},\"end\":{end}");
    }
    details.push('}');
    *reported += 1;
}

/// Byte range of a lex/parse/compile span inside the filter source. jaq spans
/// are &str subslices of the file contents; returns None for spans pointing
/// into other files (e.g. the prelude).
fn span_range(whole: &str, part: &str) -> Option<(usize, usize)> {
    let base = whole.as_ptr() as usize;
    let start = part.as_ptr() as usize;
    let end = start.checked_add(part.len())?;
    if start >= base && end <= base.checked_add(whole.len())? {
        Some((start - base, end - base))
    } else {
        None
    }
}

struct Scan {
    max_depth: usize,
    objects: usize,
    arrays: usize,
    scalars: usize,
}

/// Iterative byte-level scan computing container depth and token counts.
/// String contents and escapes are skipped correctly, and `#` line comments
/// (accepted by the jaq input superset) are honored. Best-effort on malformed
/// input: never fails, never allocates beyond a depth-sized stack.
fn scan_json(bytes: &[u8]) -> Scan {
    const OBJECT_KEY: u8 = b'{';
    const OBJECT_VALUE: u8 = b':';
    const ARRAY: u8 = b'[';
    let mut stack: Vec<u8> = Vec::with_capacity(64);
    let mut scan = Scan {
        max_depth: 0,
        objects: 0,
        arrays: 0,
        scalars: 0,
    };
    let mut in_string = false;
    let mut escaped = false;
    let mut i = 0usize;
    let value_position = |stack: &[u8]| {
        stack
            .last()
            .map_or(true, |level| *level == OBJECT_VALUE || *level == ARRAY)
    };
    while i < bytes.len() {
        let byte = bytes[i];
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
                // A closing string in value position is a scalar value; in
                // object-key position it is a key (not counted).
                if value_position(&stack) {
                    scan.scalars += 1;
                }
            }
            i += 1;
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'#' => {
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
                continue;
            }
            b'{' => {
                scan.objects += 1;
                stack.push(OBJECT_KEY);
                scan.max_depth = scan.max_depth.max(stack.len());
            }
            b'[' => {
                scan.arrays += 1;
                stack.push(ARRAY);
                scan.max_depth = scan.max_depth.max(stack.len());
            }
            b':' => {
                if let Some(top) = stack.last_mut() {
                    if *top == OBJECT_KEY {
                        *top = OBJECT_VALUE;
                    }
                }
            }
            b',' => {
                if let Some(top) = stack.last_mut() {
                    if *top == OBJECT_VALUE {
                        *top = OBJECT_KEY;
                    }
                }
            }
            b'}' | b']' => {
                stack.pop();
            }
            b' ' | b'\t' | b'\n' | b'\r' => {}
            _ => {
                // Bare token (number/true/false/null or invalid text).
                if value_position(&stack) {
                    scan.scalars += 1;
                }
                i += 1;
                while i < bytes.len()
                    && !matches!(
                        bytes[i],
                        b',' | b':'
                            | b'}'
                            | b']'
                            | b'{'
                            | b'['
                            | b'"'
                            | b'#'
                            | b' '
                            | b'\t'
                            | b'\n'
                            | b'\r'
                    )
                {
                    i += 1;
                }
                continue;
            }
        }
        i += 1;
    }
    scan
}

enum SerTask<'a> {
    Val(&'a Val),
    Key(&'a Val),
    Byte(u8),
}

/// Iterative serializer from jaq Val to strict JSON text.
///
/// Differences from jaq's own writer: output is always valid JSON and UTF-8 —
/// byte strings become `{"$bytes":"<hex>"}`, non-string object keys render as
/// their JSON representation, non-finite floats become `null`, and invalid
/// UTF-8 inside text strings is replaced by U+FFFD. Returns Err when the
/// output exceeds the 4 MiB bound; the caller drops that result.
fn write_val(root: &Val, out: &mut String) -> Result<(), ()> {
    let mut stack: Vec<SerTask> = Vec::with_capacity(64);
    stack.push(SerTask::Val(root));
    while let Some(task) = stack.pop() {
        if out.len() > MAX_OUTPUT_BYTES {
            return Err(());
        }
        match task {
            SerTask::Byte(byte) => out.push(byte as char),
            SerTask::Key(key) => {
                out.push('"');
                match key {
                    Val::TStr(text) => push_escaped(&mut *out, text),
                    other => {
                        let mut rendered = String::new();
                        if write_val_limited(other, &mut rendered, MAX_KEY_RENDER).is_err() {
                            rendered.push('…');
                        }
                        push_escaped(out, rendered.as_bytes());
                    }
                }
                out.push('"');
            }
            SerTask::Val(value) => match value {
                Val::Null => out.push_str("null"),
                Val::Bool(true) => out.push_str("true"),
                Val::Bool(false) => out.push_str("false"),
                Val::Num(number) => write_num(out, number),
                Val::TStr(text) => {
                    out.push('"');
                    push_escaped(out, text);
                    out.push('"');
                }
                Val::BStr(bytes) => {
                    out.push_str("{\"$bytes\":\"");
                    push_hex(out, bytes);
                    out.push_str("\"}");
                }
                Val::Arr(array) => {
                    out.push('[');
                    stack.push(SerTask::Byte(b']'));
                    for (index, child) in array.iter().rev().enumerate() {
                        stack.push(SerTask::Val(child));
                        if index + 1 < array.len() {
                            stack.push(SerTask::Byte(b','));
                        }
                    }
                }
                Val::Obj(object) => {
                    out.push('{');
                    stack.push(SerTask::Byte(b'}'));
                    for (index, (key, child)) in object.iter().rev().enumerate() {
                        stack.push(SerTask::Val(child));
                        stack.push(SerTask::Byte(b':'));
                        stack.push(SerTask::Key(key));
                        if index + 1 < object.len() {
                            stack.push(SerTask::Byte(b','));
                        }
                    }
                }
            },
        }
    }
    Ok(())
}

/// Serialize a value into a small buffer with an early byte bound (for object
/// keys and raw text rendering).
fn write_val_limited(value: &Val, out: &mut String, limit: usize) -> Result<(), ()> {
    let result = write_val(value, out);
    if out.len() > limit {
        let mut end = limit;
        while end > 0 && !out.is_char_boundary(end) {
            end -= 1;
        }
        out.truncate(end);
        return Err(());
    }
    result
}

fn write_num(out: &mut String, number: &Num) {
    match number {
        Num::Int(int) => {
            let _ = write!(out, "{int}");
        }
        Num::BigInt(big) => {
            let _ = write!(out, "{big}");
        }
        Num::Float(float) => {
            if float.is_finite() {
                let _ = write!(out, "{float}");
            } else {
                out.push_str("null");
            }
        }
        Num::Dec(dec) => {
            if !dec.is_empty()
                && dec
                    .bytes()
                    .all(|b| matches!(b, b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E'))
            {
                out.push_str(dec);
            } else {
                out.push_str("null");
            }
        }
    }
}

/// Append `bytes` to `out` escaped as JSON string content (no quotes).
/// Invalid UTF-8 is replaced by U+FFFD first so output stays valid UTF-8.
fn push_escaped(out: &mut String, bytes: &[u8]) {
    let text = String::from_utf8_lossy(bytes);
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            ch if (ch as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", ch as u32);
            }
            ch => out.push(ch),
        }
    }
}

fn push_json_str(out: &mut String, text: &str) {
    out.push('"');
    push_escaped(out, text.as_bytes());
    out.push('"');
}

fn push_hex(out: &mut String, bytes: &[u8]) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0xf) as usize] as char);
    }
}

fn type_tag(value: &Val) -> &'static str {
    match value {
        Val::Null => "null",
        Val::Bool(_) => "boolean",
        Val::Num(_) => "number",
        Val::TStr(_) => "string",
        Val::BStr(_) => "bytes",
        Val::Arr(_) => "array",
        Val::Obj(_) => "object",
    }
}

fn key_text(key: &Val) -> String {
    match key {
        Val::TStr(text) => String::from_utf8_lossy(text).into_owned(),
        other => {
            let mut rendered = String::new();
            let _ = write_val_limited(other, &mut rendered, MAX_KEY_RENDER);
            rendered
        }
    }
}

fn push_histogram<'a>(out: &mut String, values: impl Iterator<Item = &'a Val>) {
    let mut histogram: BTreeMap<&'static str, usize> = BTreeMap::new();
    for value in values {
        *histogram.entry(type_tag(value)).or_insert(0) += 1;
    }
    out.push('{');
    for (index, (tag, count)) in histogram.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        push_json_str(out, tag);
        let _ = write!(out, ":{count}");
    }
    out.push('}');
}

/// Child path for an object entry: `.key` for identifier-like keys, else
/// `.["key"]`. The root path is `.` itself, so `.` + `key` renders as `.key`.
fn path_key_segment(path: &str, key: &Val) -> String {
    let text = key_text(key);
    let simple = !text.is_empty()
        && text
            .chars()
            .next()
            .map_or(false, |c| c.is_ascii_alphabetic() || c == '_')
        && text.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if simple {
        if path == "." {
            format!("{path}{text}")
        } else {
            format!("{path}.{text}")
        }
    } else {
        let mut child = String::from(path);
        child.push('[');
        push_json_str(&mut child, &text);
        child.push(']');
        child
    }
}

fn clip_path(path: String) -> String {
    if path.len() <= MAX_PATH_RENDER {
        path
    } else {
        path.chars().take(MAX_PATH_RENDER).collect()
    }
}

fn clip(text: &str, max: usize) -> String {
    if text.len() <= max {
        text.to_string()
    } else {
        text.chars().take(max).collect()
    }
}

fn error_json(code: &str, message: &str) -> String {
    let mut out = String::with_capacity(64 + message.len());
    out.push_str("{\"schema_version\":1,\"error\":");
    push_json_str(&mut out, code);
    out.push_str(",\"message\":");
    push_json_str(&mut out, &clip(message, MAX_MESSAGE_CHARS));
    out.push('}');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn query(bytes: &[u8], options: &str) -> Value {
        serde_json::from_str(&json_query(bytes, options)).expect("response is JSON")
    }

    fn options(filter: &str) -> String {
        format!("{{\"filter\":{}}}", serde_json::to_string(filter).unwrap())
    }

    #[test]
    fn identity_returns_document() {
        let result = query(br#"{"a":[1,2,3],"b":"x"}"#, &options("."));
        assert_eq!(result["results"][0]["a"][1], 2);
        assert_eq!(result["results"][0]["b"], "x");
        assert_eq!(result["truncated"], false);
    }

    #[test]
    fn field_access_and_iteration() {
        let result = query(br#"{"items":[{"n":1},{"n":2}]}"#, &options(".items[].n"));
        assert_eq!(result["results"], serde_json::json!([1, 2]));
        let result = query(b"[10,20,30]", &options(".[] | . + 1"));
        assert_eq!(result["results"], serde_json::json!([11, 21, 31]));
    }

    #[test]
    fn select_map_reduce_group_by() {
        let result = query(b"[1,2,3,4]", &options("map(select(. > 2))"));
        assert_eq!(result["results"], serde_json::json!([[3, 4]]));
        let result = query(b"[1,2,3]", &options("reduce .[] as $x (0; . + $x)"));
        assert_eq!(result["results"], serde_json::json!([6]));
        let result = query(
            br#"[{"k":"a","v":1},{"k":"b","v":2},{"k":"a","v":3}]"#,
            &options("group_by(.k) | map({key: .[0].k, total: map(.v) | add})"),
        );
        assert_eq!(
            result["results"],
            serde_json::json!([[{"key": "a", "total": 4}, {"key": "b", "total": 2}]])
        );
    }

    #[test]
    fn length_keys_recursive_descent() {
        let result = query(br#"{"a":1,"b":[2]}"#, &options("length"));
        assert_eq!(result["results"], serde_json::json!([2]));
        let result = query(br#"{"a":1,"b":[2]}"#, &options("keys"));
        assert_eq!(result["results"], serde_json::json!([["a", "b"]]));
        let result = query(br#"{"a":{"b":{"c":42}},"d":[1,{"c":7}]}"#, &options("[.. | numbers]"));
        assert_eq!(result["results"], serde_json::json!([[42, 1, 7]]));
    }

    #[test]
    fn parse_error_reports_position() {
        let result = query(b"{}", &options(".["));
        assert_eq!(result["error"], "filter_parse_error");
        assert!(result["errors"][0]["offset"].is_number());
    }

    #[test]
    fn compile_error_for_unknown_and_blocked_filters() {
        let result = query(b"{}", &options("nosuchfilter"));
        assert_eq!(result["error"], "filter_compile_error");
        let message = result["errors"][0]["message"].as_str().unwrap_or("");
        assert!(message.contains("nosuchfilter"));

        for blocked in ["env", "now"] {
            let result = query(b"{}", &options(blocked));
            assert_eq!(result["error"], "filter_compile_error", "filter {blocked}");
        }
    }

    #[test]
    fn runtime_and_user_errors() {
        let result = query(b"1", &options(".a"));
        assert_eq!(result["error"], "eval_error");
        let result = query(b"{}", &options("error(\"boom\")"));
        assert_eq!(result["error"], "eval_error");
        assert!(result["message"].as_str().unwrap_or("").contains("boom"));
        let result = query(b"{}", &options("halt"));
        assert_eq!(result["error"], "halted");
    }

    #[test]
    fn slurp_collects_documents() {
        let input = br#"{"a":1}
{"a":2}"#;
        let result = query(input, r#"{"filter":"length","slurp":true}"#);
        assert_eq!(result["results"], serde_json::json!([2]));
        let result = query(input, &options(".a"));
        assert_eq!(result["results"], serde_json::json!([1, 2]));
    }

    #[test]
    fn inputs_filter_consumes_stream() {
        let result = query(b"1 2 3", &options("[., inputs]"));
        assert_eq!(result["results"], serde_json::json!([[1, 2, 3]]));
    }

    #[test]
    fn limit_truncates_results() {
        let result = query(b"[1,2,3,4,5]", r#"{"filter":".[]","limit":3}"#);
        assert_eq!(result["results"], serde_json::json!([1, 2, 3]));
        assert_eq!(result["truncated"], true);
        let result = query(b"[1,2]", r#"{"filter":".[]","limit":10}"#);
        assert_eq!(result["truncated"], false);
    }

    #[test]
    fn null_input_runs_without_parsing() {
        let result = query(b"not json at all", r#"{"filter":"1 + 1","nullInput":true}"#);
        assert_eq!(result["results"], serde_json::json!([2]));
    }

    #[test]
    fn raw_output_wraps_results_as_strings() {
        let result = query(br#"["a",1,null]"#, r#"{"filter":".[]","rawOutput":true}"#);
        assert_eq!(result["results"], serde_json::json!(["a", "1", "null"]));
        assert_eq!(result["raw"], true);
    }

    #[test]
    fn malformed_input_is_error_json() {
        let result = query(b"{bad", &options("."));
        assert_eq!(result["error"], "input_parse_error");
        assert!(result["message"].as_str().unwrap_or("").contains("byte offset"));
        let result = query(b"", &options("."));
        assert_eq!(result["results"], serde_json::json!([]));
    }

    #[test]
    fn deep_input_errors_not_crashes() {
        let deep = vec![b'['; MAX_DEPTH + 8];
        let result = query(&deep, &options("."));
        assert_eq!(result["error"], "input_too_deep");
        let validate: Value = serde_json::from_str(&json_validate(&deep)).unwrap();
        assert_eq!(validate["valid"], false);
        assert_eq!(validate["error"], "depth_exceeded");
        let stats: Value = serde_json::from_str(&json_stats(&deep)).unwrap();
        assert_eq!(stats["error"], "input_too_deep");
        let paths: Value = serde_json::from_str(&json_paths(&deep, "{}")).unwrap();
        assert_eq!(paths["error"], "input_too_deep");
    }

    #[test]
    fn oversized_input_and_options_rejected() {
        let big = vec![0u8; MAX_INPUT_BYTES + 1];
        let result = query(&big, &options("."));
        assert_eq!(result["error"], "input_too_large");
        let long = format!("{{\"filter\":\"{}\"}}", ".".repeat(MAX_OPTIONS_BYTES));
        let result = query(b"1", &long);
        assert_eq!(result["error"], "options_too_large");
        let result = query(b"1", "{}");
        assert_eq!(result["error"], "missing_filter");
        let result = query(b"1", "{bad json");
        assert_eq!(result["error"], "options_invalid");
    }

    #[test]
    fn determinism() {
        let input = br#"{"b":2,"a":[3,1,2]}"#;
        assert_eq!(
            json_query(input, &options(".a | sort")),
            json_query(input, &options(".a | sort"))
        );
    }

    #[test]
    fn validate_stats_and_strictness() {
        let valid: Value =
            serde_json::from_str(&json_validate(br#"{"a":[1,"x",null],"b":{"c":true}}"#)).unwrap();
        assert_eq!(valid["valid"], true);
        assert_eq!(valid["stats"]["objectCount"], 2);
        assert_eq!(valid["stats"]["arrayCount"], 1);
        assert_eq!(valid["stats"]["scalarCount"], 4);
        assert_eq!(valid["stats"]["depth"], 2);

        let invalid: Value = serde_json::from_str(&json_validate(b"{bad")).unwrap();
        assert_eq!(invalid["valid"], false);
        assert_eq!(invalid["error"], "invalid_json");
        assert!(invalid["line"].is_number());

        // strict JSON: NaN and trailing data are invalid
        for bad in [b"NaN".as_slice(), b"1 2".as_slice(), b"[1,]".as_slice()] {
            let parsed: Value = serde_json::from_str(&json_validate(bad)).unwrap();
            assert_eq!(parsed["valid"], false, "input {bad:?}");
        }
    }

    #[test]
    fn stats_shape_summary() {
        let stats: Value =
            serde_json::from_str(&json_stats(br#"{"a":1,"b":"x","c":[true],"d":null}"#)).unwrap();
        assert_eq!(stats["type"], "object");
        assert_eq!(stats["length"], 4);
        assert_eq!(stats["keys"], serde_json::json!(["a", "b", "c", "d"]));
        assert_eq!(stats["keyTypes"]["b"], "string");
        assert_eq!(stats["valueTypes"]["number"], 1);
        let stats: Value = serde_json::from_str(&json_stats(b"[1,2,\"x\"]")).unwrap();
        assert_eq!(stats["type"], "array");
        assert_eq!(stats["elementTypes"]["number"], 2);
        assert_eq!(stats["elementTypes"]["string"], 1);
    }

    #[test]
    fn paths_enumerate_leaves() {
        let paths: Value =
            serde_json::from_str(&json_paths(br#"{"a":{"b":1},"c":[],"d":[{"e":"x"}]}"#, "{}"))
                .unwrap();
        let rendered: Vec<String> = paths["paths"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                format!(
                    "{}:{}",
                    p["path"].as_str().unwrap_or(""),
                    p["type"].as_str().unwrap_or("")
                )
            })
            .collect();
        assert!(rendered.contains(&".a.b:number".to_string()));
        assert!(rendered.contains(&".c:array".to_string()));
        assert!(rendered.contains(&".d[0].e:string".to_string()));
        assert_eq!(paths["truncated"], false);
        let paths: Value =
            serde_json::from_str(&json_paths(b"[1,2,3]", r#"{"limit":2}"#)).unwrap();
        assert_eq!(paths["count"], 2);
        assert_eq!(paths["truncated"], true);
    }

    #[test]
    fn byte_strings_and_nonfinite_numbers_stay_valid_json() {
        // `b"..."` is a byte-string literal in the jaq JSON input superset.
        let result = query(b"b\"ab\"", &options("."));
        assert_eq!(result["results"][0]["$bytes"], "6162");
        let result = query(b"1", &options("nan"));
        assert_eq!(result["results"], serde_json::json!([null]));
        let result = query(b"1", &options("1 / 0"));
        assert_eq!(result["results"], serde_json::json!([null]));
    }

    #[test]
    fn unicode_and_escapes_roundtrip() {
        let result = query(br#""a\"b\nc""#, &options("."));
        assert_eq!(result["results"][0], "a\"b\nc");
    }

    #[test]
    fn regex_and_format_funs_available() {
        let result = query(br#""abc123""#, &options("test(\"[0-9]+\")"));
        assert_eq!(result["results"], serde_json::json!([true]));
        let result = query(br#""hi""#, &options("@base64"));
        assert_eq!(result["results"], serde_json::json!(["aGk="]));
        let result = query(br#""2020-01-01T00:00:00Z""#, &options("fromdateiso8601"));
        assert_eq!(result["results"], serde_json::json!([1577836800]));
    }

    #[test]
    fn output_cap_marks_truncation() {
        // A single result exceeding 4 MiB serialized is dropped and reported
        // as truncation rather than produced or panicking.
        let result = query(b"null", &options("[range(0; 6000000)]"));
        assert_eq!(result["truncated"], true);
        assert_eq!(result["warning"], "result_too_large");
    }
}
