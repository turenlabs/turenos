//! Bounded text encoding detection, transcoding, and Unicode security audit
//! for Turen agent tools.
//!
//! Wraps `chardetng` (Mozilla encoding detection), `encoding_rs` (WHATWG
//! Encoding Standard transcoding), `unicode-normalization`, and
//! `unicode-script` behind deterministic wasm-bindgen entry points that accept
//! the input bytes plus a small JSON options document and return bounded JSON.
//! Everything is read-only and offline: no filesystem, network, environment,
//! clock, subprocess, or analyzed-code-execution capability is exposed.
//!
//! Hard limits (enforced before expensive allocation or serialization):
//!   input bytes          32 MiB
//!   options JSON          4 KiB
//!   JSON output           4 MiB
//!   audit findings     4,096
//!   decoded text          8 MiB (transcode emits at most ~4 MiB escaped)
//!   finding context     128 bytes per finding
//!
//! Every success and error document carries `"schema_version": 1`. Errors are
//! JSON documents (`{"schema_version":1,"error":"<code>"}`), never traps.

use chardetng::{EncodingDetector, Iso2022JpDetection, Utf8Detection};
use encoding_rs::{Encoding, UTF_8};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use unicode_normalization::UnicodeNormalization;
use unicode_script::{Script, UnicodeScript};
use wasm_bindgen::prelude::*;

const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_OPTIONS_BYTES: usize = 4 * 1024;
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_FINDINGS: usize = 4096;
const MAX_DECODED_BYTES: usize = 8 * 1024 * 1024;
/// Headroom reserved for the non-`text` fields of a transcode result so the
/// serialized document always fits inside `MAX_OUTPUT_BYTES`.
const TEXT_FIELD_HEADROOM: usize = 64 * 1024;
const DEFAULT_CONTEXT_BYTES: usize = 40;
const MAX_CONTEXT_BYTES: usize = 128;
const MAX_IDENTIFIER_CHARS: usize = 64;
const MAX_SCRIPT_BUCKETS: usize = 64;
const UTF16_HEURISTIC_SAMPLE: usize = 8192;

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/// Error documents follow the repository convention:
/// `{"schema_version":1,"error":"<code>","message":"<detail>"}`.
fn error_json(code: &str, message: &str) -> String {
    let mut obj = Map::new();
    obj.insert("schema_version".into(), Value::from(1));
    obj.insert("error".into(), Value::from(code));
    obj.insert("message".into(), Value::from(message));
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

fn parse_options<T: for<'de> Deserialize<'de>>(options_json: &str) -> Result<T, String>
where
    T: Default,
{
    if options_json.trim().is_empty() {
        return Ok(T::default());
    }
    serde_json::from_str(options_json)
        .map_err(|error| error_json("options_invalid", &error.to_string()))
}

/// chardetng panics on a TLD that is not a lower-case ASCII DNS label, so the
/// option is validated before it ever reaches the detector.
fn validate_tld(tld: &str) -> bool {
    !tld.is_empty()
        && tld.len() <= 63
        && tld
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

// ---------------------------------------------------------------------------
// Encoding detection helpers
// ---------------------------------------------------------------------------

fn bom_kind(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        Some("utf-8")
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        Some("utf-16le")
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        Some("utf-16be")
    } else {
        None
    }
}

/// Byte-pattern heuristic for BOM-less UTF-16: ASCII-heavy UTF-16LE text has
/// NUL bytes concentrated at odd positions and UTF-16BE at even positions.
fn utf16_heuristic(bytes: &[u8]) -> (bool, bool) {
    let n = bytes.len().min(UTF16_HEURISTIC_SAMPLE) & !1;
    if n < 8 {
        return (false, false);
    }
    let mut even_nul = 0usize;
    let mut odd_nul = 0usize;
    for (index, &byte) in bytes[..n].iter().enumerate() {
        if byte == 0 {
            if index & 1 == 0 {
                even_nul += 1;
            } else {
                odd_nul += 1;
            }
        }
    }
    let pairs = n / 2;
    let le = odd_nul * 5 >= pairs && odd_nul > even_nul.saturating_mul(4).max(2);
    let be = even_nul * 5 >= pairs && even_nul > odd_nul.saturating_mul(4).max(2);
    (le, be)
}

struct Detection {
    encoding: &'static Encoding,
    bom: Option<&'static str>,
    ascii_only: bool,
    utf8_valid: bool,
    utf16_le_likely: bool,
    utf16_be_likely: bool,
    nulls: usize,
}

fn detect_encoding(bytes: &[u8], tld: Option<&[u8]>, allow_iso2022jp: bool) -> Detection {
    let bom = bom_kind(bytes);
    // WHATWG encoding sniffing checks a byte-order mark before statistical
    // detection; chardetng itself never guesses UTF-16, so BOM handling
    // lives here.
    let encoding = match bom {
        Some("utf-8") => UTF_8,
        Some("utf-16le") => encoding_rs::UTF_16LE,
        Some("utf-16be") => encoding_rs::UTF_16BE,
        _ => {
            let mut detector = EncodingDetector::new(if allow_iso2022jp {
                Iso2022JpDetection::Allow
            } else {
                Iso2022JpDetection::Deny
            });
            detector.feed(bytes, true);
            detector.guess(tld, Utf8Detection::Allow)
        }
    };
    let (utf16_le_likely, utf16_be_likely) = utf16_heuristic(bytes);
    Detection {
        encoding,
        bom,
        ascii_only: bytes.is_ascii(),
        utf8_valid: std::str::from_utf8(bytes).is_ok(),
        utf16_le_likely,
        utf16_be_likely,
        nulls: bytes.iter().filter(|&&b| b == 0).count(),
    }
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
struct DetectOptions {
    /// Optional lower-case ASCII DNS top-level label that may influence the
    /// guess, mirroring the chardetng API.
    tld: Option<String>,
    /// Whether ISO-2022-JP is a permissible guess (default true).
    #[serde(alias = "iso2022Jp")]
    iso2022jp: Option<bool>,
}

/// Detect the likely encoding of `bytes`.
///
/// Options: `{"tld": "<lower-case-dns-label>", "iso2022jp": <bool>}`
#[wasm_bindgen]
pub fn text_detect(bytes: &[u8], options_json: &str) -> String {
    if let Some(error) = check_limits(bytes, options_json) {
        return error;
    }
    let options: DetectOptions = match parse_options(options_json) {
        Ok(options) => options,
        Err(error) => return error,
    };
    let tld = match &options.tld {
        Some(tld) if validate_tld(tld) => Some(tld.as_bytes()),
        Some(_) => {
            return error_json(
                "options_invalid",
                "tld must be a lower-case ASCII DNS label",
            )
        }
        None => None,
    };
    let detection = detect_encoding(bytes, tld, options.iso2022jp.unwrap_or(true));
    let (decoded, _actual, had_errors) = detection.encoding.decode(bytes);
    let replacement_chars = decoded.chars().filter(|&c| c == '\u{FFFD}').count();
    let confidence = if detection.bom.is_some()
        || detection.ascii_only
        || (detection.encoding == UTF_8 && detection.utf8_valid && !had_errors)
    {
        "high"
    } else if had_errors {
        "low"
    } else {
        "medium"
    };
    let null_ratio = if bytes.is_empty() {
        0.0
    } else {
        ((detection.nulls as f64 / bytes.len() as f64) * 10_000.0).round() / 10_000.0
    };
    finish(json!({
        "schema_version": 1,
        "input_bytes": bytes.len(),
        "encoding": detection.encoding.name(),
        "confidence": confidence,
        "bom": detection.bom,
        "ascii_only": detection.ascii_only,
        "utf8_valid": detection.utf8_valid,
        "utf16_le_likely": detection.utf16_le_likely,
        "utf16_be_likely": detection.utf16_be_likely,
        "null_byte_ratio": null_ratio,
        "had_errors": had_errors,
        "replacement_chars": replacement_chars,
    }))
}

#[derive(Deserialize, Default)]
struct TranscodeOptions {
    /// WHATWG encoding label of the source, or "auto" (default) to guess via
    /// chardetng.
    from: Option<String>,
    /// Target encoding. Only UTF-8 is supported because output is JSON text.
    to: Option<String>,
    /// Optional Unicode normalization form: nfc, nfd, nfkc, nfkd.
    normalize: Option<String>,
}

/// Decode `bytes` from a known or detected encoding and return bounded UTF-8
/// text (optionally normalized).
///
/// Options: `{"from": "<label>|auto", "to": "utf-8", "normalize": "nfc|nfd|nfkc|nfkd"}`
#[wasm_bindgen]
pub fn text_transcode(bytes: &[u8], options_json: &str) -> String {
    if let Some(error) = check_limits(bytes, options_json) {
        return error;
    }
    let options: TranscodeOptions = match parse_options(options_json) {
        Ok(options) => options,
        Err(error) => return error,
    };
    let source = match &options.from {
        Some(label) => match resolve_encoding_label(label, bytes) {
            Ok(encoding) => encoding,
            Err(error) => return error,
        },
        None => detect_encoding(bytes, None, true).encoding,
    };
    if let Some(target) = &options.to {
        let trimmed = target.trim();
        let is_utf8 = trimmed.is_empty()
            || trimmed.eq_ignore_ascii_case("utf-8")
            || Encoding::for_label(trimmed.as_bytes()) == Some(UTF_8);
        if !is_utf8 {
            return error_json(
                "unsupported_target_encoding",
                "transcode output is always UTF-8; only utf-8 targets are supported",
            );
        }
    }
    let normalize = match &options.normalize {
        Some(form) => match form.to_ascii_lowercase().as_str() {
            "nfc" | "nfd" | "nfkc" | "nfkd" => Some(form.to_ascii_lowercase()),
            _ => {
                return error_json(
                    "invalid_normalize",
                    "normalize must be one of nfc, nfd, nfkc, nfkd",
                )
            }
        },
        None => None,
    };

    let (decoded, actual, had_errors) = source.decode(bytes);
    let decoded_bytes = decoded.len();
    // Bound the decoded text at 8 MiB on a char boundary before normalization.
    let mut truncated = false;
    let text = if decoded.len() > MAX_DECODED_BYTES {
        truncated = true;
        let mut end = MAX_DECODED_BYTES;
        while end > 0 && !decoded.is_char_boundary(end) {
            end -= 1;
        }
        decoded[..end].to_string()
    } else {
        decoded.into_owned()
    };
    let replacement_chars = text.chars().filter(|&c| c == '\u{FFFD}').count();
    let (text, normalized) = match &normalize {
        Some(form) => {
            let (norm_text, norm_truncated) = normalize_bounded(&text, form);
            truncated |= norm_truncated;
            (norm_text, Some(form.as_str()))
        }
        None => (text, None),
    };
    // Bound the emitted text by its JSON-escaped length so the document can
    // never exceed the output cap.
    let budget = MAX_OUTPUT_BYTES - TEXT_FIELD_HEADROOM;
    let (emit, emit_truncated) = cap_json_escaped(&text, budget);
    truncated |= emit_truncated;
    finish(json!({
        "schema_version": 1,
        "input_bytes": bytes.len(),
        "from": actual.name(),
        "to": "utf-8",
        "normalize": normalized,
        "had_errors": had_errors,
        "replacement_chars": replacement_chars,
        "decoded_bytes": decoded_bytes,
        "text_bytes": emit.len(),
        "text": emit,
        "truncated": truncated,
    }))
}

fn resolve_encoding_label(label: &str, bytes: &[u8]) -> Result<&'static Encoding, String> {
    let trimmed = label.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("auto") {
        return Ok(detect_encoding(bytes, None, true).encoding);
    }
    Encoding::for_label(trimmed.as_bytes()).ok_or_else(|| {
        error_json(
            "unknown_encoding",
            "from label is not a WHATWG encoding label",
        )
    })
}

fn normalize_bounded(text: &str, form: &str) -> (String, bool) {
    fn push_all(iter: &mut dyn Iterator<Item = char>, out: &mut String) -> bool {
        for ch in iter {
            if out.len() + ch.len_utf8() > MAX_DECODED_BYTES {
                return true;
            }
            out.push(ch);
        }
        false
    }
    let mut out = String::new();
    let truncated = match form {
        "nfc" => push_all(&mut text.chars().nfc(), &mut out),
        "nfd" => push_all(&mut text.chars().nfd(), &mut out),
        "nfkc" => push_all(&mut text.chars().nfkc(), &mut out),
        _ => push_all(&mut text.chars().nfkd(), &mut out),
    };
    (out, truncated)
}

/// Longest JSON-escaped prefix of `text` whose escaped length fits `budget`.
/// Escape sizes mirror serde_json exactly: `"` and `\` become two bytes,
/// \n \r \t \b \f become two bytes, other C0 controls become `\u00XX` (six
/// bytes), everything else is emitted as raw UTF-8.
fn cap_json_escaped(text: &str, budget: usize) -> (String, bool) {
    let mut used = 0usize;
    for (index, ch) in text.char_indices() {
        let cost = match ch {
            '"' | '\\' | '\n' | '\r' | '\t' | '\u{0008}' | '\u{000C}' => 2,
            c if (c as u32) < 0x20 => 6,
            c => c.len_utf8(),
        };
        if used + cost > budget {
            return (text[..index].to_string(), true);
        }
        used += cost;
    }
    (text.to_string(), false)
}

#[derive(Deserialize)]
struct AuditOptions {
    /// Maximum findings returned (default 4096, clamped to 1..=4096).
    #[serde(default = "default_max_findings", alias = "maxFindings")]
    max_findings: usize,
    /// Bytes of decoded text quoted around each finding (default 40, max 128).
    #[serde(default = "default_context_bytes", alias = "contextBytes")]
    context_bytes: usize,
}

impl Default for AuditOptions {
    fn default() -> Self {
        Self {
            max_findings: MAX_FINDINGS,
            context_bytes: DEFAULT_CONTEXT_BYTES,
        }
    }
}

fn default_max_findings() -> usize {
    MAX_FINDINGS
}

fn default_context_bytes() -> usize {
    DEFAULT_CONTEXT_BYTES
}

/// Audit `bytes` for Unicode security issues: Trojan-Source bidi controls,
/// invisible/zero-width characters, unusual whitespace, mixed-script
/// identifiers, stray control characters, and bidirectional spans whose
/// display order diverges from storage order.
///
/// The input is decoded as UTF-8 with lossy replacement before scanning; byte
/// offsets, lines, and columns refer to that decoded view.
///
/// Options: `{"maxFindings": <usize>, "contextBytes": <usize>}` — both
/// camelCase and snake_case keys are accepted.
#[wasm_bindgen]
pub fn unicode_audit(bytes: &[u8], options_json: &str) -> String {
    if let Some(error) = check_limits(bytes, options_json) {
        return error;
    }
    let options: AuditOptions = match parse_options(options_json) {
        Ok(options) => options,
        Err(error) => return error,
    };
    let max_findings = options.max_findings.clamp(1, MAX_FINDINGS);
    let context_bytes = options.context_bytes.min(MAX_CONTEXT_BYTES);

    let decoded = String::from_utf8_lossy(bytes);
    let replacement_chars = decoded.chars().filter(|&c| c == '\u{FFFD}').count();
    let decoded_had_errors = replacement_chars > 0;

    let mut scanned_end = decoded.len().min(MAX_DECODED_BYTES);
    while scanned_end > 0 && !decoded.is_char_boundary(scanned_end) {
        scanned_end -= 1;
    }
    let scan_truncated = scanned_end < decoded.len();
    let text = &decoded[..scanned_end];

    let detection = detect_encoding(bytes, None, true);

    let mut collector = FindingCollector {
        text,
        context_bytes,
        findings: Vec::new(),
    };
    collector.scan_chars();
    collector.scan_bidi_spans();
    collector.finish();

    let total = collector.findings.len();
    let keep = total.min(max_findings);
    let dropped = total - keep;
    collector.findings.truncate(keep);

    let mut summary = Map::new();
    let mut risk = "none";
    for finding in &collector.findings {
        let entry = summary.entry(finding.kind).or_insert(Value::from(0));
        *entry = Value::from(entry.as_u64().unwrap_or(0) + 1);
        risk = match finding.severity() {
            Severity::High => "high",
            Severity::Medium if risk != "high" => "medium",
            Severity::Low if risk == "none" || risk == "low" => "low",
            _ => risk,
        };
    }
    summary.insert("total".into(), Value::from(collector.findings.len() as u64));

    let mut warnings = Vec::new();
    if detection.encoding != UTF_8 || detection.bom == Some("utf-16le") || detection.bom == Some("utf-16be") {
        warnings.push(format!(
            "input detected as {}; audit scanned the lossy UTF-8 view, transcode first for accurate offsets",
            detection.encoding.name()
        ));
    }
    if scan_truncated {
        warnings.push(format!(
            "decoded input exceeded {} bytes; only the prefix was audited",
            MAX_DECODED_BYTES
        ));
    }

    finish(json!({
        "schema_version": 1,
        "input_bytes": bytes.len(),
        "scanned_bytes": scanned_end,
        "detected_encoding": detection.encoding.name(),
        "bom": detection.bom,
        "decoded_had_errors": decoded_had_errors,
        "replacement_chars": replacement_chars,
        "risk": risk,
        "summary": Value::Object(summary),
        "findings": collector.findings.iter().map(Finding::to_json).collect::<Vec<_>>(),
        "findings_dropped": dropped,
        "truncated": dropped > 0 || scan_truncated,
        "warnings": warnings,
    }))
}

#[derive(Deserialize, Default)]
struct StatsOptions {
    /// Encoding used to decode for statistics: a WHATWG label or "auto"
    /// (default) to guess via chardetng.
    encoding: Option<String>,
    tld: Option<String>,
}

/// Line, codepoint, script-histogram, and cleanliness statistics for `bytes`.
///
/// Options: `{"encoding": "<label>|auto", "tld": "<lower-case-dns-label>"}`
#[wasm_bindgen]
pub fn text_stats(bytes: &[u8], options_json: &str) -> String {
    if let Some(error) = check_limits(bytes, options_json) {
        return error;
    }
    let options: StatsOptions = match parse_options(options_json) {
        Ok(options) => options,
        Err(error) => return error,
    };
    let tld = match &options.tld {
        Some(tld) if validate_tld(tld) => Some(tld.as_bytes()),
        Some(_) => {
            return error_json(
                "options_invalid",
                "tld must be a lower-case ASCII DNS label",
            )
        }
        None => None,
    };
    let detection = detect_encoding(bytes, tld, true);
    let source = match &options.encoding {
        Some(label) => match resolve_encoding_label(label, bytes) {
            Ok(encoding) => encoding,
            Err(error) => return error,
        },
        None => detection.encoding,
    };
    let (decoded, actual, had_errors) = source.decode(bytes);
    let mut scanned_end = decoded.len().min(MAX_DECODED_BYTES);
    while scanned_end > 0 && !decoded.is_char_boundary(scanned_end) {
        scanned_end -= 1;
    }
    let text = &decoded[..scanned_end];

    let mut codepoints = 0u64;
    let mut newlines = 0u64;
    let mut control_chars = 0u64;
    let mut nonprintable = 0u64;
    let mut replacement_chars = 0u64;
    let mut longest_line_codepoints = 0u64;
    let mut longest_line_bytes = 0u64;
    let mut longest_line_number = 0u64;
    let mut line_codepoints = 0u64;
    let mut line_start = 0usize;
    let mut line_number = 1u64;
    let mut scripts: Vec<(Script, u64)> = Vec::new();

    for (offset, ch) in text.char_indices() {
        codepoints += 1;
        line_codepoints += 1;
        if ch == '\n' {
            newlines += 1;
            if line_codepoints - 1 > longest_line_codepoints
                || (line_codepoints - 1 == longest_line_codepoints
                    && offset - line_start > longest_line_bytes as usize)
            {
                longest_line_codepoints = line_codepoints - 1;
                longest_line_bytes = (offset - line_start) as u64;
                longest_line_number = line_number;
            }
            line_codepoints = 0;
            line_start = offset + 1;
            line_number += 1;
            continue;
        }
        if ch == '\u{FFFD}' {
            replacement_chars += 1;
        }
        if ch.is_control() && ch != '\t' && ch != '\r' {
            control_chars += 1;
            nonprintable += 1;
        } else if bidi_control_name(ch).is_some()
            || bidi_mark_name(ch).is_some()
            || invisible_name(ch).is_some()
        {
            nonprintable += 1;
        }
        if ch.is_alphabetic() {
            let script = ch.script();
            match scripts.iter_mut().find(|(s, _)| *s == script) {
                Some((_, count)) => *count += 1,
                None => scripts.push((script, 1)),
            }
        }
    }
    if line_codepoints > longest_line_codepoints
        || (line_codepoints == longest_line_codepoints
            && text.len() - line_start > longest_line_bytes as usize)
    {
        longest_line_codepoints = line_codepoints;
        longest_line_bytes = (text.len() - line_start) as u64;
        longest_line_number = line_number;
    }
    let lines = if text.is_empty() {
        0
    } else {
        newlines + u64::from(!text.ends_with('\n'))
    };

    scripts.sort_by(|a, b| b.1.cmp(&a.1).then(script_name(a.0).cmp(script_name(b.0))));
    scripts.truncate(MAX_SCRIPT_BUCKETS);
    let histogram: Vec<Value> = scripts
        .iter()
        .map(|(script, count)| json!({"script": script_name(*script), "chars": count}))
        .collect();

    finish(json!({
        "schema_version": 1,
        "input_bytes": bytes.len(),
        "encoding": actual.name(),
        "bom": detection.bom,
        "ascii_only": detection.ascii_only,
        "decoded_had_errors": had_errors,
        "replacement_chars": replacement_chars,
        "codepoints": codepoints,
        "lines": lines,
        "longest_line": {
            "line": longest_line_number,
            "codepoints": longest_line_codepoints,
            "bytes": longest_line_bytes,
        },
        "control_chars": control_chars,
        "nonprintable_chars": nonprintable,
        "scripts": histogram,
        "truncated": scanned_end < decoded.len(),
    }))
}

// ---------------------------------------------------------------------------
// Audit internals
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Severity {
    Low,
    Medium,
    High,
}

struct Finding {
    kind: &'static str,
    offset: usize,
    line: u64,
    col: u64,
    codepoint: Option<u32>,
    name: Option<String>,
    length: Option<usize>,
    scripts: Option<Vec<String>>,
    identifier: Option<String>,
    context: String,
    severity: Severity,
}

impl Finding {
    fn severity(&self) -> Severity {
        self.severity
    }

    fn to_json(&self) -> Value {
        let mut obj = Map::new();
        obj.insert("kind".into(), Value::from(self.kind));
        obj.insert("offset".into(), Value::from(self.offset as u64));
        obj.insert("line".into(), Value::from(self.line));
        obj.insert("col".into(), Value::from(self.col));
        if let Some(codepoint) = self.codepoint {
            obj.insert("codepoint".into(), Value::from(format!("U+{codepoint:04X}")));
        }
        if let Some(name) = &self.name {
            obj.insert("name".into(), Value::from(name.as_str()));
        }
        if let Some(length) = self.length {
            obj.insert("length".into(), Value::from(length as u64));
        }
        if let Some(scripts) = &self.scripts {
            obj.insert(
                "scripts".into(),
                Value::from(scripts.iter().map(|s| Value::from(s.as_str())).collect::<Vec<_>>()),
            );
        }
        if let Some(identifier) = &self.identifier {
            obj.insert("identifier".into(), Value::from(identifier.as_str()));
        }
        obj.insert("context".into(), Value::from(self.context.as_str()));
        Value::Object(obj)
    }
}

struct FindingCollector<'a> {
    text: &'a str,
    context_bytes: usize,
    findings: Vec<Finding>,
}

impl FindingCollector<'_> {
    fn context_at(&self, offset: usize) -> String {
        context_window(self.text, offset, self.context_bytes)
    }

    fn push(&mut self, finding: Finding) {
        self.findings.push(finding);
    }

    /// Pass 1: per-character findings (bidi controls/marks, invisible chars,
    /// unusual whitespace, stray controls) plus mixed-script identifiers.
    #[allow(unused_assignments)]
    fn scan_chars(&mut self) {
        let mut line = 1u64;
        let mut col = 1u64;
        // Current identifier token state.
        let mut tok_start = 0usize;
        let mut tok_col = 1u64;
        let mut tok_scripts: Vec<Script> = Vec::new();
        let mut tok_first_script: Option<Script> = None;
        let mut tok_intruder: Option<(char, usize)> = None;
        let mut tok_chars = 0usize;

        macro_rules! flush_token {
            ($end:expr) => {
                if tok_chars > 1
                    && tok_scripts.len() >= 2
                    && tok_scripts.iter().any(|s| {
                        matches!(*s, Script::Latin | Script::Greek | Script::Cyrillic)
                    })
                {
                    let mut names: Vec<String> = tok_scripts
                        .iter()
                        .map(|s| script_name(*s).to_string())
                        .collect();
                    names.sort();
                    let identifier: String = self
                        .text
                        .get(tok_start..$end)
                        .unwrap_or("")
                        .chars()
                        .take(MAX_IDENTIFIER_CHARS)
                        .collect();
                    let (codepoint, name) = match tok_intruder {
                        Some((ch, _)) => (
                            Some(ch as u32),
                            Some(format!(
                                "{} in identifier",
                                unicode_name_or_script(ch)
                            )),
                        ),
                        None => (None, Some("mixed-script identifier".to_string())),
                    };
                    self.findings.push(Finding {
                        kind: "mixed_script_identifier",
                        offset: tok_start,
                        line,
                        col: tok_col,
                        codepoint,
                        name,
                        length: Some($end - tok_start),
                        scripts: Some(names),
                        identifier: Some(identifier),
                        context: self.context_at(tok_start),
                        severity: Severity::High,
                    });
                }
                tok_scripts.clear();
                tok_first_script = None;
                tok_intruder = None;
                tok_chars = 0;
            };
        }

        for (offset, ch) in self.text.char_indices() {
            // Identifier token tracking.
            if is_ident_char(ch) {
                if tok_chars == 0 {
                    tok_start = offset;
                    tok_col = col;
                }
                tok_chars += 1;
                if ch.is_alphabetic() {
                    let script = ch.script();
                    if !matches!(script, Script::Common | Script::Inherited | Script::Unknown) {
                        if !tok_scripts.contains(&script) {
                            tok_scripts.push(script);
                        }
                        match tok_first_script {
                            None => tok_first_script = Some(script),
                            Some(first) if first != script && tok_intruder.is_none() => {
                                tok_intruder = Some((ch, offset));
                            }
                            _ => {}
                        }
                    }
                }
            } else {
                flush_token!(offset);
            }

            // Per-character findings.
            if let Some(name) = bidi_control_name(ch) {
                self.push(Finding {
                    kind: "bidi_control",
                    offset,
                    line,
                    col,
                    codepoint: Some(ch as u32),
                    name: Some(name.to_string()),
                    length: None,
                    scripts: None,
                    identifier: None,
                    context: self.context_at(offset),
                    severity: Severity::High,
                });
            } else if let Some(name) = bidi_mark_name(ch) {
                self.push(Finding {
                    kind: "bidi_mark",
                    offset,
                    line,
                    col,
                    codepoint: Some(ch as u32),
                    name: Some(name.to_string()),
                    length: None,
                    scripts: None,
                    identifier: None,
                    context: self.context_at(offset),
                    severity: Severity::Medium,
                });
            } else if let Some(name) = invisible_name(ch) {
                self.push(Finding {
                    kind: "invisible_char",
                    offset,
                    line,
                    col,
                    codepoint: Some(ch as u32),
                    name: Some(name.to_string()),
                    length: None,
                    scripts: None,
                    identifier: None,
                    context: self.context_at(offset),
                    severity: Severity::Medium,
                });
            } else if let Some(name) = unusual_whitespace_name(ch) {
                self.push(Finding {
                    kind: "unusual_whitespace",
                    offset,
                    line,
                    col,
                    codepoint: Some(ch as u32),
                    name: Some(name.to_string()),
                    length: None,
                    scripts: None,
                    identifier: None,
                    context: self.context_at(offset),
                    severity: Severity::Low,
                });
            } else if ch.is_control() && ch != '\t' && ch != '\n' && ch != '\r' {
                self.push(Finding {
                    kind: "control_char",
                    offset,
                    line,
                    col,
                    codepoint: Some(ch as u32),
                    name: Some(control_name(ch).to_string()),
                    length: None,
                    scripts: None,
                    identifier: None,
                    context: self.context_at(offset),
                    severity: Severity::Medium,
                });
            }

            if ch == '\n' {
                line += 1;
                col = 1;
            } else {
                col += 1;
            }
        }
        flush_token!(self.text.len());
    }

    /// Pass 2: per-line bidirectional spans — maximal runs of RTL-script
    /// characters in lines that also contain non-RTL alphanumeric content,
    /// where display order diverges from storage order.
    fn scan_bidi_spans(&mut self) {
        let mut offset = 0usize;
        for (line_index, raw_line) in self.text.split('\n').enumerate() {
            let line = (line_index + 1) as u64;
            let line_has_ltr = raw_line
                .chars()
                .any(|c| c.is_alphanumeric() && !rtl_script(c.script()));
            if line_has_ltr {
                let mut run_start: Option<usize> = None;
                let mut run_col = 0u64;
                let mut run_scripts: Vec<Script> = Vec::new();
                let mut col = 1u64;
                for (rel, ch) in raw_line.char_indices() {
                    let script = ch.script();
                    if rtl_script(script) {
                        if run_start.is_none() {
                            run_start = Some(offset + rel);
                            run_col = col;
                        }
                        if !run_scripts.contains(&script) {
                            run_scripts.push(script);
                        }
                    } else if let Some(start) = run_start.take() {
                        self.emit_span(start, offset + rel - start, line, run_col, &run_scripts);
                        run_scripts.clear();
                    }
                    col += 1;
                }
                if let Some(start) = run_start.take() {
                    self.emit_span(
                        start,
                        offset + raw_line.len() - start,
                        line,
                        run_col,
                        &run_scripts,
                    );
                }
            }
            offset += raw_line.len() + 1;
        }
    }

    fn emit_span(
        &mut self,
        offset: usize,
        length: usize,
        line: u64,
        col: u64,
        scripts: &[Script],
    ) {
        let mut names: Vec<String> = scripts
            .iter()
            .map(|s| script_name(*s).to_string())
            .collect();
        names.sort();
        self.push(Finding {
            kind: "bidi_reorder_span",
            offset,
            line,
            col,
            codepoint: None,
            name: Some("right-to-left span in left-to-right context".to_string()),
            length: Some(length),
            scripts: Some(names),
            identifier: None,
            context: self.context_at(offset),
            severity: Severity::Medium,
        });
    }

    fn finish(&mut self) {
        self.findings.sort_by_key(|f| (f.offset, f.kind));
    }
}

/// A ~`context_bytes` window of `text` centered on `offset`, snapped to char
/// boundaries.
fn context_window(text: &str, offset: usize, context_bytes: usize) -> String {
    if context_bytes == 0 {
        return String::new();
    }
    let half = context_bytes / 2;
    let mut start = offset.saturating_sub(half);
    while start > 0 && !text.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (offset + context_bytes.saturating_sub(offset - start)).min(text.len());
    while end < text.len() && !text.is_char_boundary(end) {
        end += 1;
    }
    text.get(start..end).unwrap_or("").to_string()
}

fn is_ident_char(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_' || ch == '$'
}

fn script_name(script: Script) -> &'static str {
    script.full_name()
}

fn unicode_name_or_script(ch: char) -> String {
    let named = bidi_control_name(ch)
        .or_else(|| bidi_mark_name(ch))
        .or_else(|| invisible_name(ch))
        .or_else(|| unusual_whitespace_name(ch));
    match named {
        Some(name) => name.to_string(),
        None => format!("{} script character", script_name(ch.script())),
    }
}

fn bidi_control_name(ch: char) -> Option<&'static str> {
    Some(match ch {
        '\u{202A}' => "LEFT-TO-RIGHT EMBEDDING",
        '\u{202B}' => "RIGHT-TO-LEFT EMBEDDING",
        '\u{202C}' => "POP DIRECTIONAL FORMATTING",
        '\u{202D}' => "LEFT-TO-RIGHT OVERRIDE",
        '\u{202E}' => "RIGHT-TO-LEFT OVERRIDE",
        '\u{2066}' => "LEFT-TO-RIGHT ISOLATE",
        '\u{2067}' => "RIGHT-TO-LEFT ISOLATE",
        '\u{2068}' => "FIRST STRONG ISOLATE",
        '\u{2069}' => "POP DIRECTIONAL ISOLATE",
        _ => return None,
    })
}

fn bidi_mark_name(ch: char) -> Option<&'static str> {
    Some(match ch {
        '\u{200E}' => "LEFT-TO-RIGHT MARK",
        '\u{200F}' => "RIGHT-TO-LEFT MARK",
        '\u{061C}' => "ARABIC LETTER MARK",
        _ => return None,
    })
}

fn invisible_name(ch: char) -> Option<&'static str> {
    Some(match ch {
        '\u{00AD}' => "SOFT HYPHEN",
        '\u{115F}' => "HANGUL CHOSEONG FILLER",
        '\u{1160}' => "HANGUL JUNGSEONG FILLER",
        '\u{180E}' => "MONGOLIAN VOWEL SEPARATOR",
        '\u{200B}' => "ZERO WIDTH SPACE",
        '\u{200C}' => "ZERO WIDTH NON-JOINER",
        '\u{200D}' => "ZERO WIDTH JOINER",
        '\u{2060}' => "WORD JOINER",
        '\u{2061}' => "FUNCTION APPLICATION",
        '\u{2062}' => "INVISIBLE TIMES",
        '\u{2063}' => "INVISIBLE SEPARATOR",
        '\u{2064}' => "INVISIBLE PLUS",
        '\u{3164}' => "HANGUL FILLER",
        '\u{FEFF}' => "ZERO WIDTH NO-BREAK SPACE",
        '\u{FFA0}' => "HALFWIDTH HANGUL FILLER",
        '\u{FFF9}' => "INTERLINEAR ANNOTATION ANCHOR",
        '\u{FFFA}' => "INTERLINEAR ANNOTATION SEPARATOR",
        '\u{FFFB}' => "INTERLINEAR ANNOTATION TERMINATOR",
        '\u{E0000}'..='\u{E007F}' => "TAG CHARACTER",
        '\u{E0100}'..='\u{E01EF}' => "VARIATION SELECTOR (SUPPLEMENT)",
        _ => return None,
    })
}

fn unusual_whitespace_name(ch: char) -> Option<&'static str> {
    Some(match ch {
        '\u{00A0}' => "NO-BREAK SPACE",
        '\u{1680}' => "OGHAM SPACE MARK",
        '\u{2000}' => "EN QUAD",
        '\u{2001}' => "EM QUAD",
        '\u{2002}' => "EN SPACE",
        '\u{2003}' => "EM SPACE",
        '\u{2004}' => "THREE-PER-EM SPACE",
        '\u{2005}' => "FOUR-PER-EM SPACE",
        '\u{2006}' => "SIX-PER-EM SPACE",
        '\u{2007}' => "FIGURE SPACE",
        '\u{2008}' => "PUNCTUATION SPACE",
        '\u{2009}' => "THIN SPACE",
        '\u{200A}' => "HAIR SPACE",
        '\u{2028}' => "LINE SEPARATOR",
        '\u{2029}' => "PARAGRAPH SEPARATOR",
        '\u{202F}' => "NARROW NO-BREAK SPACE",
        '\u{205F}' => "MEDIUM MATHEMATICAL SPACE",
        '\u{3000}' => "IDEOGRAPHIC SPACE",
        _ => return None,
    })
}

fn control_name(ch: char) -> &'static str {
    match ch {
        '\u{0000}' => "NULL",
        '\u{0007}' => "BELL",
        '\u{0008}' => "BACKSPACE",
        '\u{000B}' => "VERTICAL TAB",
        '\u{000C}' => "FORM FEED",
        '\u{001B}' => "ESCAPE",
        '\u{007F}' => "DELETE",
        '\u{0085}' => "NEXT LINE",
        c if (c as u32) < 0x20 => "C0 CONTROL",
        _ => "C1 CONTROL",
    }
}

/// Scripts whose characters are strong right-to-left in the Unicode
/// Bidirectional Algorithm.
fn rtl_script(script: Script) -> bool {
    matches!(
        script,
        Script::Adlam
            | Script::Arabic
            | Script::Avestan
            | Script::Carian
            | Script::Chorasmian
            | Script::Cypriot
            | Script::Elymaic
            | Script::Hanifi_Rohingya
            | Script::Hatran
            | Script::Hebrew
            | Script::Imperial_Aramaic
            | Script::Inscriptional_Pahlavi
            | Script::Inscriptional_Parthian
            | Script::Kharoshthi
            | Script::Lydian
            | Script::Manichaean
            | Script::Mandaic
            | Script::Meroitic_Cursive
            | Script::Meroitic_Hieroglyphs
            | Script::Nabataean
            | Script::Nko
            | Script::Old_Hungarian
            | Script::Old_North_Arabian
            | Script::Old_Sogdian
            | Script::Old_South_Arabian
            | Script::Old_Turkic
            | Script::Old_Uyghur
            | Script::Palmyrene
            | Script::Phoenician
            | Script::Psalter_Pahlavi
            | Script::Samaritan
            | Script::Sogdian
            | Script::Syriac
            | Script::Thaana
            | Script::Ugaritic
            | Script::Yezidi
    )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn json(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    fn detect(bytes: &[u8]) -> Value {
        json(&text_detect(bytes, "{}"))
    }

    fn transcode(bytes: &[u8], options: &str) -> Value {
        json(&text_transcode(bytes, options))
    }

    fn audit(bytes: &[u8]) -> Value {
        json(&unicode_audit(bytes, "{}"))
    }

    fn stats(bytes: &[u8]) -> Value {
        json(&text_stats(bytes, "{}"))
    }

    fn findings_of<'a>(doc: &'a Value, kind: &str) -> Vec<&'a Value> {
        doc["findings"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|f| f["kind"] == kind)
            .collect()
    }

    // The classic CVE-2021-42574 Trojan Source shape: inside a comment, an
    // RLO reorders the display so "return true" visually appears in the
    // comment while actually executing.
    const TROJAN_SOURCE: &str =
        "if (admin) {\n    /* begin \u{202E} } \u{2066} return true ; \u{2069} end */\n    return false;\n}\n";

    #[test]
    fn detects_trojan_source_bidi_controls() {
        let doc = audit(TROJAN_SOURCE.as_bytes());
        assert_eq!(doc["schema_version"], 1);
        assert_eq!(doc["risk"], "high");
        let bidi = findings_of(&doc, "bidi_control");
        assert_eq!(bidi.len(), 3);
        let names: Vec<&str> = bidi.iter().map(|f| f["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"RIGHT-TO-LEFT OVERRIDE"));
        assert!(names.contains(&"LEFT-TO-RIGHT ISOLATE"));
        assert!(names.contains(&"POP DIRECTIONAL ISOLATE"));
        // Positions point at the decoded text.
        let rlo = bidi
            .iter()
            .find(|f| f["name"] == "RIGHT-TO-LEFT OVERRIDE")
            .unwrap();
        assert_eq!(rlo["codepoint"], "U+202E");
        assert_eq!(rlo["line"], 2);
        assert!(rlo["offset"].as_u64().unwrap() > 10);
        assert!(rlo["col"].as_u64().unwrap() > 1);
    }

    #[test]
    fn clean_ascii_has_no_findings() {
        let doc = audit(b"fn main() {\n    return 0;\n}\n");
        assert_eq!(doc["risk"], "none");
        assert_eq!(doc["summary"]["total"], 0);
        assert_eq!(doc["findings"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn flags_cyrillic_a_in_latin_identifier() {
        // "vаlid" where the 'а' is Cyrillic U+0430.
        let source = "const v\u{0430}lid = true;\n";
        let doc = audit(source.as_bytes());
        let mixed = findings_of(&doc, "mixed_script_identifier");
        assert_eq!(mixed.len(), 1);
        let finding = mixed[0];
        assert_eq!(finding["identifier"], "v\u{0430}lid");
        assert_eq!(finding["codepoint"], "U+0430");
        let scripts = finding["scripts"].as_array().unwrap();
        let names: Vec<&str> = scripts.iter().map(|s| s.as_str().unwrap()).collect();
        assert!(names.contains(&"Cyrillic"));
        assert!(names.contains(&"Latin"));
        assert_eq!(doc["risk"], "high");
    }

    #[test]
    fn does_not_flag_single_script_identifiers() {
        let source = "const valid = true;\nconst \u{03C0} = 3.14;\n";
        let doc = audit(source.as_bytes());
        assert_eq!(findings_of(&doc, "mixed_script_identifier").len(), 0);
    }

    #[test]
    fn flags_zero_width_and_tag_characters() {
        let source = "a\u{200B}b\u{00AD}c\u{E0001}d\u{E0041}";
        let doc = audit(source.as_bytes());
        let invisible = findings_of(&doc, "invisible_char");
        let names: Vec<&str> = invisible
            .iter()
            .map(|f| f["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"ZERO WIDTH SPACE"));
        assert!(names.contains(&"SOFT HYPHEN"));
        assert_eq!(
            names.iter().filter(|&&n| n == "TAG CHARACTER").count(),
            2
        );
    }

    #[test]
    fn flags_unusual_whitespace_in_code() {
        let source = "if (x\u{00A0}==\u{2007}1)\u{3000}{\n}";
        let doc = audit(source.as_bytes());
        let ws = findings_of(&doc, "unusual_whitespace");
        let names: Vec<&str> = ws.iter().map(|f| f["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"NO-BREAK SPACE"));
        assert!(names.contains(&"FIGURE SPACE"));
        assert!(names.contains(&"IDEOGRAPHIC SPACE"));
    }

    #[test]
    fn flags_control_chars_but_not_tab_newline() {
        let source = "a\tb\nc\u{0007}d\u{0085}e\u{001B}";
        let doc = audit(source.as_bytes());
        let controls = findings_of(&doc, "control_char");
        let names: Vec<&str> = controls
            .iter()
            .map(|f| f["name"].as_str().unwrap())
            .collect();
        assert_eq!(controls.len(), 3);
        assert!(names.contains(&"BELL"));
        assert!(names.contains(&"NEXT LINE"));
        assert!(names.contains(&"ESCAPE"));
    }

    #[test]
    fn flags_bidi_reorder_spans_in_mixed_lines() {
        // Hebrew run inside a Latin line reorders display vs storage.
        let source = "let name = \"\u{05D0}\u{05D1}\u{05D2}\";\n";
        let doc = audit(source.as_bytes());
        let spans = findings_of(&doc, "bidi_reorder_span");
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0]["line"], 1);
        assert_eq!(spans[0]["length"], 6); // three 2-byte Hebrew letters
        let scripts = spans[0]["scripts"].as_array().unwrap();
        assert_eq!(scripts[0], "Hebrew");
    }

    #[test]
    fn all_hebrew_line_is_not_flagged() {
        let source = "\u{05D0}\u{05D1}\u{05D2}\n";
        let doc = audit(source.as_bytes());
        assert_eq!(findings_of(&doc, "bidi_reorder_span").len(), 0);
    }

    #[test]
    fn detect_utf8_bom_and_utf16_boms() {
        assert_eq!(detect(b"\xEF\xBB\xBFhello")["bom"], "utf-8");
        let utf16le = b"\xFF\xFEh\x00i\x00";
        assert_eq!(detect(utf16le)["bom"], "utf-16le");
        assert_eq!(detect(utf16le)["encoding"], "UTF-16LE");
        let utf16be = b"\xFE\xFF\x00h\x00i";
        assert_eq!(detect(utf16be)["bom"], "utf-16be");
        assert_eq!(detect(utf16be)["encoding"], "UTF-16BE");
    }

    #[test]
    fn detect_bomless_utf16_heuristic() {
        // "hello" in UTF-16LE without BOM.
        let utf16le: Vec<u8> = "hello world, this is a test"
            .encode_utf16()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        let doc = detect(&utf16le);
        assert_eq!(doc["utf16_le_likely"], true);
        assert_eq!(doc["utf16_be_likely"], false);
        assert!(doc["null_byte_ratio"].as_f64().unwrap() > 0.3);
    }

    #[test]
    fn detect_windows1252_via_chardetng() {
        // "café" + smart quotes in cp1252.
        let cp1252 = [
            0x63, 0x61, 0x66, 0xE9, 0x20, 0x93, 0x68, 0x69, 0x94, 0x20, 0x63, 0x6F, 0x64,
            0x65,
        ];
        let doc = detect(&cp1252);
        assert_eq!(doc["encoding"], "windows-1252");
        assert_eq!(doc["utf8_valid"], false);
        assert_eq!(doc["ascii_only"], false);
        assert_eq!(doc["had_errors"], false);
    }

    #[test]
    fn detect_utf8_confident() {
        let doc = detect("hello wörld — ünïcodé".as_bytes());
        assert_eq!(doc["encoding"], "UTF-8");
        assert_eq!(doc["utf8_valid"], true);
        assert_eq!(doc["confidence"], "high");
    }

    #[test]
    fn detect_invalid_tld_rejected_not_panicked() {
        let doc = json(&text_detect(b"abc", r#"{"tld":"EXAMPLE.COM"}"#));
        assert_eq!(doc["error"], "options_invalid");
    }

    #[test]
    fn transcode_cp1252_to_utf8() {
        // "café" in cp1252 (0xE9) with explicit from.
        let cp1252 = [0x63, 0x61, 0x66, 0xE9];
        let doc = transcode(&cp1252, r#"{"from":"windows-1252"}"#);
        assert_eq!(doc["from"], "windows-1252");
        assert_eq!(doc["to"], "utf-8");
        assert_eq!(doc["text"], "caf\u{00E9}");
        assert_eq!(doc["had_errors"], false);
        // Round trip: UTF-8 result re-detected as UTF-8.
        let round_trip = detect(doc["text"].as_str().unwrap().as_bytes());
        assert_eq!(round_trip["encoding"], "UTF-8");
    }

    #[test]
    fn transcode_auto_detects() {
        let cp1252 = [0x63, 0x61, 0x66, 0xE9, 0x20, 0x93, 0x78, 0x94];
        let doc = transcode(&cp1252, r#"{"from":"auto"}"#);
        assert_eq!(doc["from"], "windows-1252");
        assert!(doc["text"].as_str().unwrap().contains('é'));
    }

    #[test]
    fn transcode_normalization_nfc() {
        // 'e' + combining acute → NFC 'é'.
        let decomposed = "caf\u{0065}\u{0301}";
        let doc = transcode(decomposed.as_bytes(), r#"{"normalize":"nfc"}"#);
        assert_eq!(doc["text"], "caf\u{00E9}");
        assert_eq!(doc["normalize"], "nfc");
    }

    #[test]
    fn transcode_normalization_nfkc() {
        // 'ﬀ' ligature → 'ff'; fullwidth 'Ａ' → 'A'.
        let doc = transcode("\u{FB00}\u{FF21}".as_bytes(), r#"{"normalize":"nfkc"}"#);
        assert_eq!(doc["text"], "ffA");
    }

    #[test]
    fn transcode_malformed_utf8_lossy() {
        let bad = [b'a', 0xFF, 0xFE, b'b'];
        let doc = transcode(&bad, r#"{"from":"utf-8"}"#);
        assert_eq!(doc["had_errors"], true);
        assert!(doc["replacement_chars"].as_u64().unwrap() >= 1);
        assert!(doc["text"].as_str().unwrap().contains('\u{FFFD}'));
    }

    #[test]
    fn transcode_unknown_encoding_and_bad_target() {
        let doc = transcode(b"abc", r#"{"from":"not-an-encoding"}"#);
        assert_eq!(doc["error"], "unknown_encoding");
        let doc = transcode(b"abc", r#"{"to":"utf-16le"}"#);
        assert_eq!(doc["error"], "unsupported_target_encoding");
        let doc = transcode(b"abc", r#"{"normalize":"bogus"}"#);
        assert_eq!(doc["error"], "invalid_normalize");
    }

    #[test]
    fn audit_malformed_utf8_is_lossy_not_fatal() {
        let bad = [b'a', 0xFF, b'\n', 0x80, 0x80, b'b'];
        let doc = audit(&bad);
        assert_eq!(doc["decoded_had_errors"], true);
        assert!(doc["replacement_chars"].as_u64().unwrap() >= 1);
        assert_eq!(doc["error"], Value::Null);
    }

    #[test]
    fn findings_cap_truncates_deterministically() {
        // 8 ZWSP findings with maxFindings=3.
        let source = "\u{200B}".repeat(8);
        let doc = json(&unicode_audit(
            source.as_bytes(),
            r#"{"maxFindings":3}"#,
        ));
        assert_eq!(doc["findings"].as_array().unwrap().len(), 3);
        assert_eq!(doc["findings_dropped"], 5);
        assert_eq!(doc["truncated"], true);
    }

    #[test]
    fn options_oversize_and_malformed_rejected() {
        let big_opts = format!(r#"{{"pad":"{}"}}"#, "x".repeat(4096));
        assert_eq!(
            json(&unicode_audit(b"abc", &big_opts))["error"],
            "options_too_large"
        );
        assert_eq!(
            json(&text_detect(b"abc", "{not json"))["error"],
            "options_invalid"
        );
        assert_eq!(
            json(&text_stats(b"abc", &big_opts))["error"],
            "options_too_large"
        );
    }

    #[test]
    fn oversized_input_rejected() {
        let big = vec![0u8; MAX_INPUT_BYTES + 1];
        assert_eq!(json(&unicode_audit(&big, "{}"))["error"], "input_too_large");
        assert_eq!(json(&text_detect(&big, "{}"))["error"], "input_too_large");
        assert_eq!(json(&text_transcode(&big, "{}"))["error"], "input_too_large");
        assert_eq!(json(&text_stats(&big, "{}"))["error"], "input_too_large");
    }

    #[test]
    fn stats_counts_lines_scripts_and_controls() {
        let text = "hello world\nlet \u{03C0} = 3;\n\u{0410}\u{0411}\u{0412}\n";
        let doc = stats(text.as_bytes());
        assert_eq!(doc["lines"], 3);
        assert_eq!(doc["codepoints"], text.chars().count() as u64);
        assert_eq!(doc["encoding"], "UTF-8");
        let scripts = doc["scripts"].as_array().unwrap();
        let latin = scripts.iter().find(|s| s["script"] == "Latin").unwrap();
        assert!(latin["chars"].as_u64().unwrap() >= 12);
        assert!(scripts.iter().any(|s| s["script"] == "Cyrillic"));
        assert!(scripts.iter().any(|s| s["script"] == "Greek"));
        assert_eq!(doc["longest_line"]["line"], 1);
        assert_eq!(doc["longest_line"]["codepoints"], 11);
    }

    #[test]
    fn stats_control_and_nonprintable_counts() {
        let doc = stats("a\u{0007}b\u{200B}c\u{202E}d".as_bytes());
        assert_eq!(doc["control_chars"], 1);
        // control + ZWSP + RLO are non-printable.
        assert_eq!(doc["nonprintable_chars"], 3);
    }

    #[test]
    fn audit_reports_positions_in_decoded_text() {
        let source = "ab\ncd\u{200B}ef";
        let doc = audit(source.as_bytes());
        let invisible = findings_of(&doc, "invisible_char");
        assert_eq!(invisible.len(), 1);
        assert_eq!(invisible[0]["offset"], 5);
        assert_eq!(invisible[0]["line"], 2);
        assert_eq!(invisible[0]["col"], 3);
        assert!(invisible[0]["context"].as_str().unwrap().contains("cd"));
    }

    #[test]
    fn operations_are_deterministic() {
        let input = TROJAN_SOURCE.as_bytes();
        assert_eq!(unicode_audit(input, "{}"), unicode_audit(input, "{}"));
        assert_eq!(text_detect(input, "{}"), text_detect(input, "{}"));
        let cp1252 = [0x63, 0x61, 0x66, 0xE9];
        assert_eq!(
            text_transcode(&cp1252, r#"{"from":"windows-1252"}"#),
            text_transcode(&cp1252, r#"{"from":"windows-1252"}"#)
        );
        assert_eq!(text_stats(input, "{}"), text_stats(input, "{}"));
    }

    #[test]
    fn empty_input_is_safe() {
        let doc = detect(b"");
        assert_eq!(doc["encoding"], "UTF-8");
        assert_eq!(doc["null_byte_ratio"], 0.0);
        let doc = audit(b"");
        assert_eq!(doc["risk"], "none");
        let doc = stats(b"");
        assert_eq!(doc["lines"], 0);
        let doc = transcode(b"", "{}");
        assert_eq!(doc["text"], "");
    }

    #[test]
    fn transcode_utf16le_with_bom() {
        let mut data = vec![0xFF, 0xFE];
        for unit in "hi".encode_utf16() {
            data.extend_from_slice(&unit.to_le_bytes());
        }
        let doc = transcode(&data, r#"{"from":"utf-16"}"#);
        assert_eq!(doc["text"], "hi");
    }

    #[test]
    fn utf8_bom_flagged_as_invisible_mid_text() {
        let doc = audit("a\u{FEFF}b".as_bytes());
        let invisible = findings_of(&doc, "invisible_char");
        assert!(invisible
            .iter()
            .any(|f| f["name"] == "ZERO WIDTH NO-BREAK SPACE"));
    }
}
