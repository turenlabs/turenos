//! `rtf_audit` — security-focused finding list with byte offsets and
//! severity hints, plus the scan statistics that produced them.

use serde::Deserialize;
use serde_json::json;

use crate::rtf::Doc;
use crate::{OpResult, MAX_RESULTS};

#[derive(Default, Deserialize)]
pub(crate) struct AuditOptions {
    #[serde(default)]
    max_findings: Option<usize>,
    #[serde(default)]
    min_severity: Option<String>,
}

fn severity_rank(severity: &str) -> u8 {
    match severity {
        "info" => 0,
        "low" => 1,
        "medium" => 2,
        "high" => 3,
        _ => 0,
    }
}

pub(crate) fn run(doc: &Doc, options: &AuditOptions, _bytes: &[u8]) -> OpResult {
    let max_findings = options
        .max_findings
        .unwrap_or(MAX_RESULTS)
        .clamp(1, MAX_RESULTS);
    let min_rank = options
        .min_severity
        .as_deref()
        .map(severity_rank)
        .unwrap_or(0);

    let mut findings = Vec::new();
    let mut matched = 0usize;
    for f in &doc.findings {
        if severity_rank(f.severity) < min_rank {
            continue;
        }
        matched += 1;
        if findings.len() < max_findings {
            findings.push(json!({
                "kind": f.kind,
                "offset": f.offset,
                "severity": f.severity,
                "detail": f.detail,
            }));
        }
    }

    let kinds: serde_json::Map<String, serde_json::Value> = doc
        .finding_kinds
        .iter()
        .map(|(k, v)| (k.to_string(), json!(v)))
        .collect();

    let density_per_kb = if doc.input_len > 0 {
        doc.controls_total * 1024 / doc.input_len
    } else {
        0
    };

    Ok(json!({
        "schema_version": 1,
        "input_bytes": doc.input_len,
        "input_sha256": doc.sha256,
        "valid_rtf": doc.valid_rtf,
        "finding_count": doc.findings_total,
        "matched": matched,
        "returned": findings.len(),
        "findings": findings,
        "counts_by_kind": kinds,
        "stats": {
            "groups": doc.groups_total,
            "max_depth": doc.max_depth,
            "unclosed_groups": doc.unclosed,
            "stray_closes": doc.stray_closes,
            "trailing_bytes": doc.trailing_bytes,
            "control_words": doc.controls_total,
            "controls_per_kb": density_per_kb,
            "hex_escapes": doc.hex_escapes,
            "max_hex_run": doc.max_hex_run,
            "bin_blobs": doc.bin_blobs,
            "bin_bytes": doc.bin_bytes,
            "ignorable_groups": doc.ignorable_groups,
            "unicode_chars": doc.u_chars,
            "unicode_anomalies": doc.u_anomalies,
            "text_bytes": doc.text_bytes,
            "objects": doc.objects_total,
            "pictures": doc.picts_total,
            "embedded_files": doc.files_total,
            "fields": doc.fields_total,
            "data_stores": doc.datastore_count,
            "codepages": doc.codepages,
        },
        "warnings": doc.warnings,
        "truncated": matched > findings.len() || doc.findings.len() < doc.findings_total,
    }))
}
