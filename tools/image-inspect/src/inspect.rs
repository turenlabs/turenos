//! `image_inspect` — format detection, per-format structure table, decoded
//! text chunks, EXIF/XMP/ICC presence, trailing bytes, and anomaly flags.

use serde::Deserialize;
use sha2::Digest;

use crate::model::{parse_image, Limits, Report};
use crate::{hex, OpResult, MAX_RESULTS, MAX_TEXT_BYTES};

#[derive(Default, Deserialize)]
pub(crate) struct InspectOptions {
    #[serde(default)]
    max_entries: Option<usize>,
    #[serde(default)]
    max_text_bytes: Option<usize>,
    #[serde(default)]
    include_text: Option<bool>,
}

pub(crate) fn run(bytes: &[u8], options: &InspectOptions) -> OpResult {
    let limits = Limits {
        max_regions: options.max_entries.unwrap_or(MAX_RESULTS).clamp(1, MAX_RESULTS),
        max_texts: MAX_RESULTS,
        max_text_bytes: options
            .max_text_bytes
            .unwrap_or(MAX_TEXT_BYTES)
            .clamp(1, MAX_TEXT_BYTES),
        collect_text: options.include_text.unwrap_or(true),
        ..Limits::default()
    };
    let report = parse_image(bytes, &limits)?;
    Ok(report_json(&report, bytes))
}

/// Serialize a Report to the inspect JSON shape shared by the ops.
pub(crate) fn report_json(report: &Report, bytes: &[u8]) -> serde_json::Value {
    let digest = sha2::Sha256::digest(bytes);
    let mut object = serde_json::Map::new();
    object.insert("schema_version".into(), 1.into());
    object.insert("format".into(), report.format.into());
    object.insert("input_size".into(), (bytes.len() as u64).into());
    object.insert("input_sha256".into(), hex(&digest).into());
    if let Some(width) = report.width {
        object.insert("width".into(), width.into());
    }
    if let Some(height) = report.height {
        object.insert("height".into(), height.into());
    }
    if let Some(depth) = report.bit_depth {
        object.insert("bit_depth".into(), depth.into());
    }
    if let Some(color) = &report.color_type {
        object.insert("color_type".into(), color.clone().into());
    }
    for (key, value) in &report.extra {
        object.insert(key.clone(), value.clone());
    }
    object.insert(
        report.region_kind.to_string(),
        serde_json::to_value(&report.regions).unwrap_or(serde_json::Value::Null),
    );
    object.insert("entries_total".into(), (report.regions_total as u64).into());
    object.insert(
        "text_chunks".into(),
        serde_json::to_value(&report.texts).unwrap_or(serde_json::Value::Null),
    );
    object.insert("texts_total".into(), (report.texts_total as u64).into());
    object.insert("exif_present".into(), report.exif.is_some().into());
    if let Some(range) = report.exif {
        object.insert(
            "exif".into(),
            serde_json::json!({ "offset": range.offset, "length": range.length }),
        );
    }
    object.insert("icc_present".into(), report.icc.is_some().into());
    object.insert("xmp_present".into(), report.xmp_present.into());
    match &report.trailing {
        Some(trailing) => {
            object.insert(
                "trailing_bytes".into(),
                serde_json::json!({
                    "offset": trailing.offset,
                    "length": trailing.length,
                    "hex_preview": trailing.hex_preview,
                }),
            );
        }
        None => {
            object.insert("trailing_bytes".into(), serde_json::Value::Null);
        }
    }
    object.insert(
        "anomalies".into(),
        serde_json::to_value(&report.anomalies).unwrap_or(serde_json::Value::Null),
    );
    object.insert(
        "warnings".into(),
        serde_json::to_value(&report.warnings).unwrap_or(serde_json::Value::Null),
    );
    object.insert("truncated".into(), report.truncated.into());
    serde_json::Value::Object(object)
}
