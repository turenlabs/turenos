//! `xor_probe`: bounded XOR key detection.
//!
//! Single-byte keys are scored exhaustively (0x00..=0xFF — key 0 included so
//! plaintext input surfaces as itself). Multi-byte keys up to length 8 are
//! recovered per residue class by maximizing the printable-byte ratio of each
//! sub-stream, then scored like any other candidate. Scoring uses a byte
//! histogram of the scanned region plus magic/content checks over a short
//! decoded prefix, so cost stays bounded regardless of scan size.

use serde::{Deserialize, Serialize};

use crate::{error_json, hex_encode, histogram, is_text_byte, round4, to_json};

const DEFAULT_SCAN_BYTES: usize = 256 * 1024;
const MAX_SCAN_BYTES: usize = 4 * 1024 * 1024;
const MAX_TOP_K: usize = 64;
const MAX_KEY_LENGTH: usize = 8;
const MAX_PROVIDED_KEYS: usize = 64;
const MAX_PROVIDED_KEY_BYTES: usize = 32;
const MAGIC_WINDOW: usize = 512;
const PREVIEW_BYTES: usize = 64;
const MAX_CRIB_BYTES: usize = 64;
const MAX_CRIB_POSITIONS: usize = 64 * 1024;
const MAX_CRIB_CANDIDATES: usize = 64;

/// (name, needle, match only at offset 0 vs anywhere in the magic window)
const MAGICS: &[(&str, &[u8], bool)] = &[
    ("mz", b"MZ", true),
    ("elf", b"\x7fELF", true),
    ("zip", b"PK\x03\x04", true),
    ("pdf", b"%PDF", true),
    ("png", b"\x89PNG\r\n\x1a\n", true),
    ("gif", b"GIF8", true),
    ("jpeg", b"\xff\xd8\xff", true),
    ("gzip", b"\x1f\x8b\x08", true),
    ("seven-zip", b"7z\xbc\xaf\x27\x1c", true),
    ("riff", b"RIFF", true),
    ("sqlite3", b"SQLite format 3\x00", true),
    ("wasm", b"\x00asm", true),
    ("json", b"{\"", true),
    ("xml", b"<?xml", true),
    ("pem", b"-----BEGIN", true),
    ("shebang", b"#!/", true),
    ("http-url", b"http://", false),
    ("https-url", b"https://", false),
    ("dos-stub", b"This program", false),
    ("html", b"<html", false),
    ("html-upper", b"<HTML", false),
    // Common protocol/format words: cheap known-content hits that separate a
    // true decode from high-printable garbage.
    ("http-get", b"GET /", false),
    ("http-post", b"POST /", false),
    ("http-version", b"HTTP/1", false),
    ("http-host", b"Host:", false),
    ("http-user-agent", b"User-Agent", false),
    ("content-type", b"Content-Type", false),
    ("dot-com", b".com", false),
    ("dot-exe", b".exe", false),
    ("dot-dll", b".dll", false),
    ("win32-kernel", b"kernel32", false),
    ("win32-kernel-upper", b"KERNEL32", false),
];

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct XorOptions {
    #[serde(alias = "top_k")]
    top_k: Option<usize>,
    #[serde(alias = "scan_bytes")]
    scan_bytes: Option<usize>,
    #[serde(alias = "max_key_length")]
    max_key_length: Option<usize>,
    #[serde(alias = "min_score")]
    min_score: Option<f64>,
    keys: Option<Vec<String>>,
    crib: Option<String>,
    #[serde(alias = "crib_hex")]
    crib_hex: Option<String>,
}

#[derive(Serialize)]
struct Candidate {
    key: String,
    length: usize,
    method: &'static str,
    score: f64,
    printable_ratio: f64,
    magic_hits: Vec<&'static str>,
    preview_hex: String,
}

#[derive(Serialize)]
struct Report {
    schema_version: u32,
    input_bytes: usize,
    scanned_bytes: usize,
    candidates: Vec<Candidate>,
    warnings: Vec<String>,
    truncated: bool,
}

struct Scored {
    key: Vec<u8>,
    method: &'static str,
    score: f64,
    printable: f64,
    hits: Vec<&'static str>,
}

pub fn run(bytes: &[u8], options_json: &str) -> String {
    let options: XorOptions = match serde_json::from_str(options_json) {
        Ok(options) => options,
        Err(error) => return error_json("options_invalid", &error.to_string()),
    };
    let top_k = options.top_k.unwrap_or(8).clamp(1, MAX_TOP_K);
    let scan_len = options
        .scan_bytes
        .map(|n| n.clamp(1, MAX_SCAN_BYTES))
        .unwrap_or(DEFAULT_SCAN_BYTES)
        .min(bytes.len());
    let max_key_length = options
        .max_key_length
        .unwrap_or(1)
        .clamp(1, MAX_KEY_LENGTH);
    let min_score = options.min_score.unwrap_or(0.0).clamp(-8.0, 16.0);

    let mut report = Report {
        schema_version: 1,
        input_bytes: bytes.len(),
        scanned_bytes: scan_len,
        candidates: Vec::new(),
        warnings: Vec::new(),
        truncated: false,
    };
    let scan = &bytes[..scan_len];

    // Parse caller-provided hex keys first so they always get evaluated.
    let mut provided: Vec<Vec<u8>> = Vec::new();
    if let Some(keys) = &options.keys {
        for key_hex in keys.iter().take(MAX_PROVIDED_KEYS) {
            match parse_hex(key_hex) {
                Some(key) if !key.is_empty() && key.len() <= MAX_PROVIDED_KEY_BYTES => {
                    provided.push(key)
                }
                _ => return error_json("options_invalid", "keys entries must be 1-32 byte hex strings"),
            }
        }
        if keys.len() > MAX_PROVIDED_KEYS {
            report
                .warnings
                .push("provided_keys_truncated".to_string());
        }
    }

    // Known-plaintext crib (raw text via `crib`, arbitrary bytes via
    // `cribHex`) yields exact key derivation: placed at any position, a crib
    // at least `length` bytes long fixes every residue of a repeating key.
    let crib: Vec<u8> = if let Some(crib) = &options.crib {
        crib.as_bytes().to_vec()
    } else if let Some(crib_hex) = &options.crib_hex {
        match parse_hex(crib_hex) {
            Some(crib) => crib,
            None => return error_json("options_invalid", "cribHex must be a hex string"),
        }
    } else {
        Vec::new()
    };
    if crib.len() > MAX_CRIB_BYTES {
        return error_json("options_invalid", "crib exceeds 64 bytes");
    }

    let mut scored: Vec<Scored> = Vec::new();
    if scan_len > 0 {
        let counts = histogram(scan);
        for key in provided {
            push_scored(&mut scored, scan, &counts, key, "provided");
        }
        for key in 0u16..=255 {
            push_scored(&mut scored, scan, &counts, vec![key as u8], "exhaustive");
        }
        if !crib.is_empty() {
            for key in crib_keys(scan, &crib, max_key_length) {
                push_scored(&mut scored, scan, &counts, key, "crib");
            }
        }
        if max_key_length > 1 {
            for length in 2..=max_key_length {
                if length > scan_len {
                    break;
                }
                let key = recover_key(scan, length);
                push_scored(&mut scored, scan, &counts, key, "recovered");
            }
        }
    }

    // Deterministic order: score desc, then key bytes asc, then length asc.
    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.key.cmp(&b.key))
            .then_with(|| a.key.len().cmp(&b.key.len()))
    });
    let mut seen: Vec<Vec<u8>> = Vec::new();
    for item in scored {
        if item.score < min_score {
            continue;
        }
        if seen.iter().any(|k| *k == item.key) {
            continue;
        }
        seen.push(item.key.clone());
        if report.candidates.len() >= top_k {
            report.truncated = true;
            break;
        }
        let preview_len = scan_len.min(PREVIEW_BYTES);
        let preview: Vec<u8> = scan[..preview_len]
            .iter()
            .enumerate()
            .map(|(i, b)| b ^ item.key[i % item.key.len()])
            .collect();
        report.candidates.push(Candidate {
            key: hex_encode(&item.key),
            length: item.key.len(),
            method: item.method,
            score: round4(item.score),
            printable_ratio: round4(item.printable),
            magic_hits: item.hits,
            preview_hex: hex_encode(&preview),
        });
    }

    to_json(&report)
}

fn push_scored(scored: &mut Vec<Scored>, scan: &[u8], counts: &[u64; 256], key: Vec<u8>, method: &'static str) {
    if key.is_empty() || scan.is_empty() {
        return;
    }
    let (printable, hits) = score(scan, counts, &key);
    scored.push(Scored {
        key,
        method,
        score: printable + 0.3 * hits.len().min(3) as f64,
        printable,
        hits,
    });
}

/// Printable ratio from the histogram plus magic hits on the decoded prefix.
fn score(scan: &[u8], counts: &[u64; 256], key: &[u8]) -> (f64, Vec<&'static str>) {
    // Histogram-scored printable ratio. For multi-byte keys each residue class
    // uses its own key byte, so score per class and weight by class size.
    let mut printable_bytes = 0u64;
    if key.len() == 1 {
        let k = key[0] as usize;
        for (value, &count) in counts.iter().enumerate() {
            if is_text_byte((value ^ k) as u8) {
                printable_bytes += count;
            }
        }
    } else {
        for (index, &b) in scan.iter().enumerate() {
            if is_text_byte(b ^ key[index % key.len()]) {
                printable_bytes += 1;
            }
        }
    }
    let printable = printable_bytes as f64 / scan.len() as f64;

    let window = scan.len().min(MAGIC_WINDOW);
    let mut decoded = Vec::with_capacity(window);
    for (index, &b) in scan.iter().take(window).enumerate() {
        decoded.push(b ^ key[index % key.len()]);
    }
    let mut hits = Vec::new();
    for (name, needle, at_start) in MAGICS {
        let found = if *at_start {
            decoded.starts_with(needle)
        } else {
            contains(&decoded, needle)
        };
        if found {
            hits.push(*name);
        }
    }
    (printable, hits)
}

/// Derive candidate keys of lengths 1..=max_length from a known-plaintext
/// crib placed at each bounded position. A crib at least `length` bytes long
/// fixes every key residue; shorter cribs are skipped for that length.
fn crib_keys(scan: &[u8], crib: &[u8], max_length: usize) -> Vec<Vec<u8>> {
    let mut keys: Vec<Vec<u8>> = Vec::new();
    if crib.len() > scan.len() {
        return keys;
    }
    let positions = (scan.len() - crib.len() + 1).min(MAX_CRIB_POSITIONS);
    // Longest lengths first: a crib of N bytes fully determines an N-byte
    // key, so longer hypotheses carry the most information. Each length gets
    // its own candidate budget so short lengths cannot starve longer ones.
    for length in (1..=max_length.min(crib.len())).rev() {
        let mut emitted = 0usize;
        for start in 0..positions {
            let mut key = vec![0u8; length];
            for residue in 0..length {
                // Smallest j with (start + j) congruent to residue (mod length).
                let j = (residue + length - (start % length)) % length;
                key[residue] = scan[start + j] ^ crib[j];
            }
            if keys.iter().any(|k| *k == key) {
                continue;
            }
            keys.push(key);
            emitted += 1;
            if emitted >= MAX_CRIB_CANDIDATES {
                break;
            }
        }
    }
    keys
}

/// Recover a repeating key of `length` by maximizing printable bytes in each
/// residue class independently.
fn recover_key(scan: &[u8], length: usize) -> Vec<u8> {
    let mut key = vec![0u8; length];
    for residue in 0..length {
        let mut counts = [0u64; 256];
        let mut index = residue;
        while index < scan.len() {
            counts[scan[index] as usize] += 1;
            index += length;
        }
        let mut best = 0u8;
        let mut best_score = 0u64;
        for k in 0u16..=255 {
            let mut score = 0u64;
            for (value, &count) in counts.iter().enumerate() {
                if count != 0 && is_text_byte((value ^ (k as usize)) as u8) {
                    score += count;
                }
            }
            if score > best_score {
                best_score = score;
                best = k as u8;
            }
        }
        key[residue] = best;
    }
    key
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    needle.len() <= haystack.len()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

fn parse_hex(text: &str) -> Option<Vec<u8>> {
    let text = text.strip_prefix("0x").unwrap_or(text);
    if text.is_empty() || text.len() % 2 != 0 || text.len() > 2 * MAX_PROVIDED_KEY_BYTES {
        return None;
    }
    let mut out = Vec::with_capacity(text.len() / 2);
    let bytes = text.as_bytes();
    for pair in bytes.chunks(2) {
        let hi = hex_digit(pair[0])?;
        let lo = hex_digit(pair[1])?;
        out.push((hi << 4) | lo);
    }
    Some(out)
}

fn hex_digit(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}
