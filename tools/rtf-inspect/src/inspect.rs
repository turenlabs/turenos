//! `rtf_inspect` — full structural report over the scanned document model:
//! group statistics, control-word histogram, font/style/color tables, info
//! metadata, generator string, picture and OLE-object summaries, file-table
//! entries, field instructions, and a body-text preview.

use serde::Deserialize;
use serde_json::json;

use crate::rtf::Doc;
use crate::{OpResult, MAX_RESULTS};

const MAX_TOP: usize = 256;
const DEFAULT_TOP: usize = 32;
const MAX_PREVIEW_CHARS: usize = 4096;
const DEFAULT_PREVIEW_CHARS: usize = 512;
const DEFAULT_MAX_RESULTS: usize = 1024;

#[derive(Default, Deserialize)]
pub(crate) struct InspectOptions {
    #[serde(default)]
    top: Option<usize>,
    #[serde(default)]
    max_results: Option<usize>,
    #[serde(default)]
    preview_chars: Option<usize>,
}

pub(crate) fn run(doc: &Doc, options: &InspectOptions, _bytes: &[u8]) -> OpResult {
    let top = options.top.unwrap_or(DEFAULT_TOP).clamp(1, MAX_TOP);
    let max_results = options
        .max_results
        .unwrap_or(DEFAULT_MAX_RESULTS)
        .clamp(1, MAX_RESULTS);
    let preview_chars = options
        .preview_chars
        .unwrap_or(DEFAULT_PREVIEW_CHARS)
        .clamp(1, MAX_PREVIEW_CHARS);

    let histogram: Vec<serde_json::Value> = doc
        .histogram
        .iter()
        .take(top)
        .map(|(name, count)| json!({ "name": name, "count": count }))
        .collect();

    let fonts: Vec<serde_json::Value> = doc
        .fonts
        .iter()
        .take(max_results)
        .map(|f| {
            json!({
                "index": f.index,
                "name": f.name,
                "family": f.family,
                "charset": f.charset,
                "pitch": f.pitch,
            })
        })
        .collect();

    let styles: Vec<serde_json::Value> = doc
        .styles
        .iter()
        .take(max_results)
        .map(|s| json!({ "index": s.index, "kind": s.kind, "name": s.name }))
        .collect();

    let colors: Vec<serde_json::Value> = doc
        .colors
        .iter()
        .take(max_results)
        .map(|c| json!({ "index": c.index, "r": c.r, "g": c.g, "b": c.b }))
        .collect();

    let picts: Vec<serde_json::Value> = doc
        .picts
        .iter()
        .take(max_results)
        .map(|p| {
            json!({
                "offset": p.offset,
                "end": p.end,
                "type": p.pic_type,
                "type_param": p.type_param,
                "w": p.w,
                "h": p.h,
                "wgoal": p.wgoal,
                "hgoal": p.hgoal,
                "hex_bytes": p.hex_nibbles / 2,
                "bin_bytes": p.bin_bytes,
                "data_bytes": p.hex_nibbles / 2 + p.bin_bytes,
            })
        })
        .collect();

    let objects: Vec<serde_json::Value> = doc
        .objects
        .iter()
        .take(max_results.min(256))
        .map(|o| {
            let od = o.objdata.as_ref();
            json!({
                "offset": o.offset,
                "end": o.end,
                "type": o.objtype,
                "objclass": o.objclass,
                "w": o.w,
                "h": o.h,
                "has_objdata": od.is_some(),
                "objdata_bytes": od.map(|d| d.decoded_bytes),
                "ole_magic": od.map(|d| d.ole_magic),
                "has_result": o.result.is_some(),
            })
        })
        .collect();

    let files: Vec<serde_json::Value> = doc
        .files
        .iter()
        .take(max_results)
        .map(|f| json!({ "offset": f.offset, "fid": f.fid, "name": f.name, "path": f.path }))
        .collect();

    let fields: Vec<serde_json::Value> = doc
        .fields
        .iter()
        .take(max_results)
        .map(|f| {
            json!({
                "offset": f.offset,
                "keyword": f.keyword,
                "instruction": f.instruction,
                "url": f.url,
            })
        })
        .collect();

    let info: serde_json::Map<String, serde_json::Value> = doc
        .info
        .iter()
        .map(|(k, v)| (k.clone(), json!(v)))
        .collect();

    let text_preview: String = doc.text.chars().take(preview_chars).collect();

    Ok(json!({
        "schema_version": 1,
        "input_bytes": doc.input_len,
        "input_sha256": doc.sha256,
        "valid_rtf": doc.valid_rtf,
        "rtf_version": doc.rtf_version,
        "charset": doc.charset,
        "codepage": doc.codepage,
        "ansicpg": doc.ansicpg,
        "codepages": doc.codepages,
        "deff": doc.deff,
        "groups": {
            "total": doc.groups_total,
            "max_depth": doc.max_depth,
            "unclosed": doc.unclosed,
            "stray_closes": doc.stray_closes,
            "trailing_bytes": doc.trailing_bytes,
            "skipped_destinations": doc.skipped_groups,
            "ignorable": doc.ignorable_groups,
            "deeper_than_8": doc.deep_groups,
            "over_depth_cap": doc.over_cap_groups,
        },
        "control_words": {
            "total": doc.controls_total,
            "distinct": doc.histogram.len(),
            "bytes": doc.control_bytes,
            "top": histogram,
        },
        "font_table": { "count": doc.fonts_total, "fonts": fonts },
        "style_sheet": { "count": doc.styles_total, "styles": styles },
        "color_table": { "count": doc.colors_total, "colors": colors },
        "info": info,
        "info_extra_fields": doc.info_extra,
        "generator": doc.generator,
        "template": doc.template,
        "password_protection": doc.password.is_some(),
        "panose": doc.panose,
        "data_stores": doc.datastore_count,
        "datastore_bytes": doc.datastore_bytes,
        "pictures": { "count": doc.picts_total, "items": picts },
        "objects": { "count": doc.objects_total, "items": objects },
        "file_table": { "count": doc.files_total, "files": files },
        "fields": { "count": doc.fields_total, "items": fields },
        "counts": {
            "hex_escapes": doc.hex_escapes,
            "unicode_chars": doc.u_chars,
            "unicode_anomalies": doc.u_anomalies,
            "bin_blobs": doc.bin_blobs,
            "bin_bytes": doc.bin_bytes,
            "paragraphs": doc.paragraphs,
            "text_bytes": doc.text_bytes,
            "text_chars": doc.text_total_chars,
        },
        "finding_count": doc.findings_total,
        "text_preview": text_preview,
        "warnings": doc.warnings,
        "truncated": doc.fonts.len() < doc.fonts_total
            || doc.styles.len() < doc.styles_total
            || doc.colors.len() < doc.colors_total
            || doc.picts.len() < doc.picts_total
            || doc.objects.len() < doc.objects_total
            || doc.files.len() < doc.files_total
            || doc.fields.len() < doc.fields_total,
    }))
}
