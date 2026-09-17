//! `sqlite_carve`: heuristic scan of unallocated gaps, freeblock bodies, and
//! freelist pages for record-shaped data. Every candidate is labelled
//! heuristic — a well-formed record header in a free region is *suggestive*,
//! never proof, of a deleted or stale row.

use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::db::{free_regions, BtreePage, Db, FreeRegion};
use crate::record::{body_size, decode_record_bounded, probe_record_header, serial_size};
use crate::{Report, MAX_CARVE_CANDIDATES, MAX_CARVE_COLUMNS, DEFAULT_CARVE_CANDIDATES};

#[derive(Deserialize)]
pub(crate) struct CarveOptions {
    #[serde(
        default,
        alias = "max_candidates",
        alias = "maxCandidates",
        alias = "max_items",
        alias = "maxItems"
    )]
    max_candidates: Option<usize>,
    /// Minimum serial-type count a candidate must have (default 2).
    #[serde(default, alias = "min_columns", alias = "minColumns")]
    min_columns: Option<usize>,
    /// Include decoded value previews (default true).
    #[serde(default, alias = "include_values", alias = "includeValues")]
    include_values: Option<bool>,
}

/// Serial-type family for confidence scoring.
fn serial_class(serial: u64) -> u8 {
    match serial {
        0 => 0,        // null
        1..=6 | 8 | 9 => 1, // integer
        7 => 2,        // real
        n if n >= 13 && n % 2 == 1 => 3, // text
        _ => 4,        // blob
    }
}

/// Trim decoded values for a carve preview: at most 16 values, text bodies
/// capped at 64 chars, blob previews already bounded by the decoder.
fn preview_values(values: &[Value]) -> Vec<Value> {
    values
        .iter()
        .take(16)
        .map(|value| {
            if value.get("type") == Some(&json!("text")) {
                if let Some(text) = value.get("value").and_then(Value::as_str) {
                    if text.chars().count() > 64 {
                        let short: String = text.chars().take(64).collect();
                        return json!({
                            "type": "text",
                            "value": short,
                            "length": value.get("length"),
                            "truncated": true,
                        });
                    }
                }
            }
            value.clone()
        })
        .collect()
}

pub(crate) fn carve(
    bytes: &[u8],
    options: &CarveOptions,
    report: &mut Report,
) -> Result<Value, &'static str> {
    let db = Db::parse(bytes)?;
    if !db.header.magic_ok {
        report.warn("SQLite magic mismatch — parsing best-effort");
    }
    let max_candidates = options
        .max_candidates
        .unwrap_or(DEFAULT_CARVE_CANDIDATES)
        .clamp(1, MAX_CARVE_CANDIDATES);
    let min_columns = options.min_columns.unwrap_or(2).clamp(1, 64);
    let include_values = options.include_values.unwrap_or(true);
    let page_size = db.page_size();
    let usable_len = db.usable_size();

    // Freelist pages: leaf pages are fully stale; trunk pages are stale past
    // their [next][count][leaf pointers] header.
    let (trunks, _) = db.freelist_trunks(report);
    let mut trunk_used: HashMap<u32, usize> = HashMap::new();
    for trunk in &trunks {
        trunk_used.insert(
            trunk.page,
            (8 + trunk.declared_leaves.saturating_mul(4)).min(usable_len),
        );
    }
    let freelist_leaves: HashSet<u32> = trunks
        .iter()
        .flat_map(|t| t.leaves.iter().copied())
        .collect();

    let mut candidates: Vec<Value> = Vec::new();
    let mut regions_scanned = 0usize;
    let mut bytes_scanned: u64 = 0;
    let mut probes: u64 = 0;
    let mut budget_exhausted = false;
    let pages = db.pages_in_file();
    'pages: for number in 1..=pages {
        let Some(page) = db.page(number) else {
            continue;
        };
        let usable = page.usable();
        let regions: Vec<FreeRegion> = if trunk_used.contains_key(&number) {
            let start = trunk_used[&number];
            if usable.len() > start {
                vec![FreeRegion {
                    offset: start,
                    len: usable.len() - start,
                    kind: "freelist-trunk",
                }]
            } else {
                Vec::new()
            }
        } else if freelist_leaves.contains(&number) {
            vec![FreeRegion {
                offset: 0,
                len: usable.len(),
                kind: "freelist-leaf",
            }]
        } else if let Some(btree) = BtreePage::parse(&page) {
            free_regions(&page, &btree, report)
        } else {
            Vec::new()
        };
        for region in regions {
            regions_scanned += 1;
            bytes_scanned += region.len as u64;
            let region_end = (region.offset + region.len).min(usable.len());
            let mut at = region.offset;
            while at < region_end {
                if candidates.len() >= max_candidates {
                    report.truncated = true;
                    report.warn(format!("carve candidate cap {max_candidates} reached"));
                    break 'pages;
                }
                probes += 1;
                if probes > crate::MAX_CARVE_PROBES {
                    report.warn("carve scan budget exhausted — partial coverage");
                    budget_exhausted = true;
                    break 'pages;
                }
                let slice = &usable[at..];
                let Some((header_len, serials)) = probe_record_header(slice) else {
                    at += 1;
                    continue;
                };
                let columns = serials.len();
                let body = body_size(&serials);
                let record_len = header_len as u64 + body;
                let has_data = serials
                    .iter()
                    .any(|s| serial_size(*s).unwrap_or(0) > 0);
                let record_end = at as u64 + record_len;
                let fits_page = record_end <= usable.len() as u64;
                if columns < min_columns || !has_data || !fits_page {
                    at += 1;
                    continue;
                }
                let end = at + record_len as usize;
                let beyond_region = end > region_end;
                let record_bytes = &usable[at..end];
                let decoded = decode_record_bounded(
                    &db,
                    record_bytes,
                    16,
                    MAX_CARVE_COLUMNS,
                    report,
                );
                let (values, lossy) = match &decoded {
                    Ok(v) => {
                        let lossy = v
                            .iter()
                            .any(|x| x.get("lossless") == Some(&json!(false)));
                        (preview_values(v), lossy)
                    }
                    Err(_) => (Vec::new(), true),
                };
                // Confidence: shape, variety, and containment.
                let mut score = 0.30f64;
                score += (columns.min(5) as f64) * 0.08;
                let classes: HashSet<u8> =
                    serials.iter().take(64).map(|s| serial_class(*s)).collect();
                if classes.len() >= 2 {
                    score += 0.10;
                }
                if serials.iter().any(|s| serial_class(*s) == 3) {
                    score += 0.10;
                }
                if header_len <= 16 {
                    score += 0.05;
                }
                if beyond_region {
                    score -= 0.20;
                }
                if decoded.is_err() || lossy {
                    score -= 0.10;
                }
                let confidence = (score.clamp(0.05, 0.98) * 100.0).round() / 100.0;
                let file_offset = (number as usize - 1) * page_size + at;
                candidates.push(json!({
                    "heuristic": true,
                    "page": number,
                    "pageOffset": at,
                    "fileOffset": file_offset,
                    "region": region.kind,
                    "headerLength": header_len,
                    "columns": columns,
                    "recordBytes": record_len,
                    "extendsBeyondRegion": beyond_region,
                    "confidence": confidence,
                    "serialTypes": serials.iter().take(32).collect::<Vec<_>>(),
                    "values": if include_values { json!(values) } else { Value::Null },
                    "valuesDecoded": decoded.is_ok(),
                }));
                // Skip past the accepted record to avoid overlapping hits.
                at = end.max(at + 1);
            }
        }
    }

    Ok(json!({
        "schema_version": 1,
        "kind": "sqlite3-carve",
        "byteLength": bytes.len(),
        "magicOk": db.header.magic_ok,
        "heuristic": true,
        "note": "carved candidates are heuristic record-shaped bytes in free space, not verified live rows",
        "scanned": {
            "pages": pages,
            "regions": regions_scanned,
            "bytes": bytes_scanned,
        },
        "minColumns": min_columns,
        "candidateCount": candidates.len(),
        "candidates": candidates,
        "scanBudgetExhausted": budget_exhausted,
        "truncated": report.truncated || budget_exhausted,
        "warnings": report.warnings,
    }))
}
