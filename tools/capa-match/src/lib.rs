#![forbid(unsafe_code)]

//! Bounded static-subset capa capability matcher for Turen agent tools.
//!
//! Three `wasm-bindgen` operations accept raw bytes plus a small JSON options
//! document and return bounded JSON strings. All input validation happens
//! before allocation; every expected failure is
//! `{"schema_version":1,"error":"<code>","message":"<detail>"}` — the module
//! never throws, never traps on malformed input, and touches no filesystem,
//! network, environment, or clock APIs. Consumers run each call in a fresh
//! worker; the embedded ruleset is decoded and compiled per call.
//!
//! ```text
//! capa_match(input, options_json)    match the embedded capa-rules ruleset
//! capa_features(input, options_json) report the extracted static FeatureSet
//! capa_ruleset(options_json)         report embedded ruleset metadata
//! ```
//!
//! # Static-subset honesty boundary
//!
//! This is a static matcher: it extracts file-scope features only — format /
//! os / arch globals, sections, import-table `api:`/`import:`/`export:` names,
//! `bytes:` patterns, `characteristic: embedded pe` / `forwarded export`, and
//! the ASCII/UTF-16LE string table. There is no disassembly and no function-,
//! basic-block-, call-, or instruction-scope feature extraction, so
//! `number:`, `offset:`, `mnemonic:`, `operand*`, `property*`, `class:`,
//! `namespace:`, `function-name:`, `com/*`, and `basic blocks` counting never
//! match. Statements under a narrower scope (`basic block:`, `function:`,
//! `call:`, `instruction:`, `process:`, `thread:`, `span of calls:`) are
//! unsatisfiable.
//!
//! Compile-time constant folding applies `unsupported -> false` under capa
//! semantics: an `and:`/`some`-required unsupported feature makes the whole
//! rule unsatisfiable (reported under `skipped_rules` with reason
//! `requires-unsupported-features`), while dropped `or:` branches and
//! negations keep the rule evaluable and mark it `degraded` with a per-rule
//! `unsupported` kind list. Reported matches are therefore a lower bound:
//! genuine file-scope matches are reported, and rules that could only match
//! through unobservable features are skipped or flagged — never fabricated.
//!
//! # Hard limits (enforced before unbounded allocation)
//!
//! ```text
//! input bytes              32 MiB
//! options JSON              4 KiB
//! JSON output               4 MiB
//! matched rules          4,096
//! evidence per rule          32   (locations per entry: 8)
//! aggregate evidence      4,096
//! rules blob (decoded)     16 MiB
//! ```

mod ast;
mod eval;
mod extract;
// The YAML front end is needed only by unit tests fabricating rules and by
// build.rs compiling the embedded ruleset. serde_norway is a dev/build
// dependency and must never enter the wasm closure.
#[cfg(test)]
mod ruledoc;
#[cfg(test)]
mod tests;

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};
use wasm_bindgen::prelude::*;

/// capa-match input ceiling (house default).
pub(crate) const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
/// Options document ceiling.
pub(crate) const MAX_OPTIONS_BYTES: usize = 4 * 1024;
/// Serialized JSON output ceiling.
pub(crate) const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
/// Matched-rule result ceiling.
pub(crate) const MAX_RESULTS: usize = 4096;
/// Decompressed embedded-ruleset ceiling; build.rs enforces the same limit.
const MAX_BLOB_BYTES: usize = 16 * 1024 * 1024;
/// Evidence entries emitted per matched rule (the evaluator keeps up to 64).
const MAX_EVIDENCE_OUT: usize = 32;
/// Aggregate evidence entries emitted per match report; bounds output size.
const MAX_EVIDENCE_TOTAL: usize = 4096;
/// File offsets emitted per evidence entry (extraction already caps at 8).
const MAX_EVIDENCE_LOCATIONS: usize = 8;
/// Skipped-rule records emitted when `includeSkipped` is set.
const MAX_SKIPPED_OUT: usize = 4096;
/// Parse-error records emitted by `capa_ruleset`.
const MAX_ERRORS_OUT: usize = 128;
/// Distinct-string samples emitted by `capa_features`.
const MAX_STRING_SAMPLE: usize = 4096;
/// Warnings emitted per report.
const MAX_WARNINGS: usize = 64;
/// Longest single string field emitted in a report.
const MAX_FIELD_CHARS: usize = 256;

/// The compiled ruleset blob produced by build.rs (gzip JSON). When the
/// pinned capa-rules checkout was not imported, the blob is an empty ruleset
/// marked `imported: false` and every op still reports cleanly.
static RULES_BLOB: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/rules.bin"));

/// `{"schema_version":1,"error":"<code>","message":"<detail>"}` — the shared
/// error envelope. Everything below returns it as a plain string; the
/// boundary never throws.
fn error_json(code: &str, message: &str) -> String {
    json!({"schema_version": 1, "error": code, "message": message}).to_string()
}

fn err(code: &str, message: String) -> String {
    error_json(code, &message)
}

fn json_result(result: Result<String, String>) -> String {
    match result {
        Ok(json) => json,
        Err(envelope) => envelope,
    }
}

fn serialize(value: &Value) -> Result<String, String> {
    match serde_json::to_string(value) {
        Ok(json) if json.len() <= MAX_OUTPUT_BYTES => Ok(json),
        Ok(_) => Err(error_json(
            "output_too_large",
            "serialized output exceeds 4 MiB limit",
        )),
        Err(_) => Err(error_json("internal_error", "JSON serialization failed")),
    }
}

fn check_input(input: &[u8]) -> Result<(), String> {
    if input.len() > MAX_INPUT_BYTES {
        return Err(err(
            "input_too_large",
            format!("input size {} exceeds limit {MAX_INPUT_BYTES}", input.len()),
        ));
    }
    Ok(())
}

/// Parse the options document into a JSON object. Unknown keys are ignored;
/// known keys are validated at the point of use.
fn parse_options(options_json: &str) -> Result<Map<String, Value>, String> {
    if options_json.len() > MAX_OPTIONS_BYTES {
        return Err(err(
            "options_too_large",
            format!("options size {} exceeds limit {MAX_OPTIONS_BYTES}", options_json.len()),
        ));
    }
    let trimmed = options_json.trim();
    if trimmed.is_empty() {
        return Ok(Map::new());
    }
    let value: Value = serde_json::from_str(trimmed).map_err(|_| {
        error_json("invalid_options", "options is not valid JSON")
    })?;
    match value {
        Value::Object(object) => Ok(object),
        _ => Err(error_json("invalid_options", "options must be a JSON object")),
    }
}

fn opt_u64(object: &Map<String, Value>, key: &str) -> Result<Option<u64>, String> {
    match object.get(key) {
        None => Ok(None),
        Some(value) => match value.as_u64() {
            Some(number) => Ok(Some(number)),
            None => Err(err(
                "invalid_options",
                format!("{key} must be a non-negative integer"),
            )),
        },
    }
}

fn opt_bool(object: &Map<String, Value>, key: &str) -> Result<Option<bool>, String> {
    match object.get(key) {
        None => Ok(None),
        Some(value) => match value.as_bool() {
            Some(flag) => Ok(Some(flag)),
            None => Err(err(
                "invalid_options",
                format!("{key} must be a boolean"),
            )),
        },
    }
}

fn clip(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

/// Decompress and compile the embedded ruleset. Bounded by `take()` before
/// the decoded buffer exists, so a corrupt blob can never cause unbounded
/// allocation. Failures are impossible in a correctly built module but are
/// still reported as envelopes rather than panicking.
pub(crate) fn load_ruleset() -> Result<ast::Ruleset, String> {
    use std::io::Read;
    let mut decoded = Vec::new();
    flate2::read::GzDecoder::new(RULES_BLOB)
        .take(MAX_BLOB_BYTES as u64 + 1)
        .read_to_end(&mut decoded)
        .map_err(|_| error_json("ruleset_decode_failed", "embedded rules blob is not valid gzip"))?;
    if decoded.len() > MAX_BLOB_BYTES {
        return Err(err(
            "ruleset_decode_failed",
            format!("embedded rules blob exceeds {} decoded bytes", MAX_BLOB_BYTES),
        ));
    }
    let blob: Value = serde_json::from_slice(&decoded)
        .map_err(|_| error_json("ruleset_decode_failed", "embedded rules blob is not valid JSON"))?;
    Ok(ast::compile(&blob))
}

/// Match the embedded capa-rules ruleset against `input`.
///
/// Options: `maxResults` (default and ceiling 4096), `includeEvidence`
/// (default true), `includeSkipped` (default false — also emit the
/// per-rule skipped list), `includeLib` (default false — `lib: true` rules
/// still evaluate so `match:` references work, but stay out of the report).
#[wasm_bindgen]
pub fn capa_match(input: &[u8], options_json: &str) -> String {
    json_result((|| {
        check_input(input)?;
        let options = parse_options(options_json)?;
        let ruleset = load_ruleset()?;
        match_report(input, &options, &ruleset)
    })())
}

/// Report the static `FeatureSet` extracted from `input`: formats/os/arch,
/// sections, libraries, import/export entries, api/import match-set samples,
/// string-table statistics with a bounded distinct-value sample, embedded-PE
/// offsets, and the input SHA-256.
///
/// Options: `maxStrings` (default 256, ceiling 4096) bounds the
/// api/import/string sample lists.
#[wasm_bindgen]
pub fn capa_features(input: &[u8], options_json: &str) -> String {
    json_result((|| {
        check_input(input)?;
        let options = parse_options(options_json)?;
        serialize(&features_report(input, &options)?)
    })())
}

/// Report embedded ruleset metadata: provenance commit, imported flag, rule /
/// namespace / library counts, per-reason skip counts, unsupported feature
/// kinds, embedded byte-pattern count, and parse errors.
///
/// Options: `verbose` (default false) additionally emits the full rule list.
#[wasm_bindgen]
pub fn capa_ruleset(options_json: &str) -> String {
    json_result((|| {
        let options = parse_options(options_json)?;
        let ruleset = load_ruleset()?;
        ruleset_report(&options, &ruleset)
    })())
}

fn input_summary(input: &[u8], features: &extract::FeatureSet) -> Value {
    json!({
        "size": input.len(),
        "sha256": features.sha256,
    })
}

fn features_summary(features: &extract::FeatureSet) -> Value {
    json!({
        "formats": &features.formats,
        "os": &features.os,
        "arch": &features.arch,
        "section_count": features.sections.len(),
        "import_count": features.import_names.len(),
        "export_count": features.export_names.len(),
        "library_count": features.libraries.len(),
        "api_feature_count": features.apis.len(),
        "import_feature_count": features.imports.len(),
        "string_count": features.total_strings,
        "distinct_string_count": features.strings.len(),
        "strings_truncated": features.strings_truncated,
        "embedded_pe_count": features.embedded_pe.len(),
        "forwarded_export": features.has_forwarded_export,
        "truncated": features.truncated,
    })
}

fn ruleset_summary(ruleset: &ast::Ruleset) -> Value {
    let evaluated = ruleset.rules.iter().filter(|rule| rule.skip_reason.is_none()).count();
    json!({
        "commit": &ruleset.commit,
        "imported": ruleset.imported,
        "rule_count": ruleset.rules.len(),
        "parse_error_count": ruleset.parse_errors.len(),
        "evaluated_count": evaluated,
        "skipped_count": ruleset.rules.len() - evaluated,
    })
}

fn evidence_json(evidence: &eval::Evidence) -> Value {
    let mut entry = json!({
        "feature": clip(&evidence.feature, MAX_FIELD_CHARS),
        "count": evidence.count,
        "locations": evidence
            .locations
            .iter()
            .take(MAX_EVIDENCE_LOCATIONS)
            .copied()
            .collect::<Vec<u64>>(),
    });
    if let Some(value) = &evidence.value {
        entry["value"] = json!(clip(value, MAX_FIELD_CHARS));
    }
    entry
}

/// Core match pipeline, separated from the boundary so unit tests can drive
/// it with fabricated rulesets.
fn match_report(
    input: &[u8],
    options: &Map<String, Value>,
    ruleset: &ast::Ruleset,
) -> Result<String, String> {
    let max_results = opt_u64(options, "maxResults")?
        .map_or(MAX_RESULTS, |value| value.clamp(1, MAX_RESULTS as u64) as usize);
    let include_evidence = opt_bool(options, "includeEvidence")?.unwrap_or(true);
    let include_skipped = opt_bool(options, "includeSkipped")?.unwrap_or(false);
    let include_lib = opt_bool(options, "includeLib")?.unwrap_or(false);

    let features = extract::FeatureSet::extract(input);
    let mut evaluator = eval::Evaluator::new(ruleset, &features, input);

    let mut matched: Vec<(usize, u64)> = Vec::new();
    let mut lib_matched: u64 = 0;
    let mut skipped_by_reason: BTreeMap<String, u64> = BTreeMap::new();
    let mut skipped: Vec<(String, String, Vec<String>)> = Vec::new();
    for (index, rule) in ruleset.rules.iter().enumerate() {
        if let Some(reason) = &rule.skip_reason {
            *skipped_by_reason.entry(reason.clone()).or_default() += 1;
            skipped.push((rule.name.clone(), reason.clone(), rule.unsupported.clone()));
            continue;
        }
        let (is_match, hits) = evaluator.eval_rule(index);
        if is_match {
            if rule.lib && !include_lib {
                lib_matched += 1;
            } else {
                matched.push((index, hits));
            }
        }
    }
    matched.sort_by(|a, b| {
        let (ra, rb) = (&ruleset.rules[a.0], &ruleset.rules[b.0]);
        ra.namespace.cmp(&rb.namespace).then_with(|| ra.name.cmp(&rb.name))
    });

    let mut evidence_budget = MAX_EVIDENCE_TOTAL;
    let mut evidence_budget_exhausted = false;
    let mut results_truncated = false;
    let mut capabilities: Vec<Value> = Vec::new();
    for (index, hits) in &matched {
        if capabilities.len() >= max_results {
            results_truncated = true;
            break;
        }
        let rule = &ruleset.rules[*index];
        let mut entry = json!({
            "name": clip(&rule.name, MAX_FIELD_CHARS),
            "namespace": clip(&rule.namespace, MAX_FIELD_CHARS),
            "scope": &rule.scope,
            "hits": hits,
            "lib": rule.lib,
            "degraded": rule.degraded,
        });
        if !rule.unsupported.is_empty() {
            entry["unsupported"] = json!(&rule.unsupported);
        }
        if !rule.attack.is_empty() {
            entry["attack"] = json!(&rule.attack);
        }
        if !rule.mbc.is_empty() {
            entry["mbc"] = json!(&rule.mbc);
        }
        if include_evidence {
            let evidence = evaluator.evidence(*index);
            let mut out: Vec<Value> = Vec::new();
            let mut evidence_truncated = evidence.len() > MAX_EVIDENCE_OUT;
            for item in evidence.iter().take(MAX_EVIDENCE_OUT) {
                if evidence_budget == 0 {
                    evidence_budget_exhausted = true;
                    evidence_truncated = true;
                    break;
                }
                evidence_budget -= 1;
                out.push(evidence_json(item));
            }
            entry["evidence"] = json!(out);
            if evidence_truncated {
                entry["evidence_truncated"] = json!(true);
            }
        }
        capabilities.push(entry);
    }

    let skipped_count: u64 = skipped_by_reason.values().sum();
    let mut truncated = results_truncated
        || evidence_budget_exhausted
        || evaluator.scan_truncated()
        || evaluator.budget_exhausted
        || features.truncated
        || features.strings_truncated;

    let mut report = json!({
        "schema_version": 1,
        "input": input_summary(input, &features),
        "features": features_summary(&features),
        "ruleset": ruleset_summary(ruleset),
        "capability_count": matched.len(),
        "capabilities": capabilities,
        "skipped_count": skipped_count,
        "skipped_by_reason": skipped_by_reason,
        "unsupported_features": &ruleset.unsupported_kinds,
        "scan_truncated": evaluator.scan_truncated(),
        "budget_exhausted": evaluator.budget_exhausted,
    });
    if lib_matched > 0 {
        report["lib_matched_count"] = json!(lib_matched);
    }
    if results_truncated {
        report["results_truncated"] = json!(true);
    }

    let mut warnings: Vec<String> = Vec::new();
    warnings.extend(features.warnings.iter().take(MAX_WARNINGS).cloned());
    for warning in &evaluator.warnings {
        if warnings.len() >= MAX_WARNINGS {
            break;
        }
        warnings.push(clip(warning, MAX_FIELD_CHARS));
    }
    if !ruleset.imported {
        warnings.push(
            "ruleset not imported: run script/import-upstream.sh and rebuild".to_string(),
        );
    }
    report["warnings"] = json!(warnings);

    if include_skipped {
        skipped.sort();
        let skipped_truncated = skipped.len() > MAX_SKIPPED_OUT;
        let list: Vec<Value> = skipped
            .iter()
            .take(MAX_SKIPPED_OUT)
            .map(|(name, reason, unsupported)| {
                let mut entry = json!({
                    "name": clip(name, MAX_FIELD_CHARS),
                    "reason": reason,
                });
                if !unsupported.is_empty() {
                    entry["unsupported"] = json!(unsupported);
                }
                entry
            })
            .collect();
        report["skipped_rules"] = json!(list);
        if skipped_truncated {
            report["skipped_rules_truncated"] = json!(true);
            truncated = true;
        }
    }

    report["truncated"] = json!(truncated);
    serialize(&report)
}

/// Full `capa_features` report body.
fn features_report(input: &[u8], options: &Map<String, Value>) -> Result<Value, String> {
    let max_strings = opt_u64(options, "maxStrings")?
        .map_or(256usize, |value| value.clamp(1, MAX_STRING_SAMPLE as u64) as usize);

    let features = extract::FeatureSet::extract(input);

    let sections: Vec<Value> = features
        .sections
        .iter()
        .take(extract::MAX_SECTIONS)
        .map(|section| {
            json!({
                "name": clip(&section.name, 64),
                "offset": section.offset,
                "size": section.size,
                "entropy": (section.entropy * 100.0).round() / 100.0,
            })
        })
        .collect();

    let imports: Vec<Value> = features
        .import_names
        .iter()
        .map(|(dll, name)| {
            json!({"dll": clip(dll, MAX_FIELD_CHARS), "name": clip(name, MAX_FIELD_CHARS)})
        })
        .collect();

    let exports: Vec<&String> = features.export_names.iter().collect();
    let libraries: Vec<&String> = features.libraries.iter().collect();

    let mut apis: Vec<&String> = features.apis.iter().collect();
    apis.sort();
    let apis_truncated = apis.len() > max_strings;
    let apis: Vec<&String> = apis.into_iter().take(max_strings).collect();

    let mut import_features: Vec<&String> = features.imports.iter().collect();
    import_features.sort();
    let import_features_truncated = import_features.len() > max_strings;
    let import_features: Vec<&String> = import_features.into_iter().take(max_strings).collect();

    let mut string_values: Vec<&String> = features.strings.keys().collect();
    string_values.sort();
    let strings_sample_truncated = string_values.len() > max_strings;
    let string_sample: Vec<Value> = string_values
        .into_iter()
        .take(max_strings)
        .map(|value| {
            let hits = &features.strings[value];
            json!({
                "value": clip(value, MAX_FIELD_CHARS),
                "count": hits.count,
                "locations": hits.locations,
            })
        })
        .collect();

    let truncated = features.truncated
        || features.strings_truncated
        || apis_truncated
        || import_features_truncated
        || strings_sample_truncated;

    Ok(json!({
        "schema_version": 1,
        "input": input_summary(input, &features),
        "formats": &features.formats,
        "os": &features.os,
        "arch": &features.arch,
        "sections": sections,
        "libraries": libraries,
        "imports": imports,
        "exports": exports,
        "api_features": apis,
        "api_features_truncated": apis_truncated,
        "import_features": import_features,
        "import_features_truncated": import_features_truncated,
        "strings": {
            "total": features.total_strings,
            "distinct": features.strings.len(),
            "truncated": features.strings_truncated,
            "sample": string_sample,
            "sample_truncated": strings_sample_truncated,
        },
        "embedded_pe": {
            "count": features.embedded_pe.len(),
            "offsets": &features.embedded_pe,
        },
        "forwarded_export": features.has_forwarded_export,
        "warnings": features.warnings.iter().take(MAX_WARNINGS).collect::<Vec<&String>>(),
        "truncated": truncated,
    }))
}

/// Full `capa_ruleset` report body.
fn ruleset_report(options: &Map<String, Value>, ruleset: &ast::Ruleset) -> Result<String, String> {
    let verbose = opt_bool(options, "verbose")?.unwrap_or(false);

    let mut skipped_by_reason: BTreeMap<String, u64> = BTreeMap::new();
    let mut lib_count: u64 = 0;
    let mut degraded_count: u64 = 0;
    for rule in &ruleset.rules {
        if let Some(reason) = &rule.skip_reason {
            *skipped_by_reason.entry(reason.clone()).or_default() += 1;
        }
        if rule.lib {
            lib_count += 1;
        }
        if rule.degraded {
            degraded_count += 1;
        }
    }
    let skipped_count: u64 = skipped_by_reason.values().sum();

    let mut namespaces: BTreeMap<String, u64> = BTreeMap::new();
    let mut namespaces_truncated = false;
    for (namespace, members) in &ruleset.ns_members {
        if namespaces.len() >= MAX_RESULTS {
            namespaces_truncated = true;
            break;
        }
        namespaces.insert(namespace.clone(), members.len() as u64);
    }

    let parse_errors: Vec<Value> = ruleset
        .parse_errors
        .iter()
        .take(MAX_ERRORS_OUT)
        .map(|(file, error)| {
            json!({"file": clip(file, MAX_FIELD_CHARS), "error": clip(error, MAX_FIELD_CHARS)})
        })
        .collect();
    let parse_errors_truncated = ruleset.parse_errors.len() > MAX_ERRORS_OUT;

    let mut report = json!({
        "schema_version": 1,
        "commit": &ruleset.commit,
        "imported": ruleset.imported,
        "rule_count": ruleset.rules.len(),
        "lib_count": lib_count,
        "degraded_count": degraded_count,
        "evaluable_count": ruleset.rules.len() as u64 - skipped_count,
        "skipped_count": skipped_count,
        "skipped_by_reason": skipped_by_reason,
        "namespace_count": namespaces.len(),
        "namespaces": namespaces,
        "unsupported_feature_kinds": &ruleset.unsupported_kinds,
        "exact_byte_patterns": ruleset.exact_bytes.len(),
        "parse_error_count": ruleset.parse_errors.len(),
        "parse_errors": parse_errors,
    });
    if !ruleset.imported {
        report["warnings"] = json!([
            "ruleset not imported: run script/import-upstream.sh and rebuild"
        ]);
    }
    let mut truncated = namespaces_truncated || parse_errors_truncated;
    if namespaces_truncated {
        report["namespaces_truncated"] = json!(true);
    }
    if parse_errors_truncated {
        report["parse_errors_truncated"] = json!(true);
    }

    if verbose {
        let rules: Vec<Value> = ruleset
            .rules
            .iter()
            .take(MAX_RESULTS)
            .map(|rule| {
                let mut entry = json!({
                    "name": clip(&rule.name, MAX_FIELD_CHARS),
                    "namespace": clip(&rule.namespace, MAX_FIELD_CHARS),
                    "file": clip(&rule.file, MAX_FIELD_CHARS),
                    "scope": &rule.scope,
                    "dynamic_scope": &rule.dynamic_scope,
                    "lib": rule.lib,
                    "degraded": rule.degraded,
                });
                if let Some(description) = &rule.description {
                    entry["description"] = json!(clip(description, MAX_FIELD_CHARS));
                }
                if let Some(reason) = &rule.skip_reason {
                    entry["skip_reason"] = json!(reason);
                }
                if !rule.unsupported.is_empty() {
                    entry["unsupported"] = json!(&rule.unsupported);
                }
                entry
            })
            .collect();
        if ruleset.rules.len() > MAX_RESULTS {
            report["rules_truncated"] = json!(true);
            truncated = true;
        }
        report["rules"] = json!(rules);
    }

    report["truncated"] = json!(truncated);
    serialize(&report)
}
