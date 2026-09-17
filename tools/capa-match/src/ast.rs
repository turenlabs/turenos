//! Compiled ruleset: decode the normalized blob into a rule AST, normalize
//! feature values, mark unsupported features, and constant-fold rules that can
//! never match a static raw-byte feature set.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

/// Longest accepted `bytes:` pattern (capa uses 0x100).
pub const MAX_BYTES_PATTERN: usize = 0x100;
/// regex::bytes size cap for a single rule regex (compiled program bytes).
pub const MAX_REGEX_SIZE: usize = 1 << 20;
/// Longest accepted regex/substring/string pattern text.
pub const MAX_PATTERN_CHARS: usize = 4096;
/// Deepest tolerated statement nesting in one rule.
const MAX_NODE_DEPTH: usize = 64;

#[derive(Debug, Clone)]
pub enum Node {
    And(Vec<Node>),
    Or(Vec<Node>),
    Not(Vec<Node>),
    /// `optional:` (min == 0) or `N or more:`.
    SomeOf { min: u64, children: Vec<Node> },
    Count { child: Box<Node>, min: u64, max: u64 },
    /// `basic block:` / `call:` / ... subscope — never satisfiable statically.
    /// Retains the unsupported feature kinds found inside the scope so the
    /// per-rule honesty list can name them.
    Subscope(Vec<String>),
    Feature(Feature),
    Match(MatchTarget),
    /// Constant produced by folding `not` over unsatisfiable children.
    True,
}

#[derive(Debug, Clone)]
pub enum MatchTarget {
    /// `match: <rule name>` — index into Ruleset::rules.
    Rule(usize),
    /// `match: <namespace>` — any rule in the namespace subtree.
    Namespace(String),
    /// Target is neither a known rule nor a known namespace.
    Unresolved(String),
}

#[derive(Debug, Clone)]
pub enum Feature {
    /// `api:` — normalized symbol (dll dropped, ordinals keep `dll.#n`).
    Api(String),
    /// `import:` — candidate strings (raw + dll-normalized).
    Import { raw: String, normalized: String },
    /// `export:` — verbatim name or `dll.symbol` forwarded form.
    Export(String),
    /// `section:` — verbatim section name.
    Section(String),
    /// `format:` / `os:` / `arch:` — lowercase global feature.
    Global(GlobalKind, String),
    /// `string:` — verbatim whole-string equality.
    Str(String),
    /// `substring:` — verbatim substring containment.
    Substring(String),
    /// `string: /re/flags` — regex over extracted strings.
    Regex { source: String, compiled: Option<regex::bytes::Regex> },
    /// `bytes:` — hex pattern, `??` whole-byte wildcards.
    Bytes { display: String, matcher: BytesMatcher },
    /// `characteristic:` — only the file-scope values we can derive.
    Characteristic(Characteristic),
    /// Any feature the static subset cannot produce (mnemonic, number, ...).
    Unsupported { kind: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GlobalKind {
    Format,
    Os,
    Arch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Characteristic {
    EmbeddedPe,
    ForwardedExport,
}

#[derive(Debug, Clone)]
pub enum BytesMatcher {
    /// Pure hex: takes part in the shared Aho-Corasick file scan.
    Exact(Vec<u8>),
    /// Contains wildcards: standalone regex scan.
    Wild(regex::bytes::Regex),
}

#[derive(Debug)]
pub struct Rule {
    pub name: String,
    pub namespace: String,
    pub scope: String,
    pub dynamic_scope: String,
    pub lib: bool,
    pub description: Option<String>,
    pub attack: Vec<String>,
    pub mbc: Vec<String>,
    pub file: String,
    /// Original tree retained only through `degraded`; `root` is pruned.
    pub root: Option<Node>,
    /// True when the un-pruned tree mentioned anything the static subset
    /// cannot evaluate (unsupported feature kinds, subscopes, unresolved or
    /// un-compilable patterns). The pruned tree may still match; such hits
    /// are a reported lower bound, never fabricated.
    pub degraded: bool,
    /// Sorted distinct unsupported feature kinds seen in this rule's tree —
    /// the per-rule honesty list reported alongside `degraded`.
    pub unsupported: Vec<String>,
    pub skip_reason: Option<String>,
}

#[derive(Debug)]
pub struct Ruleset {
    pub commit: String,
    pub imported: bool,
    pub rules: Vec<Rule>,
    pub parse_errors: Vec<(String, String)>,
    pub by_name: HashMap<String, usize>,
    /// namespace -> member rule indices (each rule registers under every
    /// ancestor prefix, so `anti-analysis` also covers `anti-analysis/packer`).
    pub ns_members: HashMap<String, Vec<usize>>,
    /// All pure-hex `bytes:` patterns across rules, for one shared
    /// Aho-Corasick pass per input.
    pub exact_bytes: Vec<Vec<u8>>,
    /// bytes pattern -> index into `exact_bytes` / the AC scan results.
    pub exact_index: HashMap<Vec<u8>, usize>,
    /// Unsupported feature kinds seen while compiling (coverage honesty).
    pub unsupported_kinds: Vec<String>,
}

/// Decode the blob JSON and compile every rule.
pub fn compile(blob: &Value) -> Ruleset {
    let mut set = Ruleset {
        commit: blob.get("commit").and_then(Value::as_str).unwrap_or("").to_string(),
        imported: blob.get("imported").and_then(Value::as_bool).unwrap_or(false),
        rules: Vec::new(),
        parse_errors: Vec::new(),
        by_name: HashMap::new(),
        ns_members: HashMap::new(),
        exact_bytes: Vec::new(),
        exact_index: HashMap::new(),
        unsupported_kinds: Vec::new(),
    };
    if let Some(errors) = blob.get("errors").and_then(Value::as_array) {
        for error in errors {
            let file = error.get("file").and_then(Value::as_str).unwrap_or("?");
            let detail = error.get("error").and_then(Value::as_str).unwrap_or("?");
            set.parse_errors.push((file.to_string(), detail.to_string()));
        }
    }

    let mut unsupported_kinds: HashSet<String> = HashSet::new();
    let mut exact_set: HashSet<Vec<u8>> = HashSet::new();
    let mut exact_bytes: Vec<Vec<u8>> = Vec::new();

    let entries = blob.get("rules").and_then(Value::as_array);
    for entry in entries.into_iter().flatten() {
        let name = entry.get("name").and_then(Value::as_str).unwrap_or("").to_string();
        let scope = entry.get("scope").and_then(Value::as_str).unwrap_or("unsupported").to_string();
        let dynamic_scope = entry.get("dyn").and_then(Value::as_str).unwrap_or("unsupported").to_string();
        let lib = entry.get("lib").and_then(Value::as_bool).unwrap_or(false);
        let namespace = entry.get("ns").and_then(Value::as_str).unwrap_or("").to_string();
        let description = entry.get("desc").and_then(Value::as_str).map(|d| d.chars().take(1024).collect());
        let file = entry.get("file").and_then(Value::as_str).unwrap_or("").to_string();
        let attack = string_list(entry.get("attack"));
        let mbc = string_list(entry.get("mbc"));

        let mut malformed = false;
        let root = match entry.get("tree") {
            Some(tree) => match parse_tree(tree, &mut unsupported_kinds, &mut exact_set, &mut exact_bytes) {
                Ok(node) => Some(node),
                Err(_) => {
                    malformed = true;
                    None
                }
            },
            None => {
                malformed = true;
                None
            }
        };

        set.rules.push(Rule {
            name,
            namespace,
            scope,
            dynamic_scope,
            lib,
            description,
            attack,
            mbc,
            file,
            root,
            degraded: false,
            unsupported: Vec::new(),
            skip_reason: if malformed { Some("malformed-rule".into()) } else { None },
        });
    }

    // Resolve match targets now that all names/namespaces are known.
    for (index, rule) in set.rules.iter().enumerate() {
        if !rule.name.is_empty() {
            set.by_name.entry(rule.name.clone()).or_insert(index);
        }
        if !rule.namespace.is_empty() {
            let mut prefix = String::new();
            for part in rule.namespace.split('/') {
                if !prefix.is_empty() {
                    prefix.push('/');
                }
                prefix.push_str(part);
                set.ns_members.entry(prefix.clone()).or_default().push(index);
            }
        }
    }
    let mut unresolved: HashSet<String> = HashSet::new();
    for rule in &mut set.rules {
        if let Some(root) = &mut rule.root {
            resolve_matches(root, &set.by_name, &set.ns_members, &mut unresolved);
        }
    }
    for target in unresolved {
        unsupported_kinds.insert(format!("unresolved-match:{target}"));
    }

    // With match targets resolved, record each rule's unsupported feature
    // kinds and mark it degraded. This runs before constant folding so the
    // honesty list reflects the rule as written, not the pruned tree.
    // `match:` references to rules outside file scope can never match and
    // degrade the same way.
    let scope_skipped: Vec<bool> = set.rules.iter().map(|rule| rule.scope != "file").collect();
    let ns_members = &set.ns_members;
    for rule in &mut set.rules {
        if let Some(root) = &rule.root {
            let mut kinds: HashSet<String> = HashSet::new();
            collect_unsupported(root, &mut kinds);
            collect_match_scope(root, &scope_skipped, ns_members, &mut kinds);
            rule.unsupported = kinds.into_iter().collect();
            rule.unsupported.sort();
            rule.degraded = !rule.unsupported.is_empty();
        }
    }

    // Only `file` static scope is satisfiable here: every narrower scope
    // (function, basic block, instruction, call, process, thread, span of
    // calls) needs analysis this subset never performs, and a declared
    // `unsupported` scope is an explicit non-goal. Such rules can never
    // match — including via `match:` references — so mark them
    // unsatisfiable up front and let the folding propagate into any
    // file-scope rule that requires them.
    let mut unsatisfiable: HashSet<usize> = HashSet::new();
    for (index, rule) in set.rules.iter_mut().enumerate() {
        if rule.scope != "file" {
            rule.root = None;
            unsatisfiable.insert(index);
        }
    }

    // Constant-fold with unsupported -> false; iterate so that matches on
    // unsatisfiable rules also collapse.
    for _round in 0..8 {
        let before = unsatisfiable.len();
        for (index, rule) in set.rules.iter_mut().enumerate() {
            if unsatisfiable.contains(&index) {
                continue;
            }
            match &rule.root {
                Some(node) => match prune(node, &unsatisfiable) {
                    None => {
                        rule.root = None;
                        unsatisfiable.insert(index);
                    }
                    Some(pruned) => rule.root = Some(pruned),
                },
                None => {
                    unsatisfiable.insert(index);
                }
            }
        }
        if unsatisfiable.len() == before {
            break;
        }
    }

    for rule in &mut set.rules {
        if rule.skip_reason.is_some() {
            continue;
        }
        if rule.scope != "file" {
            rule.skip_reason = Some("static-scope-unsupported".into());
        } else if rule.root.is_none() {
            rule.skip_reason = Some("requires-unsupported-features".into());
        }
    }

    set.unsupported_kinds = unsupported_kinds.into_iter().collect();
    set.unsupported_kinds.sort();
    set.exact_index = exact_bytes
        .iter()
        .enumerate()
        .map(|(index, pattern)| (pattern.clone(), index))
        .collect();
    set.exact_bytes = exact_bytes;
    set
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(|s| s.chars().take(512).collect())
                .collect()
        })
        .unwrap_or_default()
}

fn parse_node(
    value: &Value,
    depth: usize,
    unsupported: &mut HashSet<String>,
    exact_set: &mut HashSet<Vec<u8>>,
    exact_bytes: &mut Vec<Vec<u8>>,
) -> Result<Node, String> {
    if depth > MAX_NODE_DEPTH {
        return Err("nesting too deep".into());
    }
    let array = value.as_array().ok_or("node is not an array")?;
    let tag = array.first().and_then(Value::as_str).ok_or("node tag")?;
    match tag {
        "and" | "or" | "not" | "opt" => {
            let children = parse_children(array.get(1), depth, unsupported, exact_set, exact_bytes)?;
            Ok(match tag {
                "and" => Node::And(children),
                "or" => Node::Or(children),
                "not" => Node::Not(children),
                _ => Node::SomeOf { min: 0, children },
            })
        }
        "some" => {
            let min = array.get(1).and_then(Value::as_u64).unwrap_or(0);
            let children = parse_children(array.get(2), depth, unsupported, exact_set, exact_bytes)?;
            Ok(Node::SomeOf { min, children })
        }
        "count" => {
            let child = array.get(1).ok_or("count child")?;
            let min = array.get(2).and_then(Value::as_i64).unwrap_or(0).max(0) as u64;
            let max_raw = array.get(3).and_then(Value::as_i64).unwrap_or(-1);
            let max = if max_raw < 0 { u64::MAX } else { max_raw as u64 };
            let child = parse_node(child, depth + 1, unsupported, exact_set, exact_bytes)?;
            Ok(Node::Count { child: Box::new(child), min, max })
        }
        "sub" => {
            // Children are never evaluated: the static subset cannot enter a
            // narrower scope. Still parse them so unsupported leaf kinds get
            // counted for coverage reporting — both globally and retained on
            // the node for the per-rule honesty list.
            unsupported.insert("subscope".into());
            let mut inner: HashSet<String> = HashSet::new();
            if let Some(children) = array.get(2).and_then(Value::as_array) {
                for child in children {
                    let _ = parse_node(child, depth + 1, &mut inner, exact_set, exact_bytes);
                }
            }
            unsupported.extend(inner.iter().cloned());
            let mut kinds: Vec<String> = inner.into_iter().collect();
            kinds.sort();
            Ok(Node::Subscope(kinds))
        }
        "f" => {
            let kind = array.get(1).and_then(Value::as_str).unwrap_or("");
            let raw = array.get(2).and_then(Value::as_str).unwrap_or("");
            Ok(Node::Feature(compile_feature(kind, raw, unsupported, exact_set, exact_bytes)))
        }
        "re" => {
            let pattern = array.get(1).and_then(Value::as_str).unwrap_or("");
            let flags = array.get(2).and_then(Value::as_str).unwrap_or("");
            Ok(Node::Feature(compile_regex(pattern, flags, unsupported)))
        }
        "m" => {
            let target = array.get(1).and_then(Value::as_str).unwrap_or("").to_string();
            Ok(Node::Match(MatchTarget::Unresolved(target)))
        }
        "bad" => {
            unsupported.insert("malformed-statement".into());
            Ok(Node::Feature(Feature::Unsupported { kind: "malformed".into() }))
        }
        other => {
            unsupported.insert(format!("unknown-node:{other}"));
            Ok(Node::Feature(Feature::Unsupported { kind: "unknown".into() }))
        }
    }
}

/// Parse a rule's normalized `tree` field: a bare list of statement nodes.
/// capa semantics make the top-level `features:` list an implicit AND, so a
/// one-statement list compiles to that statement and a longer list to an And.
fn parse_tree(
    value: &Value,
    unsupported: &mut HashSet<String>,
    exact_set: &mut HashSet<Vec<u8>>,
    exact_bytes: &mut Vec<Vec<u8>>,
) -> Result<Node, String> {
    let list = value.as_array().ok_or("tree is not a list")?;
    if list.is_empty() {
        return Err("empty tree".into());
    }
    let mut children = Vec::with_capacity(list.len());
    for item in list {
        children.push(parse_node(item, 1, unsupported, exact_set, exact_bytes)?);
    }
    Ok(if children.len() == 1 {
        children.pop().expect("non-empty")
    } else {
        Node::And(children)
    })
}

fn parse_children(
    value: Option<&Value>,
    depth: usize,
    unsupported: &mut HashSet<String>,
    exact_set: &mut HashSet<Vec<u8>>,
    exact_bytes: &mut Vec<Vec<u8>>,
) -> Result<Vec<Node>, String> {
    let list = value.and_then(Value::as_array).ok_or("children is not a list")?;
    list.iter()
        .map(|child| parse_node(child, depth + 1, unsupported, exact_set, exact_bytes))
        .collect()
}

fn compile_feature(
    kind: &str,
    raw: &str,
    unsupported: &mut HashSet<String>,
    exact_set: &mut HashSet<Vec<u8>>,
    exact_bytes: &mut Vec<Vec<u8>>,
) -> Feature {
    match kind {
        "api" => Feature::Api(normalize_api(raw)),
        "import" => Feature::Import { raw: raw.to_string(), normalized: normalize_import(raw) },
        "export" => Feature::Export(raw.to_string()),
        "section" => Feature::Section(raw.to_string()),
        "format" => Feature::Global(GlobalKind::Format, raw.to_lowercase()),
        "os" => Feature::Global(GlobalKind::Os, raw.to_lowercase()),
        "arch" => Feature::Global(GlobalKind::Arch, raw.to_lowercase()),
        "string" => Feature::Str(raw.to_string()),
        "substring" => Feature::Substring(raw.to_string()),
        "bytes" => compile_bytes(raw, unsupported, exact_set, exact_bytes),
        "characteristic" => match raw {
            "embedded pe" => Feature::Characteristic(Characteristic::EmbeddedPe),
            "forwarded export" => Feature::Characteristic(Characteristic::ForwardedExport),
            _ => {
                unsupported.insert(format!("characteristic:{raw}"));
                Feature::Unsupported { kind: "characteristic".into() }
            }
        },
        other => {
            unsupported.insert(other.to_string());
            Feature::Unsupported { kind: other.to_string() }
        }
    }
}

/// capa v7+ semantics: the DLL part of `dll.symbol` is documentation only and
/// dropped for matching; ordinal symbols (`dll.#n`) keep their normalized dll;
/// `namespace.class::method` .NET names are kept whole.
fn normalize_api(raw: &str) -> String {
    if raw.contains("::") {
        return raw.to_string();
    }
    match raw.rsplit_once('.') {
        Some((dll, symbol)) if symbol.starts_with('#') => {
            format!("{}.{}", normalize_dll(dll), symbol)
        }
        Some((_, symbol)) => symbol.to_string(),
        None => raw.to_string(),
    }
}

/// `import:` values keep the DLL for matching. The normalized variant
/// lowercases the dll part and strips .dll/.drv/.so like capa extractors.
fn normalize_import(raw: &str) -> String {
    if raw.contains("::") {
        return raw.to_string();
    }
    match raw.split_once('.') {
        Some((dll, symbol)) if !symbol.is_empty() => {
            format!("{}.{}", normalize_dll(dll), symbol)
        }
        _ => normalize_dll(raw),
    }
}

fn normalize_dll(dll: &str) -> String {
    let lower = dll.to_lowercase();
    for ext in [".dll", ".drv", ".so"] {
        if let Some(base) = lower.strip_suffix(ext) {
            return base.to_string();
        }
    }
    lower
}

fn compile_regex(pattern: &str, flags: &str, unsupported: &mut HashSet<String>) -> Feature {
    if pattern.len() > MAX_PATTERN_CHARS || flags.chars().any(|c| c != 'i') {
        unsupported.insert("regex-limit".into());
        return Feature::Unsupported { kind: "regex".into() };
    }
    let compiled = regex::bytes::RegexBuilder::new(pattern)
        .case_insensitive(flags.contains('i'))
        .unicode(true)
        .size_limit(MAX_REGEX_SIZE)
        .build()
        .ok();
    if compiled.is_none() {
        unsupported.insert("regex-invalid".into());
    }
    Feature::Regex { source: pattern.to_string(), compiled }
}

fn compile_bytes(
    raw: &str,
    unsupported: &mut HashSet<String>,
    exact_set: &mut HashSet<Vec<u8>>,
    exact_bytes: &mut Vec<Vec<u8>>,
) -> Feature {
    let mut pattern: Vec<Option<u8>> = Vec::new();
    let mut valid = raw.len() <= MAX_PATTERN_CHARS * 3;
    if valid {
        for token in raw.split_ascii_whitespace() {
            match token.len() {
                2 => {
                    match (nibble(token.as_bytes()[0]), nibble(token.as_bytes()[1])) {
                        (Ok(Some(hi)), Ok(Some(lo))) => pattern.push(Some((hi << 4) | lo)),
                        (Ok(None), Ok(None)) => pattern.push(None),
                        // half-byte wildcards like `?4`/`4?` are not supported
                        _ => {
                            valid = false;
                            break;
                        }
                    }
                }
                _ => {
                    valid = false;
                    break;
                }
            }
        }
    }
    if !valid || pattern.is_empty() || pattern.len() > MAX_BYTES_PATTERN {
        unsupported.insert("bytes-invalid".into());
        return Feature::Unsupported { kind: "bytes".into() };
    }
    if pattern.iter().all(Option::is_some) {
        let bytes: Vec<u8> = pattern.into_iter().flatten().collect();
        if exact_set.insert(bytes.clone()) {
            exact_bytes.push(bytes.clone());
        }
        Feature::Bytes { display: raw.to_string(), matcher: BytesMatcher::Exact(bytes) }
    } else {
        // translate to a regex::bytes pattern; literal bytes + (?s:.) gaps
        let mut source = String::with_capacity(pattern.len() * 6);
        source.push_str("(?s:");
        for (index, byte) in pattern.iter().enumerate() {
            match byte {
                Some(b) => {
                    source.push_str(&format!("\\x{b:02X}"));
                }
                None => source.push('.'),
            }
            let _ = index;
        }
        source.push(')');
        match regex::bytes::RegexBuilder::new(&source).size_limit(MAX_REGEX_SIZE).build() {
            Ok(re) => Feature::Bytes { display: raw.to_string(), matcher: BytesMatcher::Wild(re) },
            Err(_) => {
                unsupported.insert("bytes-invalid".into());
                Feature::Unsupported { kind: "bytes".into() }
            }
        }
    }
}

/// Hex nibble; '?' is a wildcard. Other characters are invalid.
fn nibble(byte: u8) -> Result<Option<u8>, ()> {
    match byte {
        b'0'..=b'9' => Ok(Some(byte - b'0')),
        b'a'..=b'f' => Ok(Some(byte - b'a' + 10)),
        b'A'..=b'F' => Ok(Some(byte - b'A' + 10)),
        b'?' => Ok(None),
        _ => Err(()),
    }
}

fn resolve_matches(
    node: &mut Node,
    by_name: &HashMap<String, usize>,
    ns_members: &HashMap<String, Vec<usize>>,
    unresolved: &mut HashSet<String>,
) {
    match node {
        Node::And(children) | Node::Or(children) | Node::Not(children) => {
            for child in children {
                resolve_matches(child, by_name, ns_members, unresolved);
            }
        }
        Node::SomeOf { children, .. } => {
            for child in children {
                resolve_matches(child, by_name, ns_members, unresolved);
            }
        }
        Node::Count { child, .. } => resolve_matches(child, by_name, ns_members, unresolved),
        Node::Match(target) => {
            if let MatchTarget::Unresolved(name) = target {
                if let Some(index) = by_name.get(name) {
                    *target = MatchTarget::Rule(*index);
                } else if ns_members.get(name).is_some() {
                    *target = MatchTarget::Namespace(name.clone());
                } else {
                    unresolved.insert(name.clone());
                }
            }
        }
        _ => {}
    }
}

/// Collect the kinds of every node the static subset cannot evaluate, so a
/// matched-but-degraded rule reports exactly what was dropped. Called after
/// `resolve_matches` so only genuinely unresolved match targets are counted.
fn collect_unsupported(node: &Node, out: &mut HashSet<String>) {
    match node {
        Node::And(children) | Node::Or(children) | Node::Not(children) => {
            for child in children {
                collect_unsupported(child, out);
            }
        }
        Node::SomeOf { children, .. } => {
            for child in children {
                collect_unsupported(child, out);
            }
        }
        Node::Count { child, .. } => collect_unsupported(child, out),
        Node::Subscope(inner) => {
            out.insert("subscope".into());
            for kind in inner {
                out.insert(kind.clone());
            }
        }
        Node::Feature(Feature::Unsupported { kind }) => {
            out.insert(kind.clone());
        }
        Node::Feature(Feature::Regex { compiled: None, .. }) => {
            out.insert("regex-uncompilable".into());
        }
        Node::Match(MatchTarget::Unresolved(name)) => {
            out.insert(format!("unresolved-match:{name}"));
        }
        _ => {}
    }
}

/// `match:` references to rules outside file scope can never match — flag
/// them in the per-rule honesty list so a surviving `or:` sibling still
/// reports the drop. A namespace reference only counts when every member
/// rule is scope-skipped (surviving members still evaluate honestly).
fn collect_match_scope(
    node: &Node,
    scope_skipped: &[bool],
    ns_members: &HashMap<String, Vec<usize>>,
    out: &mut HashSet<String>,
) {
    match node {
        Node::And(children) | Node::Or(children) | Node::Not(children) => {
            for child in children {
                collect_match_scope(child, scope_skipped, ns_members, out);
            }
        }
        Node::SomeOf { children, .. } => {
            for child in children {
                collect_match_scope(child, scope_skipped, ns_members, out);
            }
        }
        Node::Count { child, .. } => collect_match_scope(child, scope_skipped, ns_members, out),
        Node::Match(MatchTarget::Rule(index)) => {
            if scope_skipped.get(*index).copied().unwrap_or(false) {
                out.insert("match-scope-unsupported".into());
            }
        }
        Node::Match(MatchTarget::Namespace(name)) => {
            if let Some(members) = ns_members.get(name) {
                if !members.is_empty()
                    && members
                        .iter()
                        .all(|index| scope_skipped.get(*index).copied().unwrap_or(false))
                {
                    out.insert("match-scope-unsupported".into());
                }
            }
        }
        _ => {}
    }
}

/// Fold a tree under `unsupported leaf -> false`. Returns None when the node
/// is constant-false; Node::True when constant-true.
fn prune(node: &Node, unsatisfiable: &HashSet<usize>) -> Option<Node> {
    match node {
        Node::True => Some(Node::True),
        Node::Feature(Feature::Unsupported { .. }) => None,
        // a regex that failed to compile can never match — fold it like any
        // other unsatisfiable leaf so `and:` rules degrade to skippedRules
        Node::Feature(Feature::Regex { compiled: None, .. }) => None,
        Node::Subscope(_) => None,
        Node::Match(MatchTarget::Unresolved(_)) => None,
        Node::Match(MatchTarget::Rule(index)) => {
            if unsatisfiable.contains(index) {
                None
            } else {
                Some(node.clone())
            }
        }
        Node::Match(MatchTarget::Namespace(_)) => Some(node.clone()),
        Node::Feature(_) => Some(node.clone()),
        Node::And(children) => {
            let mut kept = Vec::with_capacity(children.len());
            for child in children {
                match prune(child, unsatisfiable)? {
                    Node::True => {}
                    pruned => kept.push(pruned),
                }
            }
            Some(if kept.is_empty() { Node::True } else { Node::And(kept) })
        }
        Node::Or(children) => {
            let mut kept = Vec::with_capacity(children.len());
            for child in children {
                match prune(child, unsatisfiable) {
                    Some(Node::True) => return Some(Node::True),
                    Some(pruned) => kept.push(pruned),
                    None => {}
                }
            }
            if kept.is_empty() {
                None
            } else {
                Some(Node::Or(kept))
            }
        }
        Node::Not(children) => {
            // not(a, b, ...) == !(a && b && ...). A constant-false child makes
            // the conjunction false so the negation is true; a constant-true
            // child is simply dropped. If every child is true the conjunction
            // holds and the negation is constant-false.
            let mut kept = Vec::with_capacity(children.len());
            for child in children {
                match prune(child, unsatisfiable) {
                    None => return Some(Node::True),
                    Some(Node::True) => {}
                    Some(pruned) => kept.push(pruned),
                }
            }
            if kept.is_empty() {
                None
            } else {
                Some(Node::Not(kept))
            }
        }
        Node::SomeOf { min, children } => {
            let mut kept = Vec::with_capacity(children.len());
            for child in children {
                if let Some(pruned) = prune(child, unsatisfiable) {
                    kept.push(pruned);
                }
            }
            if (kept.len() as u64) < *min {
                None
            } else {
                Some(Node::SomeOf { min: *min, children: kept })
            }
        }
        Node::Count { child, min, max } => match prune(child, unsatisfiable) {
            None => {
                if *min == 0 {
                    Some(Node::True)
                } else {
                    None
                }
            }
            Some(pruned) => Some(Node::Count { child: Box::new(pruned), min: *min, max: *max }),
        },
    }
}
