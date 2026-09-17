//! `pdf_text` — bounded text extraction over the page tree using lopdf's
//! per-page bounded content decoding. Per-page failures degrade to warnings
//! instead of failing the whole document.

use lopdf::Document;
use serde::Deserialize;

use crate::{
    clean, OpResult, DEFAULT_MAX_PAGES, DEFAULT_MAX_TEXT_CHARS, MAX_PAGES, MAX_PAGE_CONTENT_BYTES,
    MAX_STRING_CHARS, MAX_TEXT_CHARS, MAX_WARNINGS,
};

#[derive(Default, Deserialize)]
pub(crate) struct TextOptions {
    /// 1-based first page to extract (default 1).
    #[serde(default)]
    start_page: Option<u32>,
    #[serde(default)]
    max_pages: Option<usize>,
    #[serde(default)]
    max_chars: Option<usize>,
}

pub(crate) fn run(document: &Document, options: &TextOptions, _bytes: &[u8]) -> OpResult {
    let max_pages = options
        .max_pages
        .unwrap_or(DEFAULT_MAX_PAGES)
        .clamp(1, MAX_PAGES);
    let max_chars = options
        .max_chars
        .unwrap_or(DEFAULT_MAX_TEXT_CHARS)
        .clamp(1, MAX_TEXT_CHARS);
    let start_page = options.start_page.unwrap_or(1).max(1);

    let pages = document.get_pages();
    let page_count = pages.len();
    let mut text = String::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut pages_processed = 0usize;
    let mut truncated = false;

    for (page_number, _) in pages.range(start_page..) {
        if pages_processed >= max_pages || text.len() >= max_chars {
            truncated = true;
            break;
        }
        match document.extract_text_with_limit(&[*page_number], MAX_PAGE_CONTENT_BYTES) {
            Ok(fragment) => {
                let remaining = max_chars - text.len();
                if fragment.len() > remaining {
                    text.push_str(&clean(&fragment, remaining));
                    truncated = true;
                } else {
                    text.push_str(&fragment);
                }
            }
            Err(error) => {
                if warnings.len() < MAX_WARNINGS {
                    warnings.push(clean(
                        &format!("page {page_number}: {error}"),
                        MAX_STRING_CHARS,
                    ));
                }
            }
        }
        pages_processed += 1;
    }

    Ok(serde_json::json!({
        "schema_version": 1,
        "page_count": page_count,
        "start_page": start_page,
        "pages_processed": pages_processed,
        "text_chars": text.chars().count(),
        "text": text,
        "warnings": warnings,
        "truncated": truncated,
    }))
}
