//! capa rule YAML -> normalized rule JSON compiler.
//!
//! This module is shared by `build.rs` (via `#[path]` include) and the unit
//! tests (`#[cfg(test)] mod ruledoc`). It converts one capa-rules YAML document
//! into the compact normalized form stored in the embedded rules blob:
//!
//! ```text
//! rule    -> {"name":..,"ns":..,"lib":bool,"scope":..,"dyn":..,"desc":..,
//!             "attack":[..],"mbc":[..],"file":..,"tree":<node>}
//! node    -> ["and",[node..]] | ["or",[node..]] | ["not",[node..]]
//!          | ["opt",[node..]] | ["some",n,[node..]]
//!          | ["count",node,min,max]            (max = -1 -> unbounded)
//!          | ["sub",scope,[node..]]            (basic block/call/instruction/...)
//!          | ["f",kind,value,desc?]            (leaf feature)
//!          | ["re",pattern,flags,desc?]        (string regex leaf)
//!          | ["m",target]                      (match rule name / namespace)
//!          | ["bad",detail]                    (unparseable -> unsupported leaf)
//! ```
//!
//! Everything here is a pure data normalization step; feature-set matching
//! lives in src/eval.rs. The encoding intentionally stays close to capa's rule
//! grammar (doc/format.md in the capa-rules repository).

use serde_json::{json, Value};
// YAML input documents are serde_norway values (Sequence/Mapping variants);
// the normalized output tree is serde_json. Keep the two `Value` types
// distinct: `Value` below is always the *output* JSON type, `YamlValue` the
// *input* document type.
use serde_norway::Value as YamlValue;

/// Known leaf feature kinds written verbatim (after ` = ` description split).
const LEAF_KINDS: &[&str] = &[
    "api",
    "import",
    "export",
    "section",
    "format",
    "os",
    "arch",
    "bytes",
    "number",
    "offset",
    "mnemonic",
    "characteristic",
    "class",
    "namespace",
    "function-name",
    "property",
    "property/read",
    "property/write",
    "com/class",
    "com/interface",
];

/// Statement keys that introduce a child scope the static subset cannot enter.
const SUBSCOPES: &[&str] = &[
    "basic block",
    "call",
    "instruction",
    "function",
    "process",
    "thread",
    "span of calls",
];

/// Compile one YAML document into a normalized rule object.
/// `file` is the rule's path relative to the capa-rules checkout.
pub fn rule_to_json(file: &str, yaml: &str) -> Result<Value, String> {
    let document: YamlValue =
        serde_norway::from_str(yaml).map_err(|error| format!("yaml: {error}"))?;
    let root = document
        .get("rule")
        .ok_or_else(|| "missing top-level `rule` key".to_string())?;
    let meta = root
        .get("meta")
        .ok_or_else(|| "missing `rule.meta`".to_string())?;
    let features = root
        .get("features")
        .ok_or_else(|| "missing `rule.features`".to_string())?;

    let name = scalar_to_string(
        meta.get("name")
            .ok_or_else(|| "missing `rule.meta.name`".to_string())?,
    );
    if name.is_empty() {
        return Err("empty `rule.meta.name`".to_string());
    }

    let (scope, dynamic) = parse_scopes(meta);

    let mut rule = serde_json::Map::new();
    rule.insert("name".into(), json!(name));
    if let Some(namespace) = meta.get("namespace").and_then(YamlValue::as_str) {
        rule.insert("ns".into(), json!(namespace));
    }
    if let Some(lib) = meta.get("lib").and_then(YamlValue::as_bool) {
        rule.insert("lib".into(), json!(lib));
    }
    rule.insert("scope".into(), json!(scope));
    rule.insert("dyn".into(), json!(dynamic));
    if let Some(description) = meta.get("description").and_then(YamlValue::as_str) {
        let trimmed = description.trim();
        if !trimmed.is_empty() {
            rule.insert("desc".into(), json!(trimmed));
        }
    }
    for (meta_key, out_key) in [("att&ck", "attack"), ("mbc", "mbc")] {
        if let Some(list) = meta.get(meta_key).and_then(YamlValue::as_sequence) {
            let entries: Vec<Value> = list
                .iter()
                .map(scalar_to_string)
                .filter(|entry| !entry.is_empty())
                .map(Value::from)
                .collect();
            if !entries.is_empty() {
                rule.insert(out_key.into(), json!(entries));
            }
        }
    }
    rule.insert("file".into(), json!(file));

    let tree = compile_statement_list(features)?;
    rule.insert("tree".into(), tree);
    Ok(Value::Object(rule))
}

fn parse_scopes(meta: &YamlValue) -> (String, String) {
    if let Some(scopes) = meta.get("scopes") {
        let static_scope = scopes
            .get("static")
            .map(scalar_to_string)
            .filter(|scope| !scope.is_empty());
        let dynamic_scope = scopes
            .get("dynamic")
            .map(scalar_to_string)
            .filter(|scope| !scope.is_empty());
        if static_scope.is_some() || dynamic_scope.is_some() {
            return (
                static_scope.unwrap_or_else(|| "unsupported".into()),
                dynamic_scope.unwrap_or_else(|| "unsupported".into()),
            );
        }
    }
    // pre-`scopes` rules used a single `scope:` key applying to both flavors
    if let Some(scope) = meta.get("scope").and_then(YamlValue::as_str) {
        return (scope.to_string(), scope.to_string());
    }
    ("unsupported".into(), "unsupported".into())
}

/// Compile a YAML sequence (or a single mapping, tolerated) into a node array.
fn compile_statement_list(value: &YamlValue) -> Result<Value, String> {
    let items: Vec<&YamlValue> = match value {
        YamlValue::Sequence(items) => items.iter().collect(),
        YamlValue::Mapping(_) => vec![value],
        other => {
            return Err(format!("expected statement list, got {}", kind_of(other)));
        }
    };
    let mut nodes = Vec::with_capacity(items.len());
    for item in items {
        if let Some(node) = compile_statement(item)? {
            nodes.push(node);
        }
    }
    if nodes.is_empty() {
        return Err("empty statement list".into());
    }
    Ok(Value::Array(nodes))
}

/// Compile one statement list item. Returns Ok(None) for pure-description
/// entries which document a sibling statement but carry no logic.
fn compile_statement(item: &YamlValue) -> Result<Option<Value>, String> {
    let map = match item {
        YamlValue::Mapping(map) => map,
        other => {
            return Ok(Some(json!(["bad", format!("scalar statement {}", kind_of(other))])));
        }
    };

    // Each item is `{key: value}` plus an optional `description:` sibling.
    let mut selected: Option<(&YamlValue, &YamlValue)> = None;
    for (key, value) in map.iter() {
        if key.as_str() == Some("description") {
            continue;
        }
        if selected.is_none() {
            selected = Some((key, value));
        }
    }
    let (key, value) = match selected {
        Some(pair) => pair,
        None => return Ok(None), // only `description:` present
    };
    let key = key
        .as_str()
        .ok_or_else(|| "non-string statement key".to_string())?
        .to_string();

    let node = compile_keyed(&key, value)?;
    Ok(Some(node))
}

fn compile_keyed(key: &str, value: &YamlValue) -> Result<Value, String> {
    match key {
        "and" | "or" | "not" => {
            let children = compile_statement_list(value)?;
            Ok(json!([key, children]))
        }
        "optional" => {
            let children = compile_statement_list(value)?;
            Ok(json!(["opt", children]))
        }
        "match" => {
            let (target, _desc) = split_description(&scalar_to_string(value));
            Ok(json!(["m", target]))
        }
        "string" | "substring" => compile_string_like(key, value),
        _ => {
            if let Some(rest) = key.strip_suffix(" or more") {
                if let Ok(minimum) = rest.trim().parse::<u64>() {
                    let children = compile_statement_list(value)?;
                    return Ok(json!(["some", minimum, children]));
                }
            }
            if key.starts_with("count(") && key.ends_with(')') {
                return compile_count(key, value);
            }
            if SUBSCOPES.contains(&key) {
                let children = compile_statement_list(value)?;
                return Ok(json!(["sub", key, children]));
            }
            if key == "description" {
                return Ok(json!(["bad", "bare description"]));
            }
            if LEAF_KINDS.contains(&key) {
                let (feature_value, desc) = split_description(&scalar_to_string(value));
                return Ok(match desc {
                    Some(desc) => json!(["f", key, feature_value, desc]),
                    None => json!(["f", key, feature_value]),
                });
            }
            // Unknown key: keep it as an unsupported leaf so the rule degrades
            // visibly instead of failing to compile outright.
            Ok(json!(["f", "unsupported", key]))
        }
    }
}

/// `string:` and `substring:` take verbatim values or `/regex/flags` patterns.
/// Inline ` = ` descriptions do not apply to these features (doc/format.md).
fn compile_string_like(key: &str, value: &YamlValue) -> Result<Value, String> {
    let text = scalar_to_string(value);
    if let Some((pattern, flags)) = as_regex(&text) {
        return Ok(json!(["re", pattern, flags, key]));
    }
    Ok(json!(["f", key, text]))
}

/// capa regex syntax: `/pattern/` plus trailing flag characters (capa itself
/// documents only `i`). The last `/` separates flags, so patterns containing
/// `/` are handled like capa's greedy match.
fn as_regex(value: &str) -> Option<(String, String)> {
    if !value.starts_with('/') || value.len() < 2 {
        return None;
    }
    let tail = &value[1..];
    let close = tail.rfind('/')?;
    let flags = &tail[close + 1..];
    if !flags.chars().all(|c| c.is_ascii_alphabetic()) {
        // a `/x/` whose tail is not pure flag letters is a verbatim string
        return None;
    }
    Some((tail[..close].to_string(), flags.to_string()))
}

/// `count(child): range` — the child is written `kind(argument)` inside the
/// parentheses (e.g. `count(mnemonic(mov)): 3 or more`) or as the
/// `basic blocks` pseudo-feature.
fn compile_count(key: &str, value: &YamlValue) -> Result<Value, String> {
    let inner = &key["count(".len()..key.len() - 1];
    let (minimum, maximum) = parse_count_range(&scalar_to_string(value))?;

    let child = if inner == "basic blocks" {
        json!(["f", "basic-blocks", ""])
    } else {
        match inner.find('(') {
            Some(open) if inner.ends_with(')') && open > 0 => {
                let kind = &inner[..open];
                let argument = &inner[open + 1..inner.len() - 1];
                compile_count_child(kind, argument)?
            }
            _ => return Err(format!("malformed count child `{inner}`")),
        }
    };
    Ok(json!(["count", child, minimum, maximum]))
}

fn compile_count_child(kind: &str, argument: &str) -> Result<Value, String> {
    match kind {
        "string" | "substring" => {
            if let Some((pattern, flags)) = as_regex(argument) {
                return Ok(json!(["re", pattern, flags, "string"]));
            }
            // strings do not take inline ` = ` descriptions
            Ok(json!(["f", kind, argument]))
        }
        "match" => Ok(json!(["m", argument])),
        _ if LEAF_KINDS.contains(&kind) => {
            let (feature_value, desc) = split_description(argument);
            Ok(match desc {
                Some(desc) => json!(["f", kind, feature_value, desc]),
                None => json!(["f", kind, feature_value]),
            })
        }
        _ => Err(format!("unsupported count child kind `{kind}`")),
    }
}

/// `3` | `3 or more` | `4 or fewer` | `(2, 10)`
fn parse_count_range(text: &str) -> Result<(i64, i64), String> {
    let text = text.trim();
    if let Some(rest) = text.strip_suffix(" or more") {
        let minimum = rest.trim().parse::<i64>().map_err(|_| "bad count range")?;
        return Ok((minimum, -1));
    }
    if let Some(rest) = text.strip_suffix(" or fewer") {
        let maximum = rest.trim().parse::<i64>().map_err(|_| "bad count range")?;
        return Ok((0, maximum));
    }
    if text.starts_with('(') && text.ends_with(')') {
        let inner = &text[1..text.len() - 1];
        let mut parts = inner.splitn(2, ',');
        let minimum = parts
            .next()
            .and_then(|part| part.trim().parse::<i64>().ok())
            .ok_or_else(|| "bad count range".to_string())?;
        let maximum = parts
            .next()
            .and_then(|part| part.trim().parse::<i64>().ok())
            .ok_or_else(|| "bad count range".to_string())?;
        return Ok((minimum, maximum));
    }
    let exact = text.parse::<i64>().map_err(|_| "bad count range")?;
    Ok((exact, exact))
}

/// Split ` = DESCRIPTION` off a feature value (first occurrence). Never
/// applied to string/substring/regex features.
fn split_description(value: &str) -> (String, Option<String>) {
    match value.split_once(" = ") {
        Some((feature_value, desc)) => (feature_value.trim().to_string(), Some(desc.trim().to_string())),
        None => (value.trim().to_string(), None),
    }
}

fn scalar_to_string(value: &YamlValue) -> String {
    match value {
        YamlValue::String(text) => text.clone(),
        YamlValue::Number(number) => number.to_string(),
        YamlValue::Bool(flag) => flag.to_string(),
        _ => String::new(),
    }
}

fn kind_of(value: &YamlValue) -> &'static str {
    match value {
        YamlValue::Null => "null",
        YamlValue::Bool(_) => "bool",
        YamlValue::Number(_) => "number",
        YamlValue::String(_) => "string",
        YamlValue::Sequence(_) => "sequence",
        YamlValue::Mapping(_) => "mapping",
        _ => "unknown",
    }
}
