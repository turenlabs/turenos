//! `rtf_text` — bounded plain-text extraction. Control words are stripped,
//! `\'hh` escapes are resolved through the document code page, `\uN`
//! characters are resolved with `\uc` fallback skipping, and non-body
//! destinations (font/color/style tables, info, pictures, objects,
//! `{\*\...}` ignorable groups, field instructions) are skipped.

use serde::Deserialize;
use serde_json::json;

use crate::rtf::{Doc, MAX_TEXT_CHARS};
use crate::OpResult;

const DEFAULT_MAX_CHARS: usize = 256 * 1024;

#[derive(Default, Deserialize)]
pub(crate) struct TextOptions {
    #[serde(default)]
    max_chars: Option<usize>,
}

pub(crate) fn run(doc: &Doc, options: &TextOptions, _bytes: &[u8]) -> OpResult {
    let max_chars = options
        .max_chars
        .unwrap_or(DEFAULT_MAX_CHARS)
        .clamp(1, MAX_TEXT_CHARS);

    let text: String = doc.text.chars().take(max_chars).collect();
    let returned_chars = text.chars().count();
    let truncated = doc.text_total_chars > max_chars as usize || doc.text_capped;

    Ok(json!({
        "schema_version": 1,
        "text": text,
        "chars": returned_chars,
        "total_chars": doc.text_total_chars,
        "paragraphs": doc.paragraphs,
        "skipped_destination_groups": doc.skipped_groups,
        "codepage": doc.codepage,
        "truncated": truncated,
        "warnings": doc.warnings,
    }))
}
