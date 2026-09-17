//! `image_text_chunks` — every textual metadata value across the container:
//! PNG tEXt/zTXt/iTXt, JPEG COM and XMP packets, GIF comment/plain-text
//! extensions, WebP XMP, TIFF ASCII tags. This is the prompt-injection and
//! hidden-payload hunting surface: non-UTF-8 payloads surface as hex so
//! binary carriers are still inspectable.

use serde::Deserialize;

use crate::model::{parse_image, Limits};
use crate::{OpResult, MAX_RESULTS, MAX_TEXT_BYTES};

#[derive(Default, Deserialize)]
pub(crate) struct TextOptions {
    #[serde(default)]
    max_entries: Option<usize>,
    #[serde(default)]
    max_text_bytes: Option<usize>,
}

pub(crate) fn run(bytes: &[u8], options: &TextOptions) -> OpResult {
    let limits = Limits {
        // Regions are not returned by this op, but region caps still bound
        // the walker's work; keep the default so `truncated` tracks texts.
        max_regions: MAX_RESULTS,
        max_texts: options.max_entries.unwrap_or(MAX_RESULTS).clamp(1, MAX_RESULTS),
        max_text_bytes: options
            .max_text_bytes
            .unwrap_or(MAX_TEXT_BYTES)
            .clamp(1, MAX_TEXT_BYTES),
        collect_text: true,
        ..Limits::default()
    };
    let report = parse_image(bytes, &limits)?;
    Ok(serde_json::json!({
        "schema_version": 1,
        "format": report.format,
        "entries": report.texts,
        "entries_total": report.texts_total,
        "anomalies": report.anomalies,
        "warnings": report.warnings,
        "truncated": report.truncated,
    }))
}
