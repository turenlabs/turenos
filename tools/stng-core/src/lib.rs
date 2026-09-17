use base64::Engine;
use serde::Serialize;
use std::collections::HashSet;
use wasm_bindgen::prelude::*;

const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_RESULTS: usize = 4096;
const MAX_VALUE_BYTES: usize = 64 * 1024;
const MAX_TOTAL_VALUE_BYTES: usize = 4 * 1024 * 1024;
const MAX_XOR_KEY_BYTES: usize = 64;
const MAX_CUSTOM_XOR_INPUT: usize = 5 * 1024 * 1024;
const MAX_AUTO_XOR_INPUT: usize = 512 * 1024;
const MAX_OUTPUT_BYTES: usize = 6 * 1024 * 1024;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Finding {
    value: String,
    offset: u64,
    length: u32,
    method: &'static str,
    kind: Option<&'static str>,
    xor_key: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResultPayload {
    schema_version: u8,
    strings: Vec<Finding>,
    truncated: bool,
    warnings: Vec<String>,
}

struct Collector {
    values: Vec<Finding>,
    seen: HashSet<String>,
    value_bytes: usize,
    truncated: bool,
}

impl Collector {
    fn new() -> Self {
        Self {
            values: Vec::new(),
            seen: HashSet::new(),
            value_bytes: 0,
            truncated: false,
        }
    }

    fn push(&mut self, mut finding: Finding) -> bool {
        if finding.value.len() > MAX_VALUE_BYTES {
            finding.value.truncate(MAX_VALUE_BYTES);
            self.truncated = true;
        }
        if finding.value.is_empty() || !self.seen.insert(finding.value.clone()) {
            return true;
        }
        if self.values.len() >= MAX_RESULTS
            || self.value_bytes.saturating_add(finding.value.len()) > MAX_TOTAL_VALUE_BYTES
        {
            self.truncated = true;
            return false;
        }
        self.value_bytes += finding.value.len();
        self.values.push(finding);
        true
    }
}

#[wasm_bindgen]
pub fn extract(
    bytes: &[u8],
    min_length: u32,
    decode: bool,
    auto_xor: bool,
    xor_key: &[u8],
) -> Result<String, JsError> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(JsError::new(&format!(
            "input size {} exceeds limit {}",
            bytes.len(),
            MAX_INPUT_BYTES
        )));
    }
    if xor_key.len() > MAX_XOR_KEY_BYTES {
        return Err(JsError::new("XOR key exceeds 64-byte limit"));
    }
    let minimum = usize::try_from(min_length.clamp(4, 1024)).unwrap_or(4);
    let mut collector = Collector::new();
    scan_ascii(bytes, minimum, "raw", None, &mut collector);
    scan_utf16(bytes, minimum, &mut collector);

    if decode {
        decode_strings(&mut collector);
    }
    if !xor_key.is_empty() {
        if bytes.len() > MAX_CUSTOM_XOR_INPUT {
            return Err(JsError::new("custom XOR input exceeds 5 MiB limit"));
        }
        scan_xor(bytes, minimum, xor_key, &mut collector);
    } else if auto_xor {
        if bytes.len() > MAX_AUTO_XOR_INPUT {
            return Err(JsError::new("automatic XOR input exceeds 512 KiB limit"));
        }
        for key in 1u8..=255 {
            scan_xor(bytes, minimum.max(8), &[key], &mut collector);
            if collector.truncated {
                break;
            }
        }
    }

    let mut warnings = Vec::new();
    if collector.truncated {
        warnings.push("results truncated by aggregate string limits".into());
    }
    let payload = ResultPayload {
        schema_version: 1,
        strings: collector.values,
        truncated: collector.truncated,
        warnings,
    };
    let json = serde_json::to_string(&payload).map_err(|error| JsError::new(&error.to_string()))?;
    if json.len() > MAX_OUTPUT_BYTES {
        return Err(JsError::new("serialized result exceeds 6 MiB limit"));
    }
    Ok(json)
}

fn scan_ascii(
    bytes: &[u8],
    minimum: usize,
    method: &'static str,
    xor_key: Option<String>,
    collector: &mut Collector,
) {
    let mut start = None;
    for index in 0..=bytes.len() {
        let printable = index < bytes.len() && is_printable(bytes[index]);
        if printable {
            if start.is_none() {
                start = Some(index);
            }
            continue;
        }
        let Some(run_start) = start.take() else {
            continue;
        };
        if index - run_start < minimum {
            continue;
        }
        let Ok(value) = std::str::from_utf8(&bytes[run_start..index]) else {
            continue;
        };
        let value = value.trim();
        if value.len() < minimum || !useful(value) {
            continue;
        }
        if !collector.push(Finding {
            value: value.into(),
            offset: run_start as u64,
            length: u32::try_from(index - run_start).unwrap_or(u32::MAX),
            method,
            kind: classify(value),
            xor_key: xor_key.clone(),
        }) {
            return;
        }
    }
}

fn scan_utf16(bytes: &[u8], minimum: usize, collector: &mut Collector) {
    for parity in 0..=1 {
        let mut index = parity;
        while index + 1 < bytes.len() {
            if !is_printable(bytes[index]) || bytes[index + 1] != 0 {
                index += 2;
                continue;
            }
            // A printable byte immediately before this pair is commonly the
            // tail of an adjacent narrow string whose NUL happens to look
            // like this pair's high byte. Let the next pair establish the
            // wide run instead of merging the narrow suffix into it.
            if index > 0 && is_printable(bytes[index - 1]) {
                index += 2;
                continue;
            }
            let start = index;
            let mut value = Vec::new();
            while index + 1 < bytes.len() && is_printable(bytes[index]) && bytes[index + 1] == 0 {
                value.push(bytes[index]);
                index += 2;
            }
            if value.len() < minimum {
                continue;
            }
            let Ok(value) = String::from_utf8(value) else {
                continue;
            };
            let value = value.trim();
            if value.len() < minimum || !useful(value) {
                continue;
            }
            if !collector.push(Finding {
                value: value.into(),
                offset: start as u64,
                length: u32::try_from(index - start).unwrap_or(u32::MAX),
                method: "utf16le",
                kind: classify(value),
                xor_key: None,
            }) {
                return;
            }
        }
    }
}

fn decode_strings(collector: &mut Collector) {
    let source = collector.values.clone();
    for finding in source {
        let candidates = [
            decode_base64(&finding.value).map(|value| (value, "base64")),
            decode_hex(&finding.value).map(|value| (value, "hex")),
            decode_url(&finding.value).map(|value| (value, "url")),
        ];
        for candidate in candidates.into_iter().flatten() {
            let value = candidate.0.trim();
            if value.len() < 4 || !useful(value) {
                continue;
            }
            if !collector.push(Finding {
                value: value.into(),
                offset: finding.offset,
                length: finding.length,
                method: candidate.1,
                kind: classify(value),
                xor_key: finding.xor_key.clone(),
            }) {
                return;
            }
        }
    }
}

fn decode_base64(value: &str) -> Option<String> {
    if value.len() < 12 || value.len() % 4 != 0 {
        return None;
    }
    if !value.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=' | b'-' | b'_')
    }) {
        return None;
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(value)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(value))
        .ok()?;
    printable_text(decoded)
}

fn decode_hex(value: &str) -> Option<String> {
    if value.len() < 16
        || value.len() % 2 != 0
        || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return None;
    }
    printable_text(hex::decode(value).ok()?)
}

fn decode_url(value: &str) -> Option<String> {
    if !value.contains('%') {
        return None;
    }
    let decoded = urlencoding::decode(value).ok()?.into_owned();
    (decoded != value).then_some(decoded)
}

fn printable_text(bytes: Vec<u8>) -> Option<String> {
    if bytes.len() > MAX_VALUE_BYTES {
        return None;
    }
    let value = String::from_utf8(bytes).ok()?;
    useful(&value).then_some(value)
}

fn scan_xor(bytes: &[u8], minimum: usize, key: &[u8], collector: &mut Collector) {
    let decoded: Vec<u8> = bytes
        .iter()
        .enumerate()
        .map(|(index, byte)| byte ^ key[index % key.len()])
        .collect();
    scan_ascii(&decoded, minimum, "xor", Some(hex::encode(key)), collector);
}

fn is_printable(byte: u8) -> bool {
    byte.is_ascii_graphic() || matches!(byte, b' ' | b'\t' | b'\r' | b'\n')
}

fn useful(value: &str) -> bool {
    if value.chars().count() < 4 {
        return false;
    }
    let visible = value
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\t' | '\r' | '\n'))
        .count();
    let alphanumeric = value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .count();
    visible * 100 / value.chars().count().max(1) >= 90 && alphanumeric * 100 / visible.max(1) >= 25
}

fn classify(value: &str) -> Option<&'static str> {
    let lower = value.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Some("url");
    }
    if value.contains('@') && value.contains('.') && !value.contains(' ') {
        return Some("email");
    }
    if lower.ends_with(".onion") {
        return Some("onion");
    }
    if value.starts_with("HKLM\\") || value.starts_with("HKCU\\") || value.starts_with("HKEY_") {
        return Some("registry");
    }
    if value.starts_with('/') || value.starts_with("C:\\") || value.starts_with("\\\\") {
        return Some("path");
    }
    if lower.contains("powershell") || lower.contains("/bin/sh") || lower.contains("cmd.exe") {
        return Some("shell_command");
    }
    if matches!(value.len(), 32 | 40 | 64 | 128)
        && value.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Some("hash");
    }
    if value.matches('.').count() == 2 && value.starts_with("eyJ") {
        return Some("jwt");
    }
    if value.parse::<std::net::IpAddr>().is_ok() {
        return Some("ip");
    }
    None
}
