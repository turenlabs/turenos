//! Bounded evaluation of the compiled ruleset against a static FeatureSet.
//!
//! Evaluation runs in two passes:
//!
//! 1. A shared *scan* materializes every location-sensitive feature once:
//!    one Aho-Corasick pass over the input for all exact `bytes:` patterns,
//!    one bounded pass per wildcard `bytes:` pattern, and one pass over the
//!    extracted string table evaluating every referenced `substring:` /
//!    `string: /re/` pattern. Work budgets cap the total (string, pattern)
//!    checks and wildcard scan bytes; exhaustion sets `scan_truncated` and
//!    un-scanned patterns evaluate as non-matches (a lower bound, reported).
//! 2. Rules evaluate by lookup only. `match:` references are memoized per
//!    rule; dependency cycles (which capa forbids) are reported and the
//!    re-entered rule evaluates as a non-match.
//!
//! `count(child): min..max` counts the child's total location hits: string
//! occurrences, byte-pattern offsets, matching sections/imports, or the
//! matched sub-rule's own hit count — mirroring capa's Range semantics.

use std::collections::{HashMap, HashSet};

use aho_corasick::AhoCorasick;
use regex::bytes::Regex;

use crate::ast::{BytesMatcher, Characteristic, Feature, GlobalKind, MatchTarget, Node, Ruleset};
use crate::extract::{FeatureSet, MAX_LOCATIONS};

/// Distinct `substring:` patterns scanned per match call.
const MAX_SUBSTRING_PATTERNS: usize = 2048;
/// Distinct `string: /re/` patterns scanned per match call.
const MAX_REGEX_PATTERNS: usize = 2048;
/// Distinct wildcard `bytes:` patterns scanned per match call.
const MAX_WILD_PATTERNS: usize = 1024;
/// (string x pattern) work units for the shared string scan. Each check
/// charges `len/64 + 1`, so the budget covers roughly 1 GiB of haystack.
const MAX_STRING_SCAN_WORK: u64 = 16 * 1024 * 1024;
/// Aggregate input bytes charged to wildcard `bytes:` scans (one full input
/// scan per pattern).
const MAX_WILD_SCAN_BYTES: u64 = 512 * 1024 * 1024;
/// Total Aho-Corasick hits consumed per match call.
const MAX_AC_MATCHES: u64 = 8 * 1024 * 1024;
/// Occurrence counts saturate here for `count(...)` semantics.
const COUNT_SATURATE: u64 = 1_000_000;
/// Evidence entries retained per matched rule.
const MAX_EVIDENCE: usize = 64;
/// Node evaluations per call — safety bound; rules evaluate once each.
const MAX_EVAL_NODES: u64 = 2 * 1024 * 1024;
/// Longest evidence feature label / sampled string value.
const MAX_EVIDENCE_TEXT: usize = 256;

/// Location evidence for one feature instance.
#[derive(Debug, Default)]
struct Hits {
    /// Total occurrences (saturating at COUNT_SATURATE).
    count: u64,
    /// Up to MAX_LOCATIONS sample file offsets.
    locations: Vec<u64>,
    /// One matching string value (substring/regex evidence only).
    sample: Option<String>,
}

impl Hits {
    fn record(&mut self, offset: u64) {
        self.count = (self.count + 1).min(COUNT_SATURATE);
        if self.locations.len() < MAX_LOCATIONS {
            self.locations.push(offset);
        }
    }

    fn record_string(&mut self, value: &str, count: u64, locations: &[u64]) {
        self.count = self.count.saturating_add(count).min(COUNT_SATURATE);
        if self.sample.is_none() {
            self.sample = Some(value.chars().take(MAX_EVIDENCE_TEXT).collect());
        }
        for &location in locations {
            if self.locations.len() >= MAX_LOCATIONS {
                break;
            }
            self.locations.push(location);
        }
    }
}

/// Output of the shared scan pass.
struct Scan<'a> {
    substring_index: HashMap<&'a str, usize>,
    substring_hits: Vec<Hits>,
    regex_index: HashMap<&'a str, usize>,
    regex_hits: Vec<Hits>,
    wild_index: HashMap<&'a str, usize>,
    wild_hits: Vec<Hits>,
    /// Per `ruleset.exact_bytes` pattern.
    exact_hits: Vec<Hits>,
    /// True when a work budget stopped the scan early: any pattern that was
    /// not fully scanned evaluates as a non-match and this flag reports it.
    truncated: bool,
}

impl<'a> Scan<'a> {
    fn run(rules: &'a Ruleset, features: &FeatureSet, input: &[u8]) -> Scan<'a> {
        let mut substrings: HashSet<&'a str> = HashSet::new();
        let mut regexes: HashMap<&'a str, &'a Regex> = HashMap::new();
        let mut wilds: HashMap<&'a str, &'a Regex> = HashMap::new();
        for rule in &rules.rules {
            if rule.skip_reason.is_some() {
                continue;
            }
            if let Some(root) = &rule.root {
                collect_patterns(root, &mut substrings, &mut regexes, &mut wilds);
            }
        }

        // Sort everything so budget exhaustion truncates deterministically.
        let mut substring_patterns: Vec<&'a str> = substrings.into_iter().collect();
        substring_patterns.sort_unstable();
        let mut regex_patterns: Vec<(&'a str, &'a Regex)> = regexes.into_iter().collect();
        regex_patterns.sort_unstable_by(|a, b| a.0.cmp(b.0));
        let mut wild_patterns: Vec<(&'a str, &'a Regex)> = wilds.into_iter().collect();
        wild_patterns.sort_unstable_by(|a, b| a.0.cmp(b.0));

        let mut truncated = false;
        if substring_patterns.len() > MAX_SUBSTRING_PATTERNS {
            substring_patterns.truncate(MAX_SUBSTRING_PATTERNS);
            truncated = true;
        }
        if regex_patterns.len() > MAX_REGEX_PATTERNS {
            regex_patterns.truncate(MAX_REGEX_PATTERNS);
            truncated = true;
        }
        if wild_patterns.len() > MAX_WILD_PATTERNS {
            wild_patterns.truncate(MAX_WILD_PATTERNS);
            truncated = true;
        }

        let mut keys: Vec<&String> = features.strings.keys().collect();
        keys.sort_unstable();

        // `substring:` and `string: /re/` scans share one work budget.
        let mut budget = MAX_STRING_SCAN_WORK;
        let mut substring_hits: Vec<Hits> =
            (0..substring_patterns.len()).map(|_| Hits::default()).collect();
        'substring_scan: for (index, pattern) in substring_patterns.iter().enumerate() {
            for key in &keys {
                let cost = key.len() as u64 / 64 + 1;
                if budget < cost {
                    truncated = true;
                    break 'substring_scan;
                }
                budget -= cost;
                if let Some(hits) = features.strings.get(*key) {
                    if key.contains(pattern) {
                        substring_hits[index].record_string(key, hits.count, &hits.locations);
                    }
                }
            }
        }

        let mut regex_hits: Vec<Hits> =
            (0..regex_patterns.len()).map(|_| Hits::default()).collect();
        'regex_scan: for (index, (_, regex)) in regex_patterns.iter().enumerate() {
            for key in &keys {
                let cost = key.len() as u64 / 64 + 1;
                if budget < cost {
                    truncated = true;
                    break 'regex_scan;
                }
                budget -= cost;
                if let Some(hits) = features.strings.get(*key) {
                    if regex.is_match(key.as_bytes()) {
                        regex_hits[index].record_string(key, hits.count, &hits.locations);
                    }
                }
            }
        }

        // One shared Aho-Corasick pass for every exact `bytes:` pattern.
        let mut exact_hits: Vec<Hits> =
            (0..rules.exact_bytes.len()).map(|_| Hits::default()).collect();
        if !rules.exact_bytes.is_empty() {
            if let Ok(ac) = AhoCorasick::new(&rules.exact_bytes) {
                let mut consumed = 0u64;
                'ac_scan: for found in ac.find_iter(input) {
                    consumed += 1;
                    if consumed > MAX_AC_MATCHES {
                        truncated = true;
                        break 'ac_scan;
                    }
                    exact_hits[found.pattern().as_usize()].record(found.start() as u64);
                }
            }
        }

        // Each wildcard `bytes:` pattern is a standalone regex scan over input.
        let mut wild_hits: Vec<Hits> =
            (0..wild_patterns.len()).map(|_| Hits::default()).collect();
        let mut wild_budget = MAX_WILD_SCAN_BYTES;
        for (index, (_, regex)) in wild_patterns.iter().enumerate() {
            if wild_budget < input.len() as u64 {
                truncated = true;
                break;
            }
            wild_budget -= input.len() as u64;
            for found in regex.find_iter(input) {
                wild_hits[index].record(found.start() as u64);
                if wild_hits[index].count >= COUNT_SATURATE {
                    break;
                }
            }
        }

        Scan {
            substring_index: index_map(&substring_patterns),
            substring_hits,
            regex_index: index_map(&regex_patterns.iter().map(|(name, _)| *name).collect::<Vec<_>>()),
            regex_hits,
            wild_index: index_map(&wild_patterns.iter().map(|(name, _)| *name).collect::<Vec<_>>()),
            wild_hits,
            exact_hits,
            truncated,
        }
    }
}

fn index_map<'a>(patterns: &[&'a str]) -> HashMap<&'a str, usize> {
    patterns.iter().enumerate().map(|(index, name)| (*name, index)).collect()
}

fn collect_patterns<'a>(
    node: &'a Node,
    substrings: &mut HashSet<&'a str>,
    regexes: &mut HashMap<&'a str, &'a Regex>,
    wilds: &mut HashMap<&'a str, &'a Regex>,
) {
    match node {
        Node::And(children) | Node::Or(children) | Node::Not(children) => {
            for child in children {
                collect_patterns(child, substrings, regexes, wilds);
            }
        }
        Node::SomeOf { children, .. } => {
            for child in children {
                collect_patterns(child, substrings, regexes, wilds);
            }
        }
        Node::Count { child, .. } => collect_patterns(child, substrings, regexes, wilds),
        Node::Feature(Feature::Substring(pattern)) => {
            substrings.insert(pattern);
        }
        Node::Feature(Feature::Regex { source, compiled }) => {
            if let Some(regex) = compiled {
                regexes.entry(source).or_insert(regex);
            }
        }
        Node::Feature(Feature::Bytes { display, matcher: BytesMatcher::Wild(regex) }) => {
            wilds.entry(display).or_insert(regex);
        }
        _ => {}
    }
}

/// One reported feature match inside a capability.
#[derive(Debug)]
pub struct Evidence {
    pub feature: String,
    pub locations: Vec<u64>,
    /// Matching string value sample for string-family features.
    pub value: Option<String>,
    /// Total hits when greater than the location sample size.
    pub count: u64,
}

/// Result of evaluating one node or rule.
#[derive(Debug, Default)]
pub struct EvalResult {
    pub matched: bool,
    /// Total feature hits — the value `count(child)` compares.
    pub hits: u64,
    pub evidence: Vec<Evidence>,
}

#[derive(Debug)]
enum RuleState {
    Pending,
    Active,
    Done(EvalResult),
}

pub struct Evaluator<'a> {
    rules: &'a Ruleset,
    features: &'a FeatureSet,
    scan: Scan<'a>,
    states: Vec<RuleState>,
    eval_nodes: u64,
    cycle_warnings: HashSet<usize>,
    /// Set when MAX_EVAL_NODES is exhausted mid-run; remaining rules report
    /// as unevaluated rather than silently non-matching.
    pub budget_exhausted: bool,
    pub warnings: Vec<String>,
}

impl<'a> Evaluator<'a> {
    pub fn new(rules: &'a Ruleset, features: &'a FeatureSet, input: &[u8]) -> Evaluator<'a> {
        Evaluator {
            rules,
            features,
            scan: Scan::run(rules, features, input),
            states: (0..rules.rules.len()).map(|_| RuleState::Pending).collect(),
            eval_nodes: MAX_EVAL_NODES,
            cycle_warnings: HashSet::new(),
            budget_exhausted: false,
            warnings: Vec::new(),
        }
    }

    pub fn scan_truncated(&self) -> bool {
        self.scan.truncated
    }

    /// Evaluate one rule (memoized). Returns (matched, hit count).
    pub fn eval_rule(&mut self, index: usize) -> (bool, u64) {
        let rules = self.rules;
        match &self.states[index] {
            RuleState::Done(result) => return (result.matched, result.hits),
            RuleState::Active => {
                if self.cycle_warnings.insert(index) && self.warnings.len() < 64 {
                    self.warnings
                        .push(format!("match cycle involving rule `{}`", rules.rules[index].name));
                }
                return (false, 0);
            }
            RuleState::Pending => {}
        }

        let result = match (&rules.rules[index].skip_reason, &rules.rules[index].root) {
            (None, Some(root)) => {
                self.states[index] = RuleState::Active;
                let mut result = self.eval_node(root);
                result.evidence.truncate(MAX_EVIDENCE);
                result
            }
            // skipped or malformed rules never match
            _ => EvalResult::default(),
        };
        let outcome = (result.matched, result.hits);
        self.states[index] = RuleState::Done(result);
        outcome
    }

    /// Borrow the completed evidence for a rule (after `eval_rule`).
    pub fn evidence(&self, index: usize) -> &[Evidence] {
        match &self.states[index] {
            RuleState::Done(result) => &result.evidence,
            _ => &[],
        }
    }

    fn eval_node(&mut self, node: &'a Node) -> EvalResult {
        if self.eval_nodes == 0 {
            self.budget_exhausted = true;
            return EvalResult::default();
        }
        self.eval_nodes -= 1;
        let rules = self.rules;
        match node {
            Node::True => EvalResult { matched: true, hits: 0, evidence: Vec::new() },
            Node::Subscope(_) => EvalResult::default(),
            Node::Feature(feature) => self.eval_feature(feature),
            Node::And(children) => {
                let mut out = EvalResult { matched: true, hits: 0, evidence: Vec::new() };
                for child in children {
                    let child_result = self.eval_node(child);
                    out.matched &= child_result.matched;
                    out.hits = out.hits.saturating_add(child_result.hits).min(COUNT_SATURATE);
                    out.evidence.extend(child_result.evidence);
                    if out.evidence.len() > MAX_EVIDENCE {
                        out.evidence.truncate(MAX_EVIDENCE);
                    }
                }
                out
            }
            Node::Or(children) => {
                let mut out = EvalResult::default();
                for child in children {
                    let child_result = self.eval_node(child);
                    if child_result.matched {
                        out.matched = true;
                        out.hits = out.hits.saturating_add(child_result.hits).min(COUNT_SATURATE);
                        out.evidence.extend(child_result.evidence);
                        if out.evidence.len() > MAX_EVIDENCE {
                            out.evidence.truncate(MAX_EVIDENCE);
                        }
                    }
                }
                out
            }
            Node::Not(children) => {
                // not(a, b, ...) == !(a && b && ...). Negative results carry
                // no reportable evidence.
                let mut all = true;
                for child in children {
                    all &= self.eval_node(child).matched;
                }
                EvalResult { matched: !all, hits: 0, evidence: Vec::new() }
            }
            Node::SomeOf { min, children } => {
                let mut matched_count = 0u64;
                let mut out = EvalResult::default();
                for child in children {
                    let child_result = self.eval_node(child);
                    if child_result.matched {
                        matched_count += 1;
                        out.hits = out.hits.saturating_add(child_result.hits).min(COUNT_SATURATE);
                        out.evidence.extend(child_result.evidence);
                        if out.evidence.len() > MAX_EVIDENCE {
                            out.evidence.truncate(MAX_EVIDENCE);
                        }
                    }
                }
                out.matched = matched_count >= *min;
                out
            }
            Node::Count { child, min, max } => {
                let child_result = self.eval_node(child);
                EvalResult {
                    matched: child_result.hits >= *min && child_result.hits <= *max,
                    hits: child_result.hits,
                    evidence: child_result.evidence,
                }
            }
            Node::Match(MatchTarget::Rule(index)) => {
                let (matched, hits) = self.eval_rule(*index);
                EvalResult {
                    matched,
                    hits,
                    evidence: if matched {
                        vec![Evidence {
                            feature: format!("match: {}", rules.rules[*index].name),
                            locations: Vec::new(),
                            value: None,
                            count: 0,
                        }]
                    } else {
                        Vec::new()
                    },
                }
            }
            Node::Match(MatchTarget::Namespace(namespace)) => {
                let mut out = EvalResult::default();
                if let Some(members) = rules.ns_members.get(namespace.as_str()) {
                    for &member in members {
                        let (matched, hits) = self.eval_rule(member);
                        if matched {
                            out.matched = true;
                            out.hits = out.hits.saturating_add(hits).min(COUNT_SATURATE);
                            if out.evidence.len() < MAX_EVIDENCE {
                                out.evidence.push(Evidence {
                                    feature: format!("match: {namespace}"),
                                    locations: Vec::new(),
                                    value: Some(rules.rules[member].name.clone()),
                                    count: 0,
                                });
                            }
                        }
                    }
                }
                out
            }
            Node::Match(MatchTarget::Unresolved(_)) => EvalResult::default(),
        }
    }

    fn eval_feature(&mut self, feature: &'a Feature) -> EvalResult {
        let features = self.features;
        match feature {
            Feature::Api(symbol) => {
                if features.apis.contains(symbol) {
                    self.leaf(feature_label(feature), Vec::new(), self.count_api(symbol), None)
                } else {
                    EvalResult::default()
                }
            }
            Feature::Import { raw, normalized } => {
                let matched = features.imports.contains(raw)
                    || features.imports.contains(normalized)
                    || features.imports.contains(&raw.to_lowercase());
                if matched {
                    self.leaf(
                        feature_label(feature),
                        Vec::new(),
                        self.count_import(raw, normalized),
                        None,
                    )
                } else {
                    EvalResult::default()
                }
            }
            Feature::Export(name) => {
                if features.exports.contains(name) {
                    self.leaf(feature_label(feature), Vec::new(), 1, None)
                } else {
                    EvalResult::default()
                }
            }
            Feature::Section(name) => {
                let count = features
                    .sections
                    .iter()
                    .filter(|section| &section.name == name)
                    .count() as u64;
                if count > 0 {
                    let locations = features
                        .sections
                        .iter()
                        .filter(|section| &section.name == name)
                        .map(|section| section.offset)
                        .take(MAX_LOCATIONS)
                        .collect();
                    self.leaf(feature_label(feature), locations, count, None)
                } else {
                    EvalResult::default()
                }
            }
            Feature::Global(kind, value) => {
                let matched = value == "any"
                    || match kind {
                        GlobalKind::Format => features.formats.iter().any(|f| f == value),
                        GlobalKind::Os => features.os == *value,
                        GlobalKind::Arch => features.arch == *value,
                    };
                if matched {
                    self.leaf(feature_label(feature), Vec::new(), 1, None)
                } else {
                    EvalResult::default()
                }
            }
            Feature::Str(value) => match features.strings.get(value) {
                Some(hits) => self.leaf(
                    feature_label(feature),
                    hits.locations.clone(),
                    hits.count.min(COUNT_SATURATE),
                    Some(value.chars().take(MAX_EVIDENCE_TEXT).collect()),
                ),
                None => EvalResult::default(),
            },
            Feature::Substring(pattern) => match self.scan.substring_index.get(pattern.as_str()) {
                Some(&index) => self.hits_leaf(feature_label(feature), &self.scan.substring_hits[index]),
                None => EvalResult::default(),
            },
            Feature::Regex { source, compiled } => {
                if compiled.is_none() {
                    return EvalResult::default();
                }
                match self.scan.regex_index.get(source.as_str()) {
                    Some(&index) => self.hits_leaf(feature_label(feature), &self.scan.regex_hits[index]),
                    None => EvalResult::default(),
                }
            }
            Feature::Bytes { display, matcher } => match matcher {
                BytesMatcher::Exact(bytes) => match self.rules.exact_index.get(bytes) {
                    Some(&index) => {
                        self.hits_leaf(format!("bytes: {display}"), &self.scan.exact_hits[index])
                    }
                    None => EvalResult::default(),
                },
                BytesMatcher::Wild(_) => match self.scan.wild_index.get(display.as_str()) {
                    Some(&index) => {
                        self.hits_leaf(format!("bytes: {display}"), &self.scan.wild_hits[index])
                    }
                    None => EvalResult::default(),
                },
            },
            Feature::Characteristic(Characteristic::EmbeddedPe) => {
                if !features.embedded_pe.is_empty() {
                    self.leaf(
                        feature_label(feature),
                        features.embedded_pe.clone(),
                        features.embedded_pe.len() as u64,
                        None,
                    )
                } else {
                    EvalResult::default()
                }
            }
            Feature::Characteristic(Characteristic::ForwardedExport) => {
                if features.has_forwarded_export {
                    self.leaf(feature_label(feature), Vec::new(), 1, None)
                } else {
                    EvalResult::default()
                }
            }
            Feature::Unsupported { .. } => EvalResult::default(),
        }
    }

    fn leaf(&self, feature: String, locations: Vec<u64>, count: u64, value: Option<String>) -> EvalResult {
        EvalResult {
            matched: true,
            hits: count.max(1),
            evidence: vec![Evidence { feature, locations, value, count }],
        }
    }

    fn hits_leaf(&self, feature: String, hits: &Hits) -> EvalResult {
        if hits.count == 0 {
            return EvalResult::default();
        }
        EvalResult {
            matched: true,
            hits: hits.count,
            evidence: vec![Evidence {
                feature,
                locations: hits.locations.clone(),
                value: hits.sample.clone(),
                count: hits.count,
            }],
        }
    }

    /// `count(api(x))`: number of import table entries producing the symbol.
    fn count_api(&self, symbol: &str) -> u64 {
        let mut count = 0u64;
        for (dll, name) in &self.features.import_names {
            if name == symbol
                || (is_aw(name) && &name[..name.len() - 1] == symbol)
                || (name.starts_with('#')
                    && format!("{}.{}", normalize_dll(dll), name) == *symbol)
            {
                count += 1;
            }
        }
        count.max(1)
    }

    /// `count(import(x))`: number of import table entries or libraries that
    /// produce the feature (approximation — see README).
    fn count_import(&self, raw: &str, normalized: &str) -> u64 {
        let raw_lower = raw.to_lowercase();
        let mut count = 0u64;
        for (dll, name) in &self.features.import_names {
            let dll_norm = normalize_dll(dll);
            let dll_ext = dll.to_lowercase();
            if name == raw
                || name == normalized
                || format!("{dll_norm}.{name}") == normalized
                || format!("{dll_ext}.{name}") == raw_lower
                || (is_aw(name) && {
                    let base = &name[..name.len() - 1];
                    base == raw
                        || base == normalized
                        || format!("{dll_norm}.{base}") == normalized
                        || format!("{dll_ext}.{base}") == raw_lower
                })
            {
                count += 1;
            }
        }
        for library in &self.features.libraries {
            let lower = library.to_lowercase();
            if lower == raw_lower || normalize_dll(&lower) == normalized {
                count += 1;
            }
        }
        count.max(1)
    }
}

fn is_aw(symbol: &str) -> bool {
    symbol.len() >= 2 && matches!(symbol.as_bytes()[symbol.len() - 1], b'A' | b'W')
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

fn feature_label(feature: &Feature) -> String {
    let label = match feature {
        Feature::Api(value) => format!("api: {value}"),
        Feature::Import { raw, .. } => format!("import: {raw}"),
        Feature::Export(value) => format!("export: {value}"),
        Feature::Section(value) => format!("section: {value}"),
        Feature::Global(GlobalKind::Format, value) => format!("format: {value}"),
        Feature::Global(GlobalKind::Os, value) => format!("os: {value}"),
        Feature::Global(GlobalKind::Arch, value) => format!("arch: {value}"),
        Feature::Str(value) => format!("string: {value:?}"),
        Feature::Substring(value) => format!("substring: {value:?}"),
        Feature::Regex { source, .. } => format!("string: /{source}/"),
        Feature::Bytes { display, .. } => format!("bytes: {display}"),
        Feature::Characteristic(Characteristic::EmbeddedPe) => {
            "characteristic: embedded pe".to_string()
        }
        Feature::Characteristic(Characteristic::ForwardedExport) => {
            "characteristic: forwarded export".to_string()
        }
        Feature::Unsupported { kind } => format!("unsupported: {kind}"),
    };
    label.chars().take(MAX_EVIDENCE_TEXT).collect()
}
