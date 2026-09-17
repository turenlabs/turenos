//! `entropy_map`: sliding-window Shannon entropy profile with byte-class
//! summaries. Regions are emitted in offset order; when the region count
//! would exceed the shared result cap the profile is truncated and flagged.

use serde::{Deserialize, Serialize};

use crate::{error_json, histogram, is_text_byte, round2, round4, shannon, to_json, MAX_RESULTS};

const DEFAULT_WINDOW: usize = 4096;
const MIN_WINDOW: usize = 16;
const MAX_WINDOW: usize = 4 * 1024 * 1024;
const MAX_STRIDE: usize = 4 * 1024 * 1024;
const HIGH_ENTROPY: f64 = 7.2;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct EntropyOptions {
    #[serde(alias = "window_size")]
    window_size: Option<usize>,
    stride: Option<usize>,
}

#[derive(Serialize)]
struct ClassSummary {
    entropy: f64,
    ascii: f64,
    null: f64,
    high: f64,
    classification: &'static str,
}

#[derive(Serialize)]
struct Region {
    offset: usize,
    size: usize,
    #[serde(flatten)]
    summary: ClassSummary,
}

#[derive(Serialize, Clone, Copy)]
struct RegionRef {
    offset: usize,
    entropy: f64,
}

#[derive(Serialize)]
struct Report {
    schema_version: u32,
    input_bytes: usize,
    window_size: usize,
    stride: usize,
    overall: ClassSummary,
    highest_entropy_region: Option<RegionRef>,
    lowest_entropy_region: Option<RegionRef>,
    max_consecutive_high_entropy: usize,
    assessment: String,
    regions: Vec<Region>,
    warnings: Vec<String>,
    truncated: bool,
}

pub fn run(bytes: &[u8], options_json: &str) -> String {
    let options: EntropyOptions = match serde_json::from_str(options_json) {
        Ok(options) => options,
        Err(error) => return error_json("options_invalid", &error.to_string()),
    };
    let window = options
        .window_size
        .unwrap_or(DEFAULT_WINDOW)
        .clamp(MIN_WINDOW, MAX_WINDOW);
    let stride = options
        .stride
        .unwrap_or(DEFAULT_WINDOW)
        .clamp(1, MAX_STRIDE);

    let overall = summarize(bytes);
    let mut report = Report {
        schema_version: 1,
        input_bytes: bytes.len(),
    window_size: window,
        stride,
        overall,
        highest_entropy_region: None,
        lowest_entropy_region: None,
        max_consecutive_high_entropy: 0,
        assessment: String::new(),
        regions: Vec::new(),
        warnings: Vec::new(),
        truncated: false,
    };

    let mut consecutive_high = 0usize;
    let mut offset = 0usize;
    while offset < bytes.len() {
        if report.regions.len() >= MAX_RESULTS {
            report.truncated = true;
            report.warnings.push("regions_limit_reached".to_string());
            break;
        }
        let end = (offset + window).min(bytes.len());
        let summary = summarize(&bytes[offset..end]);
        if summary.entropy >= HIGH_ENTROPY {
            consecutive_high += 1;
            report.max_consecutive_high_entropy =
                report.max_consecutive_high_entropy.max(consecutive_high);
        } else {
            consecutive_high = 0;
        }
        let reference = RegionRef {
            offset,
            entropy: summary.entropy,
        };
        if report
            .highest_entropy_region
            .as_ref()
            .map(|r| reference.entropy > r.entropy)
            .unwrap_or(true)
        {
            report.highest_entropy_region = Some(reference);
        }
        if report
            .lowest_entropy_region
            .as_ref()
            .map(|r| reference.entropy < r.entropy)
            .unwrap_or(true)
        {
            report.lowest_entropy_region = Some(reference);
        }
        report.regions.push(Region {
            offset,
            size: end - offset,
            summary,
        });
        offset += stride;
    }

    report.assessment = assessment(&report);
    to_json(&report)
}

fn summarize(bytes: &[u8]) -> ClassSummary {
    if bytes.is_empty() {
        return ClassSummary {
            entropy: 0.0,
            ascii: 0.0,
            null: 0.0,
            high: 0.0,
            classification: "empty",
        };
    }
    let counts = histogram(bytes);
    let n = bytes.len() as f64;
    let entropy = round2(shannon(&counts, bytes.len()));
    let ascii = round4(
        counts
            .iter()
            .enumerate()
            .filter(|(b, _)| is_text_byte(*b as u8))
            .map(|(_, c)| *c)
            .sum::<u64>() as f64
            / n,
    );
    let null = round4(counts[0] as f64 / n);
    let high = round4(counts[0x80..].iter().sum::<u64>() as f64 / n);
    ClassSummary {
        entropy,
        ascii,
        null,
        high,
        classification: classify(entropy, ascii, null),
    }
}

/// Triage hints per the conventional bands: >7.2 sustained suggests
/// encrypted/compressed/packed data, ~4-6 is typical of code and structured
/// data, <2 indicates sparse or padding regions.
fn classify(entropy: f64, ascii: f64, null: f64) -> &'static str {
    if entropy >= 7.2 {
        "encrypted/compressed/packed"
    } else if entropy >= 5.5 {
        "high-mixed"
    } else if entropy >= 4.0 {
        "code-or-structured"
    } else if entropy >= 2.0 {
        if ascii >= 0.5 {
            "text"
        } else {
            "low-density"
        }
    } else if null >= 0.5 {
        "padding-or-sparse"
    } else {
        "low-entropy"
    }
}

fn assessment(report: &Report) -> String {
    if report.input_bytes == 0 {
        return "empty input".to_string();
    }
    let high_regions = report
        .regions
        .iter()
        .filter(|r| r.summary.entropy >= HIGH_ENTROPY)
        .count();
    if report.overall.entropy >= HIGH_ENTROPY {
        return format!(
            "overall entropy {:.2} bits/byte with {} high-entropy region(s) ({}% of profiled regions); consistent with encrypted, compressed, or packed data",
            report.overall.entropy,
            high_regions,
            if report.regions.is_empty() {
                0
            } else {
                high_regions * 100 / report.regions.len()
            }
        );
    }
    if high_regions > 0 {
        return format!(
            "overall entropy {:.2} bits/byte but {} region(s) exceed {:.1} (longest run {}); partial encrypted/compressed content likely",
            report.overall.entropy,
            high_regions,
            HIGH_ENTROPY,
            report.max_consecutive_high_entropy
        );
    }
    format!(
        "overall entropy {:.2} bits/byte; no high-entropy regions — unstructured padding, code, or text",
        report.overall.entropy
    )
}
