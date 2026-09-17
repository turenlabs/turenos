//! `pdf_inspect` — document summary plus a bounded suspicious-indicator scan.
//!
//! Every loaded object is walked with a depth- and node-bounded DFS that never
//! dereferences references (referenced objects are visited on their own when
//! the object map is iterated), so cyclic object graphs cannot loop the scan.

use lopdf::xref::XrefType;
use lopdf::{Document, Dictionary, Object, ObjectId};
use serde::Deserialize;
use sha2::Digest;
use std::collections::BTreeSet;

use crate::{
    clean, name_string, text_string, OpResult, MAX_KEY_LIST, MAX_RESULTS, MAX_SCAN_DEPTH,
    MAX_SCAN_NODES, MAX_STRING_CHARS, MAX_URLS, MAX_WARNINGS,
};

const MAX_URL_BYTES: usize = 512;

#[derive(Default, Deserialize)]
pub(crate) struct InspectOptions {
    #[serde(default)]
    max_findings: Option<usize>,
    #[serde(default)]
    max_urls: Option<usize>,
}

/// `(key, code, severity)` — dictionary keys that flag a document for review.
/// The scan reports key presence only; action payloads are never executed.
const SUSPICIOUS_KEYS: &[(&[u8], &str, &str)] = &[
    (b"JavaScript", "javascript", "high"),
    (b"JS", "javascript", "high"),
    (b"OpenAction", "open_action", "high"),
    (b"AA", "additional_actions", "high"),
    (b"Launch", "launch_action", "high"),
    (b"URI", "uri_action", "medium"),
    (b"SubmitForm", "submit_form", "medium"),
    (b"RichMedia", "rich_media", "medium"),
    (b"EmbeddedFile", "embedded_file", "medium"),
    (b"EmbeddedFiles", "embedded_file", "medium"),
    (b"AcroForm", "acroform", "low"),
    (b"XFA", "xfa", "medium"),
    (b"Names", "names_dictionary", "info"),
    (b"Encrypt", "encrypted", "medium"),
];

/// Map a `/S` action-type name to the specific finding code it implies, plus
/// severity. Unlisted action types report as generic `action_type`.
fn action_code_severity(name: &[u8]) -> (&'static str, &'static str) {
    match name {
        b"JavaScript" => ("javascript", "high"),
        b"Launch" => ("launch_action", "high"),
        b"URI" => ("uri_action", "medium"),
        b"SubmitForm" => ("submit_form", "medium"),
        b"ImportData" => ("import_data", "medium"),
        b"Rendition" => ("rich_media", "medium"),
        b"GoToR" | b"GoToE" => ("external_reference", "medium"),
        _ => ("action_type", "low"),
    }
}

pub(crate) fn run(document: &Document, options: &InspectOptions, bytes: &[u8]) -> OpResult {
    let max_findings = options
        .max_findings
        .unwrap_or(MAX_RESULTS)
        .clamp(1, MAX_RESULTS);
    let max_urls = options.max_urls.unwrap_or(MAX_URLS).clamp(1, MAX_URLS);

    let mut scan = Scan {
        max_findings,
        max_urls,
        findings: Vec::new(),
        findings_total: 0,
        seen: BTreeSet::new(),
        urls: BTreeSet::new(),
        truncated: false,
        warnings: Vec::new(),
    };

    let mut object_stream_count = 0usize;
    let mut linearized = false;
    for (id, object) in document.objects.iter() {
        if let Object::Stream(stream) = object {
            if stream.dict.has_type(b"ObjStm") {
                object_stream_count += 1;
            }
            if stream.dict.has(b"Linearized") {
                linearized = true;
            }
        }
        if let Object::Dictionary(dict) = object {
            if dict.has(b"Linearized") {
                linearized = true;
            }
        }
        scan.scan_object(*id, object);
    }

    let compressed_object_count = document
        .reference_table
        .entries
        .values()
        .filter(|entry| entry.is_compressed())
        .count();

    // Structural signals that do not belong to any single object.
    let encrypted = document.is_encrypted()
        || document.was_encrypted()
        || document.trailer.has(b"Encrypt");
    if encrypted {
        scan.finding(
            (0, 0),
            "encrypted",
            "medium",
            if document.was_encrypted() {
                "document declares /Encrypt; lopdf opened it with the empty password"
            } else {
                "document declares /Encrypt; contents unavailable without a password"
            }
            .to_string(),
        );
    }
    if document.was_encrypted() {
        scan.warnings.push(
            "document was encrypted; strings and streams shown were decrypted on load"
                .to_string(),
        );
    }
    if encrypted && !document.was_encrypted() {
        scan.warnings.push(
            "document is encrypted and requires a password; object content is unavailable"
                .to_string(),
        );
    }
    if object_stream_count > 0 {
        scan.finding(
            (0, 0),
            "object_streams",
            "info",
            format!(
                "{object_stream_count} object stream(s) hold {compressed_object_count} compressed objects"
            ),
        );
    }
    if let Ok(names) = document
        .catalog()
        .and_then(|catalog| catalog.get_deref(b"Names", document))
        .and_then(|names| names.as_dict())
    {
        let mut entries = Vec::new();
        for key in names.iter().map(|(key, _)| key).take(MAX_KEY_LIST) {
            entries.push(name_string(key));
        }
        scan.finding(
            (0, 0),
            "names_dictionary",
            "info",
            format!("catalog /Names tree holds: {}", entries.join(", ")),
        );
    }

    let info = info_object(document);
    let catalog_keys = document
        .catalog()
        .map(|catalog| {
            catalog
                .iter()
                .take(MAX_KEY_LIST)
                .map(|(key, _)| name_string(key))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let trailer_keys = document
        .trailer
        .iter()
        .take(MAX_KEY_LIST)
        .map(|(key, _)| name_string(key))
        .collect::<Vec<_>>();
    let page_count = document.get_pages().len();

    if document.trailer.get(b"Info").is_err() {
        scan.warnings.push("no trailer /Info dictionary".to_string());
    }

    let mut findings_json = Vec::new();
    for finding in scan.findings.iter().take(max_findings) {
        findings_json.push(serde_json::json!({
            "code": finding.code,
            "severity": finding.severity,
            "detail": finding.detail,
            "object": [finding.object.0, finding.object.1],
        }));
    }
    let findings_total = scan.findings_total;

    let urls: Vec<&String> = scan.urls.iter().take(max_urls).collect();
    let urls_truncated = scan.urls.len() > max_urls;

    let sha = sha2::Sha256::digest(bytes);
    Ok(serde_json::json!({
        "schema_version": 1,
        "version": document.version,
        "input_sha256": crate::hex(&sha),
        "page_count": page_count,
        "object_count": document.objects.len(),
        "compressed_object_count": compressed_object_count,
        "object_stream_count": object_stream_count,
        "encrypted": encrypted,
        "decrypted_on_load": document.was_encrypted(),
        "linearized": linearized,
        "xref_type": match document.reference_table.cross_reference_type {
            XrefType::CrossReferenceStream => "stream",
            XrefType::CrossReferenceTable => "table",
        },
        "trailer_keys": trailer_keys,
        "catalog_keys": catalog_keys,
        "info": info,
        "urls": urls,
        "urls_truncated": urls_truncated,
        "findings": findings_json,
        "findings_total": findings_total,
        "warnings": scan.warnings,
        "truncated": scan.truncated || urls_truncated || findings_total > max_findings,
    }))
}

struct Finding {
    code: &'static str,
    severity: &'static str,
    detail: String,
    object: ObjectId,
}

struct Scan {
    max_findings: usize,
    max_urls: usize,
    findings: Vec<Finding>,
    findings_total: usize,
    seen: BTreeSet<(u32, u16, String)>,
    urls: BTreeSet<String>,
    truncated: bool,
    warnings: Vec<String>,
}

impl Scan {
    fn finding(&mut self, id: ObjectId, code: &'static str, severity: &'static str, detail: String) {
        self.findings_total += 1;
        if self.findings.len() >= self.max_findings {
            self.truncated = true;
            return;
        }
        self.findings.push(Finding {
            code,
            severity,
            detail: clean(&detail, MAX_STRING_CHARS),
            object: id,
        });
    }

    /// Deduplicate a finding on (object, code, path) so the same key repeated
    /// at the same path is reported once.
    fn keyed_finding(
        &mut self,
        id: ObjectId,
        code: &'static str,
        severity: &'static str,
        path: &str,
        key: &[u8],
    ) {
        let marker = (id.0, id.1, format!("{code}:{path}"));
        if !self.seen.insert(marker) {
            return;
        }
        self.finding(
            id,
            code,
            severity,
            format!("suspicious key /{} at {path}", name_string(key)),
        );
    }

    fn scan_object(&mut self, id: ObjectId, object: &Object) {
        let mut budget = MAX_SCAN_NODES;
        let mut path = String::new();
        self.walk(id, object, &mut path, 0, &mut budget);
    }

    fn walk(
        &mut self,
        id: ObjectId,
        object: &Object,
        path: &mut String,
        depth: usize,
        budget: &mut usize,
    ) {
        if depth > MAX_SCAN_DEPTH || *budget == 0 {
            if self.warnings.len() < MAX_WARNINGS {
                self.warnings.push(format!(
                    "scan budget reached inside object {} {}",
                    id.0, id.1
                ));
            }
            self.truncated = true;
            return;
        }
        *budget -= 1;
        match object {
            Object::Dictionary(dict) => self.walk_dict(id, dict, path, depth, budget),
            Object::Stream(stream) => self.walk_dict(id, &stream.dict, path, depth, budget),
            Object::Array(items) => {
                for item in items.iter() {
                    if *budget == 0 {
                        self.truncated = true;
                        return;
                    }
                    self.walk(id, item, path, depth + 1, budget);
                }
            }
            Object::String(raw, _) => self.scan_string(id, raw, path),
            _ => {}
        }
    }

    fn walk_dict(
        &mut self,
        id: ObjectId,
        dict: &Dictionary,
        path: &mut String,
        depth: usize,
        budget: &mut usize,
    ) {
        let base_len = path.len();
        for (key, value) in dict.iter() {
            if *budget == 0 {
                self.truncated = true;
                return;
            }
            *budget -= 1;
            if let Some((_, code, severity)) = SUSPICIOUS_KEYS
                .iter()
                .find(|(name, _, _)| *name == key.as_slice())
                .copied()
            {
                self.keyed_finding(id, code, severity, path, key);
            }
            if key.as_slice() == b"S" {
                if let Ok(name) = value.as_name() {
                    let (code, severity) = action_code_severity(name);
                    self.finding(
                        id,
                        code,
                        severity,
                        format!("action type /{} at {path}/S", name_string(name)),
                    );
                }
            }
            // Suspicious names also appear as /Subtype (and occasionally /Type)
            // values — /Subtype /RichMedia, /Subtype /Link handled via /A.
            if key.as_slice() == b"Subtype" {
                if let Ok(name) = value.as_name() {
                    if let Some((_, code, severity)) = SUSPICIOUS_KEYS
                        .iter()
                        .find(|(known, _, _)| *known == name)
                        .copied()
                    {
                        self.finding(
                            id,
                            code,
                            severity,
                            format!("suspicious /Subtype /{} at {path}", name_string(name)),
                        );
                    }
                }
            }
            path.truncate(base_len);
            path.push('/');
            path.push_str(&clean(&String::from_utf8_lossy(key), 128));
            self.walk(id, value, path, depth + 1, budget);
            path.truncate(base_len);
        }
    }

    /// Scan string bytes for external URL indicators. Findings are never
    /// dereferenced — URLs are reported as evidence only.
    fn scan_string(&mut self, id: ObjectId, raw: &[u8], path: &str) {
        let head: Vec<u8> = raw
            .iter()
            .take(64)
            .map(|byte| byte.to_ascii_lowercase())
            .collect();
        if head.starts_with(b"javascript:") || head.starts_with(b"data:") {
            let scheme = if head.starts_with(b"javascript:") {
                "javascript:"
            } else {
                "data:"
            };
            self.finding(
                id,
                "script_uri",
                "high",
                format!("{scheme} URI at {path}: {}", preview(&head)),
            );
        }
        for index in 0..raw.len() {
            // look for "://" and walk back over scheme characters
            if raw[index..].starts_with(b"://") {
                let scheme_start = scheme_start(raw, index);
                let scheme = &raw[scheme_start..index];
                if valid_scheme(scheme) {
                    let end = url_end(raw, index + 3);
                    let url = String::from_utf8_lossy(&raw[scheme_start..end]).to_string();
                    if self.urls.len() < self.max_urls || self.urls.contains(&url) {
                        self.urls.insert(url.clone());
                    } else {
                        self.truncated = true;
                        continue;
                    }
                    let marker = (id.0, id.1, format!("url:{url}"));
                    if self.seen.insert(marker) {
                        self.finding(
                            id,
                            "external_url",
                            "medium",
                            format!("external URL at {path}: {}", clean(&url, MAX_URL_BYTES)),
                        );
                    }
                }
            }
        }
    }
}

/// Byte index where a URI scheme starts, scanning back over
/// `[A-Za-z0-9+.-]` from `colon`.
fn scheme_start(raw: &[u8], colon: usize) -> usize {
    let mut start = colon;
    while start > 0 {
        let byte = raw[start - 1];
        if byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.') {
            start -= 1;
        } else {
            break;
        }
    }
    start
}

/// A scheme is 1..=32 chars, starting with an ASCII letter.
fn valid_scheme(scheme: &[u8]) -> bool {
    !scheme.is_empty()
        && scheme.len() <= 32
        && scheme[0].is_ascii_alphabetic()
        && scheme
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'))
}

/// End index of a URL body after `://`: printable non-delimiter bytes.
fn url_end(raw: &[u8], from: usize) -> usize {
    let mut end = from;
    while end < raw.len() {
        let byte = raw[end];
        if byte <= 0x20
            || byte >= 0x7f
            || matches!(byte, b'(' | b')' | b'<' | b'>' | b'"' | b'\'')
        {
            break;
        }
        if end - from >= MAX_URL_BYTES {
            break;
        }
        end += 1;
    }
    end
}

fn preview(bytes: &[u8]) -> String {
    clean(&String::from_utf8_lossy(bytes), 160)
}

/// Pull capped `/Info` metadata. Returns null when absent.
fn info_object(document: &Document) -> serde_json::Value {
    let info = document
        .trailer
        .get(b"Info")
        .and_then(|object| object.as_reference())
        .and_then(|id| document.get_dictionary(id));
    let info = match info {
        Ok(info) => info,
        Err(_) => return serde_json::Value::Null,
    };
    let field = |key: &[u8]| {
        info.get(key)
            .ok()
            .and_then(text_string)
            .map(serde_json::Value::String)
            .unwrap_or(serde_json::Value::Null)
    };
    let standard: &[&[u8]] = &[
        b"Title",
        b"Author",
        b"Subject",
        b"Keywords",
        b"Creator",
        b"Producer",
        b"CreationDate",
        b"ModDate",
        b"Trapped",
    ];
    let other_keys: Vec<String> = info
        .iter()
        .filter(|(key, _)| !standard.contains(&key.as_slice()))
        .take(MAX_KEY_LIST)
        .map(|(key, _)| name_string(key))
        .collect();
    serde_json::json!({
        "title": field(b"Title"),
        "author": field(b"Author"),
        "subject": field(b"Subject"),
        "keywords": field(b"Keywords"),
        "creator": field(b"Creator"),
        "producer": field(b"Producer"),
        "creation_date": field(b"CreationDate"),
        "mod_date": field(b"ModDate"),
        "trapped": field(b"Trapped"),
        "other_keys": other_keys,
    })
}
