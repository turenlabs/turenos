//! `byte_stats`: whole-buffer byte-structure profile for triage.

use serde::{Deserialize, Serialize};

use crate::{error_json, histogram, is_text_byte, round2, round4, shannon, to_json};

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StatsOptions {
    min_string_length: Option<usize>,
    top_bytes: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TopByte {
    byte: u8,
    count: u64,
    ratio: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LineEndings {
    lf: u64,
    crlf: u64,
    cr_only: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LongestRun {
    byte: u8,
    offset: usize,
    length: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StringCounts {
    min_length: usize,
    ascii_count: u64,
    utf16le_count: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    schema_version: u32,
    length: usize,
    entropy: f64,
    unique_bytes: usize,
    null_ratio: f64,
    ascii_printable_ratio: f64,
    high_ratio: f64,
    top_bytes: Vec<TopByte>,
    line_endings: LineEndings,
    longest_run: Option<LongestRun>,
    strings: StringCounts,
}

pub fn run(bytes: &[u8], options_json: &str) -> String {
    let options: StatsOptions = match serde_json::from_str(options_json) {
        Ok(options) => options,
        Err(error) => return error_json("options_invalid", &error.to_string()),
    };
    let min_string_length = options.min_string_length.unwrap_or(4).clamp(1, 64);
    let top_bytes = options.top_bytes.unwrap_or(16).clamp(1, 64);

    let counts = histogram(bytes);
    let n = bytes.len();
    let entropy = round2(shannon(&counts, n));

    let mut ranked: Vec<(u8, u64)> = counts
        .iter()
        .enumerate()
        .filter(|(_, &c)| c > 0)
        .map(|(b, &c)| (b as u8, c))
        .collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    let report = Report {
        schema_version: 1,
        length: n,
        entropy,
        unique_bytes: ranked.len(),
        null_ratio: if n == 0 { 0.0 } else { round4(counts[0] as f64 / n as f64) },
        ascii_printable_ratio: if n == 0 {
            0.0
        } else {
            round4(
                counts
                    .iter()
                    .enumerate()
                    .filter(|(b, _)| is_text_byte(*b as u8))
                    .map(|(_, c)| *c)
                    .sum::<u64>() as f64
                    / n as f64,
            )
        },
        high_ratio: if n == 0 {
            0.0
        } else {
            round4(counts[0x80..].iter().sum::<u64>() as f64 / n as f64)
        },
        top_bytes: ranked
            .iter()
            .take(top_bytes)
            .map(|&(byte, count)| TopByte {
                byte,
                count,
                ratio: if n == 0 { 0.0 } else { round4(count as f64 / n as f64) },
            })
            .collect(),
        line_endings: line_endings(bytes),
        longest_run: longest_run(bytes),
        strings: StringCounts {
            min_length: min_string_length,
            ascii_count: count_runs(bytes, min_string_length, is_string_byte),
            utf16le_count: count_utf16le(bytes, min_string_length),
        },
    };
    to_json(&report)
}

fn line_endings(bytes: &[u8]) -> LineEndings {
    let mut lf = 0u64;
    let mut crlf = 0u64;
    let mut cr_only = 0u64;
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'\n' => lf += 1,
            b'\r' => {
                if index + 1 < bytes.len() && bytes[index + 1] == b'\n' {
                    crlf += 1;
                    index += 1;
                } else {
                    cr_only += 1;
                }
            }
            _ => {}
        }
        index += 1;
    }
    LineEndings { lf, crlf, cr_only }
}

fn longest_run(bytes: &[u8]) -> Option<LongestRun> {
    let mut best: Option<LongestRun> = None;
    let mut index = 0usize;
    while index < bytes.len() {
        let byte = bytes[index];
        let mut end = index + 1;
        while end < bytes.len() && bytes[end] == byte {
            end += 1;
        }
        let length = end - index;
        if best.as_ref().map(|r| length > r.length).unwrap_or(true) {
            best = Some(LongestRun { byte, offset: index, length });
        }
        index = end;
    }
    best
}

/// Bytes that may appear inside an embedded ASCII string: printable plus
/// horizontal tab. CR/LF terminate a string.
fn is_string_byte(b: u8) -> bool {
    (0x20..=0x7e).contains(&b) || b == 0x09
}

/// Bytes that may appear inside an embedded ASCII string: printable plus
/// horizontal tab. CR/LF terminate a string.
fn is_string_byte(b: u8) -> bool {
    (0x20..=0x7e).contains(&b) || b == 0x09
}

/// Count maximal runs of at least `min` bytes satisfying `pred`.
fn count_runs(bytes: &[u8], min: usize, pred: fn(u8) -> bool) -> u64 {
    let mut count = 0u64;
    let mut run = 0usize;
    for &b in bytes {
        if pred(b) {
            run += 1;
        } else {
            if run >= min {
                count += 1;
            }
            run = 0;
        }
    }
    if run >= min {
        count += 1;
    }
    count
}

/// Quick UTF-16LE string estimate: runs of `min` little-endian code units in
/// the printable-ASCII range (i.e. `0x20..=0x7e` followed by `0x00`).
fn count_utf16le(bytes: &[u8], min: usize) -> u64 {
    let mut count = 0u64;
    let mut index = 0usize;
    while index + 1 < bytes.len() {
        let mut run = 0usize;
        while index + 1 < bytes.len()
            && (0x20..=0x7e).contains(&bytes[index])
            && bytes[index + 1] == 0
        {
            run += 1;
            index += 2;
        }
        if run >= min {
            count += 1;
        }
        if run == 0 {
            index += 1;
        }
    }
    count
}
