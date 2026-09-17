use exif::Reader as ExifReader;
use goblin::elf;
use goblin::Object;
use iced_x86::{Decoder, DecoderOptions, Formatter, Instruction, IntelFormatter};
use md5::{Digest, Md5};
use quick_xml::events::Event;
use quick_xml::Reader as XmlReader;
use serde::Serialize;
use sha1::Sha1;
use sha2::{Sha256, Sha512};
use std::io::{Cursor, Read};
use std::path::PathBuf;
use tlsh2::TlshBuilder128_1;
use wasm_bindgen::prelude::*;
use zip::ZipArchive;

mod archives;
mod document_code;
mod packers;
mod reversing;

#[wasm_bindgen]
pub fn supports_archive(bytes: &[u8]) -> bool {
    archives::supports(bytes)
}

const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_RESULTS: usize = 4096;
const MAX_STRING_BYTES: usize = 4096;
const MAX_ENTRY_BYTES: usize = 8 * 1024 * 1024;
const MAX_INSTRUCTIONS: usize = 256;
const MAX_OVERLAY_PREVIEW: usize = 64;
const MIN_EMBEDDED_SPAN: usize = 64;
const MAX_OFFICE_ENTRIES: usize = 4096;
const MAX_OFFICE_XML_BYTES: usize = 2 * 1024 * 1024;
const MAX_OFFICE_XML_TOTAL: usize = 16 * 1024 * 1024;
const MAX_OFFICE_STREAM_BYTES: usize = 8 * 1024 * 1024;
const MAX_OFFICE_FINDINGS: usize = 256;
const MAX_OFFICE_XML_DEPTH: usize = 64;
const MAX_OFFICE_XML_NODES: usize = 100_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    schema_version: u8,
    operation: String,
    truncated: bool,
    warnings: Vec<String>,
    result: serde_json::Value,
}

#[wasm_bindgen]
pub fn analyze(operation: &str, bytes: &[u8], options_json: &str) -> Result<String, JsError> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(JsError::new(&format!(
            "input size {} exceeds limit {}",
            bytes.len(),
            MAX_INPUT_BYTES
        )));
    }
    let options: serde_json::Value = if options_json.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(options_json).map_err(|error| JsError::new(&error.to_string()))?
    };
    let mut envelope = Envelope {
        schema_version: 1,
        operation: operation.into(),
        truncated: false,
        warnings: Vec::new(),
        result: serde_json::Value::Null,
    };
    envelope.result = match operation {
        "identify_file" => identify_file(bytes),
        "hash_digest" => hash_digest(bytes, &options),
        "entropy_scan" => entropy_scan(bytes, &options, &mut envelope),
        "fuzzy_hash" => fuzzy_hash(bytes, &mut envelope),
        "import_hash" => import_hash(bytes, &mut envelope),
        "disassemble" if options["architecture"] == "arm64" => {
            reversing::disassemble_arm64(bytes, &options).map_err(|error| JsError::new(&error))?
        }
        "disassemble" => disassemble(bytes, &options, &mut envelope),
        "function_flow" => {
            reversing::function_flow(bytes, &options).map_err(|error| JsError::new(&error))?
        }
        "vba_extract" => {
            document_code::vba_extract(bytes, &options).map_err(|error| JsError::new(&error))?
        }
        "dotnet_methods" => {
            document_code::dotnet_methods(bytes, &options).map_err(|error| JsError::new(&error))?
        }
        "scan_embedded" => scan_embedded(bytes, &options, &mut envelope),
        "detect_packer" => packers::detect(bytes),
        "list_archive" if archives::supports(bytes) => {
            archives::extra_list(bytes, &options).map_err(|error| JsError::new(&error))?
        }
        "extract_archive_entry" if archives::supports(bytes) => {
            archives::extra_extract(bytes, &options).map_err(|error| JsError::new(&error))?
        }
        "list_archive" => list_archive(bytes, &mut envelope),
        "extract_archive_entry" => extract_archive_entry(bytes, &options, &mut envelope),
        "parse_pdf" => parse_pdf(bytes, &mut envelope),
        "parse_ole" => parse_ole(bytes, &mut envelope),
        "office_inspect" => office_inspect(bytes, &mut envelope),
        "parse_exif" => parse_exif(bytes, &mut envelope),
        "parse_certificate" => parse_certificate(bytes, &mut envelope),
        "parse_plist" => parse_plist(bytes, &mut envelope),
        "parse_lnk" => parse_lnk(bytes, &mut envelope),
        "parse_minidump" => parse_minidump(bytes, &mut envelope),
        "demangle_symbol" => demangle_symbol(&options, &mut envelope),
        "parse_dotnet" => parse_dotnet(bytes, &mut envelope),
        "inspect_overlay" => inspect_overlay(bytes, &mut envelope),
        other => return Err(JsError::new(&format!("unsupported operation {other}"))),
    };
    if envelope.result["truncated"].as_bool() == Some(true) {
        envelope.truncated = true;
    }
    for key in ["warnings", "stopReasons"] {
        if let Some(items) = envelope.result[key].as_array() {
            envelope.warnings.extend(
                items
                    .iter()
                    .filter_map(|item| item.as_str())
                    .take(64)
                    .map(clean),
            );
        }
    }
    let json =
        serde_json::to_string(&envelope).map_err(|error| JsError::new(&error.to_string()))?;
    if json.len() > MAX_OUTPUT_BYTES {
        return Err(JsError::new(&format!(
            "serialized output size {} exceeds limit {}",
            json.len(),
            MAX_OUTPUT_BYTES
        )));
    }
    Ok(json)
}

fn identify_file(bytes: &[u8]) -> serde_json::Value {
    let kind = infer::get(bytes);
    serde_json::json!({
        "mime": kind.map(|item| item.mime_type()),
        "extension": kind.map(|item| item.extension()),
        "magic": magic_label(bytes),
        "size": bytes.len(),
    })
}

fn hash_digest(bytes: &[u8], options: &serde_json::Value) -> serde_json::Value {
    let algorithm = options
        .get("algorithm")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("sha256");
    let digest = match algorithm {
        "md5" => hex::encode(Md5::digest(bytes)),
        "sha1" => hex::encode(Sha1::digest(bytes)),
        "sha512" => hex::encode(Sha512::digest(bytes)),
        "blake3" => blake3::hash(bytes).to_hex().to_string(),
        "crc32" => format!("{:08x}", crc32fast::hash(bytes)),
        _ => hex::encode(Sha256::digest(bytes)),
    };
    serde_json::json!({
        "algorithm": if matches!(algorithm, "md5" | "sha1" | "sha512" | "blake3" | "crc32") { algorithm } else { "sha256" },
        "digest": digest,
        "size": bytes.len(),
    })
}

fn entropy_scan(
    bytes: &[u8],
    options: &serde_json::Value,
    envelope: &mut Envelope,
) -> serde_json::Value {
    let window = options
        .get("window")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(256)
        .clamp(16, 4096) as usize;
    let mut windows = Vec::new();
    let mut offset = 0usize;
    while offset < bytes.len() && windows.len() < MAX_RESULTS {
        let end = (offset + window).min(bytes.len());
        windows.push(serde_json::json!({
            "offset": offset,
            "length": end - offset,
            "entropy": shannon(&bytes[offset..end]),
        }));
        offset = end;
    }
    if offset < bytes.len() {
        envelope.truncated = true;
        envelope.warnings.push("entropy windows truncated".into());
    }
    serde_json::json!({
        "window": window,
        "overall": shannon(bytes),
        "windows": windows,
    })
}

fn fuzzy_hash(bytes: &[u8], envelope: &mut Envelope) -> serde_json::Value {
    if bytes.len() < 50 {
        envelope
            .warnings
            .push("TLSH requires at least 50 bytes".into());
        return serde_json::json!({ "algorithm": "tlsh", "digest": serde_json::Value::Null });
    }
    let mut builder = TlshBuilder128_1::new();
    builder.update(bytes);
    match builder.build() {
        Some(hash) => {
            serde_json::json!({ "algorithm": "tlsh", "digest": String::from_utf8_lossy(&hash.hash()).into_owned() })
        }
        None => {
            envelope
                .warnings
                .push("TLSH digest unavailable for this input".into());
            serde_json::json!({ "algorithm": "tlsh", "digest": serde_json::Value::Null })
        }
    }
}

fn import_hash(bytes: &[u8], envelope: &mut Envelope) -> serde_json::Value {
    match Object::parse(bytes) {
        Ok(Object::PE(binary)) => {
            let mut names: Vec<String> = binary
                .imports
                .iter()
                .map(|item| {
                    format!(
                        "{}!{}",
                        clean(item.dll).to_ascii_lowercase(),
                        clean(&item.name).to_ascii_lowercase()
                    )
                })
                .collect();
            names.sort();
            names.dedup();
            let joined = names.join(",");
            serde_json::json!({
                "format": "pe",
                "count": names.len(),
                "imphash": hex::encode(Md5::digest(joined.as_bytes())),
                "imports": names.into_iter().take(MAX_RESULTS).collect::<Vec<_>>(),
            })
        }
        Ok(_) => {
            envelope
                .warnings
                .push("import hashing is implemented for PE only".into());
            serde_json::json!({ "format": "unsupported", "count": 0, "imphash": serde_json::Value::Null, "imports": [] })
        }
        Err(error) => {
            envelope.warnings.push(clean(&error.to_string()));
            serde_json::json!({ "format": "unknown", "count": 0, "imphash": serde_json::Value::Null, "imports": [] })
        }
    }
}

fn disassemble(
    bytes: &[u8],
    options: &serde_json::Value,
    envelope: &mut Envelope,
) -> serde_json::Value {
    let offset = options
        .get("offset")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0) as usize;
    let length = options
        .get("length")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(64)
        .clamp(1, 4096) as usize;
    let bitness = options
        .get("bitness")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(64);
    if offset >= bytes.len() {
        envelope.warnings.push("offset is outside the input".into());
        return serde_json::json!({ "bitness": bitness, "offset": offset, "instructions": [] });
    }
    let slice = &bytes[offset..(offset + length).min(bytes.len())];
    let ip = options
        .get("address")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(offset as u64);
    let mut decoder = Decoder::with_ip(
        if bitness == 16 || bitness == 32 {
            bitness as u32
        } else {
            64
        },
        slice,
        ip,
        DecoderOptions::NONE,
    );
    let mut formatter = IntelFormatter::new();
    let mut instruction = Instruction::default();
    let mut instructions = Vec::new();
    while decoder.can_decode() && instructions.len() < MAX_INSTRUCTIONS {
        decoder.decode_out(&mut instruction);
        let mut text = String::new();
        formatter.format(&instruction, &mut text);
        instructions.push(serde_json::json!({
            "address": format!("0x{:x}", instruction.ip()),
            "bytes": hex::encode(&slice[instruction.ip() as usize - ip as usize..][..instruction.len()]),
            "text": text,
        }));
        if instruction.is_invalid() {
            envelope
                .warnings
                .push("encountered an invalid instruction".into());
            break;
        }
    }
    if decoder.can_decode() {
        envelope.truncated = true;
    }
    serde_json::json!({
        "bitness": if bitness == 16 || bitness == 32 { bitness } else { 64 },
        "offset": offset,
        "instructions": instructions,
    })
}

fn scan_embedded(
    bytes: &[u8],
    options: &serde_json::Value,
    envelope: &mut Envelope,
) -> serde_json::Value {
    let max_results = options
        .get("maxResults")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(64)
        .clamp(1, MAX_RESULTS as u64) as usize;
    let mut findings = Vec::new();
    let mut index = 0usize;
    while index + 4 < bytes.len() && findings.len() < max_results {
        if let Some((kind, length)) = embedded_at(bytes, index) {
            if length >= MIN_EMBEDDED_SPAN || index == 0 {
                findings.push(serde_json::json!({
                    "offset": index,
                    "length": length.min(bytes.len() - index),
                    "kind": kind,
                }));
                index += length.max(1).min(bytes.len() - index);
                continue;
            }
        }
        index += 1;
    }
    if index + 4 < bytes.len() {
        envelope.truncated = true;
        envelope.warnings.push("embedded scan truncated".into());
    }
    serde_json::json!({ "count": findings.len(), "findings": findings })
}

fn detect_packer(bytes: &[u8], envelope: &mut Envelope) -> serde_json::Value {
    let mut matches = Vec::new();
    if bytes.windows(4).any(|window| window == b"UPX!") {
        matches
            .push(serde_json::json!({ "name": "UPX", "confidence": "high", "evidence": "UPX!" }));
    }
    if bytes.windows(6).any(|window| window == b"MPRESS") {
        matches.push(
            serde_json::json!({ "name": "MPRESS", "confidence": "high", "evidence": "MPRESS" }),
        );
    }
    if bytes
        .windows(8)
        .any(|window| window == b".themida" || window == b".Themida")
    {
        matches.push(serde_json::json!({ "name": "Themida", "confidence": "medium", "evidence": ".themida" }));
    }
    if let Ok(Object::PE(binary)) = Object::parse(bytes) {
        for section in &binary.sections {
            let name = section.name().unwrap_or("");
            if name.starts_with("UPX") {
                matches.push(
                    serde_json::json!({ "name": "UPX", "confidence": "high", "evidence": name }),
                );
            }
            if name.contains("MPRESS") {
                matches.push(
                    serde_json::json!({ "name": "MPRESS", "confidence": "high", "evidence": name }),
                );
            }
            if name.eq_ignore_ascii_case(".aspack") || name.eq_ignore_ascii_case(".adata") {
                matches.push(serde_json::json!({ "name": "ASPack", "confidence": "medium", "evidence": name }));
            }
        }
        let entropy = shannon(bytes);
        if entropy > 7.2 {
            envelope
                .warnings
                .push("high overall entropy; possible packing or encryption".into());
        }
    }
    matches.dedup_by(|left, right| left["name"] == right["name"]);
    serde_json::json!({ "count": matches.len(), "matches": matches })
}

fn list_archive(bytes: &[u8], envelope: &mut Envelope) -> serde_json::Value {
    if bytes.starts_with(b"PK") {
        return list_zip(bytes, envelope);
    }
    if looks_like_tar(bytes) {
        return list_tar(bytes, envelope);
    }
    envelope
        .warnings
        .push("input is not a recognized ZIP or tar archive".into());
    serde_json::json!({ "format": "unknown", "entries": [] })
}

fn extract_archive_entry(
    bytes: &[u8],
    options: &serde_json::Value,
    envelope: &mut Envelope,
) -> serde_json::Value {
    let index = options
        .get("index")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0) as usize;
    let max_output = options
        .get("maxOutputBytes")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(MAX_ENTRY_BYTES as u64)
        .min(MAX_ENTRY_BYTES as u64) as usize;
    if bytes.starts_with(b"PK") {
        return extract_zip(bytes, index, max_output, envelope);
    }
    if looks_like_tar(bytes) {
        return extract_tar(bytes, index, max_output, envelope);
    }
    envelope
        .warnings
        .push("input is not a recognized ZIP or tar archive".into());
    serde_json::json!({ "format": "unknown" })
}

fn parse_pdf(bytes: &[u8], envelope: &mut Envelope) -> serde_json::Value {
    if !bytes.starts_with(b"%PDF") {
        envelope
            .warnings
            .push("input does not start with %PDF".into());
    }
    let text = String::from_utf8_lossy(bytes);
    let version = text.lines().next().unwrap_or("").trim();
    let javascript = text.contains("/JavaScript") || text.contains("/JS");
    let launch = text.contains("/Launch");
    let embedded_files = text.contains("/EmbeddedFiles");
    let open_action = text.contains("/OpenAction");
    let objects = count_token(&text, " obj");
    let streams = count_token(&text, "stream");
    serde_json::json!({
        "header": clean(version),
        "objects": objects,
        "streams": streams,
        "javascript": javascript,
        "launch": launch,
        "embeddedFiles": embedded_files,
        "openAction": open_action,
        "encrypted": text.contains("/Encrypt"),
    })
}

fn parse_ole(bytes: &[u8], envelope: &mut Envelope) -> serde_json::Value {
    let mut cursor = Cursor::new(bytes);
    let file = match cfb::CompoundFile::open(&mut cursor) {
        Ok(file) => file,
        Err(error) => {
            envelope.warnings.push(clean(&error.to_string()));
            return serde_json::json!({ "streams": [] });
        }
    };
    let mut streams = Vec::new();
    for entry in file.walk() {
        if !entry.is_stream() {
            continue;
        }
        if streams.len() >= MAX_RESULTS {
            envelope.truncated = true;
            break;
        }
        streams.push(serde_json::json!({
            "name": clean(entry.name()),
            "path": clean(&entry.path().display().to_string()),
            "size": entry.len(),
        }));
    }
    serde_json::json!({ "streams": streams })
}

#[derive(Default)]
struct OfficeIndicators {
    macro_found: bool,
    active_x_found: bool,
    dde_found: bool,
    external_found: bool,
    inconclusive: bool,
    macro_evidence: Vec<String>,
    active_x_evidence: Vec<String>,
    dde_evidence: Vec<String>,
    external_evidence: Vec<String>,
    relationships: Vec<serde_json::Value>,
    findings: Vec<serde_json::Value>,
}

fn office_inspect(bytes: &[u8], envelope: &mut Envelope) -> serde_json::Value {
    if bytes.starts_with(&[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) {
        return inspect_office_ole(bytes, envelope);
    }
    if bytes.starts_with(b"PK") {
        return inspect_office_zip(bytes, envelope);
    }
    envelope.warnings.push("input is not a recognized OOXML ZIP or OLE compound file".into());
    serde_json::json!({
        "format": "unknown",
        "valid": false,
        "parts": [],
        "streams": [],
        "relationships": [],
        "findings": [],
        "detections": office_detections(&OfficeIndicators { inconclusive: true, ..Default::default() }),
    })
}

fn inspect_office_zip(bytes: &[u8], envelope: &mut Envelope) -> serde_json::Value {
    let mut archive = match ZipArchive::new(Cursor::new(bytes)) {
        Ok(archive) => archive,
        Err(error) => {
            envelope.warnings.push(clean(&error.to_string()));
            return serde_json::json!({
                "format": "ooxml",
                "valid": false,
                "parts": [],
                "relationships": [],
                "findings": [],
                "detections": office_detections(&OfficeIndicators { inconclusive: true, ..Default::default() }),
            });
        }
    };
    match archive.has_overlapping_files() {
        Ok(true) => {
            envelope.warnings.push("ZIP contains overlapping compressed file ranges".into());
            return serde_json::json!({
                "format": "ooxml",
                "valid": false,
                "rejected": "overlapping_zip_entries",
                "parts": [],
                "relationships": [],
                "findings": [],
                "detections": office_detections(&OfficeIndicators { inconclusive: true, ..Default::default() }),
            });
        }
        Ok(false) => {}
        Err(error) => {
            envelope.warnings.push(clean(&error.to_string()));
        }
    }
    let count = archive.len();
    let mut parts = Vec::new();
    let mut indicators = OfficeIndicators::default();
    let mut xml_total = 0usize;
    for index in 0..count.min(MAX_OFFICE_ENTRIES) {
        let metadata = match archive.by_index(index) {
            Ok(file) => (
                clean(file.name()),
                file.size(),
                file.compressed_size(),
                file.encrypted(),
                file.is_dir(),
            ),
            Err(error) => {
                envelope.warnings.push(clean(&error.to_string()));
                indicators.inconclusive = true;
                continue;
            }
        };
        let (name, size, compressed_size, encrypted, directory) = metadata;
        if encrypted {
            envelope.warnings.push(format!("encrypted ZIP entry is not inspected: {name}"));
            indicators.inconclusive = true;
            return serde_json::json!({
                "format": "ooxml",
                "valid": false,
                "rejected": "encrypted_zip_entry",
                "partCount": count,
                "parts": parts,
                "relationships": indicators.relationships,
                "findings": indicators.findings,
                "detections": office_detections(&indicators),
            });
        }
        let lower_name = name.to_ascii_lowercase();
        if lower_name.ends_with("/vbaproject.bin") || lower_name == "vbaproject.bin" {
            indicators.macro_found = true;
            push_evidence(&mut indicators.macro_evidence, &name);
            push_finding(&mut indicators, "macro", &name, "vbaProject.bin part", envelope);
        }
        if lower_name.contains("/activex/") || lower_name.starts_with("activex/") {
            indicators.active_x_found = true;
            push_evidence(&mut indicators.active_x_evidence, &name);
            push_finding(&mut indicators, "activex", &name, "ActiveX part", envelope);
        }
        let xml_part = is_office_xml_part(&lower_name);
        let readable_xml = xml_part && !encrypted && size <= MAX_OFFICE_XML_BYTES as u64;
        if xml_part && encrypted {
            envelope.warnings.push(format!("encrypted XML part not inspected: {name}"));
            indicators.inconclusive = true;
        }
        if xml_part && size > MAX_OFFICE_XML_BYTES as u64 {
            envelope.warnings.push(format!("XML part exceeds {} bytes: {name}", MAX_OFFICE_XML_BYTES));
            envelope.truncated = true;
            indicators.inconclusive = true;
        }
        let mut xml_inspected = false;
        if readable_xml && xml_total.saturating_add(size as usize) <= MAX_OFFICE_XML_TOTAL {
            let mut data = Vec::new();
            let read_result = match archive.by_index(index) {
                Ok(file) => file.take((MAX_OFFICE_XML_BYTES + 1) as u64).read_to_end(&mut data),
                Err(error) => Err(std::io::Error::other(error.to_string())),
            };
            match read_result {
                Ok(_) if data.len() <= MAX_OFFICE_XML_BYTES => {
                    xml_total = xml_total.saturating_add(data.len());
                    xml_inspected = true;
                    scan_office_xml(&data, &name, &mut indicators, envelope);
                }
                Ok(_) => {
                    envelope.warnings.push(format!("XML part decompressed beyond limit: {name}"));
                    envelope.truncated = true;
                    indicators.inconclusive = true;
                }
                Err(error) => {
                    envelope.warnings.push(format!("unable to read XML part {name}: {}", clean(&error.to_string())));
                    indicators.inconclusive = true;
                }
            }
        } else if xml_part && readable_xml {
            envelope.warnings.push("aggregate XML inspection limit reached".into());
            envelope.truncated = true;
            indicators.inconclusive = true;
        }
        if parts.len() >= MAX_OFFICE_ENTRIES {
            envelope.truncated = true;
            break;
        }
        parts.push(serde_json::json!({
            "index": index,
            "name": name,
            "size": size,
            "compressedSize": compressed_size,
            "encrypted": encrypted,
            "directory": directory,
            "xmlInspected": xml_inspected,
        }));
    }
    if count > MAX_OFFICE_ENTRIES {
        envelope.truncated = true;
        envelope.warnings.push(format!("OOXML part list truncated at {MAX_OFFICE_ENTRIES}"));
    }
    serde_json::json!({
        "format": "ooxml",
        "valid": true,
        "partCount": count,
        "xmlBytesInspected": xml_total,
        "parts": parts,
        "relationships": indicators.relationships,
        "findings": indicators.findings,
        "detections": office_detections(&indicators),
    })
}

fn inspect_office_ole(bytes: &[u8], envelope: &mut Envelope) -> serde_json::Value {
    let mut file = match cfb::CompoundFile::open(Cursor::new(bytes)) {
        Ok(file) => file,
        Err(error) => {
            envelope.warnings.push(clean(&error.to_string()));
            return serde_json::json!({
                "format": "ole",
                "valid": false,
                "streams": [],
                "relationships": [],
                "findings": [],
                "detections": office_detections(&OfficeIndicators { inconclusive: true, ..Default::default() }),
            });
        }
    };
    let mut streams = Vec::new();
    let mut candidates = Vec::new();
    let mut more_entries = false;
    for entry in file.walk() {
        if streams.len() >= MAX_OFFICE_ENTRIES {
            more_entries = true;
            break;
        }
        if !entry.is_stream() {
            continue;
        }
        let path = clean(&entry.path().display().to_string());
        let upper = path.to_ascii_uppercase();
        if upper.contains("/VBA/") || upper.contains("VBA") || upper.contains("ACTIVEX") || upper.contains("PROJECT") {
            candidates.push((path.clone(), entry.len()));
        }
        streams.push(serde_json::json!({
            "name": clean(entry.name()),
            "path": path,
            "size": entry.len(),
        }));
    }
    if more_entries {
        envelope.truncated = true;
        envelope.warnings.push(format!("OLE stream list truncated at {MAX_OFFICE_ENTRIES}"));
    }
    let mut indicators = OfficeIndicators::default();
    let mut stream_bytes = 0usize;
    for (path, size) in candidates {
        let upper = path.to_ascii_uppercase();
        if upper.contains("/VBA/") || upper.contains("_VBA_PROJECT") || upper.ends_with("/DIR") {
            indicators.macro_found = true;
            push_evidence(&mut indicators.macro_evidence, &path);
            push_finding(&mut indicators, "macro", &path, "VBA project stream", envelope);
        }
        if upper.contains("ACTIVEX") {
            indicators.active_x_found = true;
            push_evidence(&mut indicators.active_x_evidence, &path);
            push_finding(&mut indicators, "activex", &path, "ActiveX-related stream", envelope);
        }
        if size > MAX_OFFICE_STREAM_BYTES as u64 || stream_bytes >= MAX_OFFICE_XML_TOTAL {
            envelope.truncated = true;
            indicators.inconclusive = true;
            continue;
        }
        let mut stream = match file.open_stream(PathBuf::from(&path)) {
            Ok(stream) => stream,
            Err(error) => {
                envelope.warnings.push(format!("unable to open OLE stream {path}: {}", clean(&error.to_string())));
                indicators.inconclusive = true;
                continue;
            }
        };
        let mut data = Vec::new();
        match (&mut stream).take(MAX_OFFICE_STREAM_BYTES as u64 + 1).read_to_end(&mut data) {
            Ok(_) if data.len() <= MAX_OFFICE_STREAM_BYTES => {
                stream_bytes = stream_bytes.saturating_add(data.len());
                if contains_ascii_case_insensitive(&data, b"dde") {
                    indicators.dde_found = true;
                    push_evidence(&mut indicators.dde_evidence, &path);
                    push_finding(&mut indicators, "dde", &path, "DDE marker in OLE stream", envelope);
                }
                if contains_ascii_case_insensitive(&data, b"http://")
                    || contains_ascii_case_insensitive(&data, b"https://")
                    || contains_ascii_case_insensitive(&data, b"file://")
                {
                    indicators.external_found = true;
                    push_evidence(&mut indicators.external_evidence, &path);
                    push_finding(&mut indicators, "external_link", &path, "external URI marker in OLE stream", envelope);
                }
            }
            Ok(_) => {
                envelope.truncated = true;
                indicators.inconclusive = true;
            }
            Err(error) => {
                envelope.warnings.push(format!("unable to read OLE stream {path}: {}", clean(&error.to_string())));
                indicators.inconclusive = true;
            }
        }
    }
    serde_json::json!({
        "format": "ole",
        "valid": true,
        "streamCount": streams.len(),
        "streams": streams,
        "bytesInspected": stream_bytes,
        "relationships": indicators.relationships,
        "findings": indicators.findings,
        "detections": office_detections(&indicators),
    })
}

fn scan_office_xml(bytes: &[u8], source: &str, indicators: &mut OfficeIndicators, envelope: &mut Envelope) {
    if contains_ascii_case_insensitive(bytes, b"macroenabled") || contains_ascii_case_insensitive(bytes, b"vbaproject") {
        indicators.macro_found = true;
        push_evidence(&mut indicators.macro_evidence, source);
        push_finding(indicators, "macro", source, "macro-enabled content type or VBA part", envelope);
    }
    if contains_ascii_case_insensitive(bytes, b"ddeauto") || contains_ascii_case_insensitive(bytes, b"dde") {
        indicators.dde_found = true;
        push_evidence(&mut indicators.dde_evidence, source);
        push_finding(indicators, "dde", source, "DDE marker in XML", envelope);
    }
    let mut reader = XmlReader::from_reader(bytes);
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut depth = 0usize;
    let mut nodes = 0usize;
    loop {
        let event = match reader.read_event_into(&mut buffer) {
            Ok(event) => event,
            Err(error) => {
                indicators.inconclusive = true;
                envelope.warnings.push(format!("unable to parse XML part {source}: {}", clean(&error.to_string())));
                break;
            }
        };
        match event {
            Event::Start(element) => {
                nodes += 1;
                depth = depth.saturating_add(1);
                if nodes > MAX_OFFICE_XML_NODES || depth > MAX_OFFICE_XML_DEPTH {
                    envelope.truncated = true;
                    indicators.inconclusive = true;
                    envelope.warnings.push(format!("XML limits reached in {source}"));
                    break;
                }
                let attributes = collect_office_attributes(element.attributes(), indicators);
                inspect_office_element(element.name().as_ref(), &attributes, source, indicators, envelope);
            }
            Event::Empty(element) => {
                nodes += 1;
                if nodes > MAX_OFFICE_XML_NODES {
                    envelope.truncated = true;
                    indicators.inconclusive = true;
                    envelope.warnings.push(format!("XML node limit reached in {source}"));
                    break;
                }
                let attributes = collect_office_attributes(element.attributes(), indicators);
                inspect_office_element(element.name().as_ref(), &attributes, source, indicators, envelope);
            }
            Event::End(_) => depth = depth.saturating_sub(1),
            Event::DocType(_) => {
                envelope.warnings.push(format!("DTD declaration rejected in XML part {source}"));
                indicators.inconclusive = true;
                break;
            }
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
}

fn collect_office_attributes(
    attributes: quick_xml::events::attributes::Attributes<'_>,
    indicators: &mut OfficeIndicators,
) -> Vec<(String, String)> {
    let mut collected = Vec::new();
    for (index, attribute) in attributes.enumerate() {
        if index >= 64 {
            indicators.inconclusive = true;
            break;
        }
        match attribute {
            Ok(attribute) => collected.push((
                String::from_utf8_lossy(xml_local_name(attribute.key.as_ref())).to_ascii_lowercase(),
                clean(&String::from_utf8_lossy(&attribute.value)),
            )),
            Err(_) => indicators.inconclusive = true,
        }
    }
    collected
}

fn inspect_office_element(
    name: &[u8],
    attributes: &[(String, String)],
    source: &str,
    indicators: &mut OfficeIndicators,
    envelope: &mut Envelope,
) {
    let local = xml_local_name(name);
    let lower = String::from_utf8_lossy(local).to_ascii_lowercase();
    let mut id = String::new();
    let mut relationship_type = String::new();
    let mut target = String::new();
    let mut target_mode = String::new();
    for (key, value) in attributes {
        if key == "id" {
            id = value.clone();
        } else if key == "type" {
            relationship_type = value.clone();
        } else if key == "target" {
            target = value.clone();
        } else if key == "targetmode" {
            target_mode = value.clone();
        }
        let lower_value = value.to_ascii_lowercase();
        if lower_value.contains("dde") || lower_value.contains("ddeauto") {
            indicators.dde_found = true;
            push_evidence(&mut indicators.dde_evidence, source);
            push_finding(indicators, "dde", source, "DDE marker in XML attribute", envelope);
        }
    }
    if lower == "relationship" {
        if target_mode.eq_ignore_ascii_case("external") {
            indicators.external_found = true;
            push_evidence(&mut indicators.external_evidence, source);
            if indicators.relationships.len() < MAX_RESULTS {
                indicators.relationships.push(serde_json::json!({
                    "source": source,
                    "id": id,
                    "type": relationship_type,
                    "target": target,
                    "targetMode": target_mode,
                }));
            } else {
                envelope.truncated = true;
            }
            push_finding(indicators, "external_link", source, "external OOXML relationship", envelope);
        }
        return;
    }
    if lower.contains("activex") || lower == "control" {
        indicators.active_x_found = true;
        push_evidence(&mut indicators.active_x_evidence, source);
        push_finding(indicators, "activex", source, "ActiveX/control XML element", envelope);
    }
    if lower.contains("dde") {
        indicators.dde_found = true;
        push_evidence(&mut indicators.dde_evidence, source);
        push_finding(indicators, "dde", source, "DDE XML element", envelope);
    }
}

fn office_detections(indicators: &OfficeIndicators) -> serde_json::Value {
    serde_json::json!({
        "macro": office_detection(indicators.macro_found, indicators.inconclusive, &indicators.macro_evidence),
        "activeX": office_detection(indicators.active_x_found, indicators.inconclusive, &indicators.active_x_evidence),
        "dde": office_detection(indicators.dde_found, indicators.inconclusive, &indicators.dde_evidence),
        "externalLinks": office_detection(indicators.external_found, indicators.inconclusive, &indicators.external_evidence),
    })
}

fn office_detection(present: bool, inconclusive: bool, evidence: &[String]) -> serde_json::Value {
    serde_json::json!({
        "status": if present { "present" } else if inconclusive { "inconclusive" } else { "absent" },
        "evidence": evidence,
    })
}

fn push_evidence(evidence: &mut Vec<String>, value: &str) {
    if evidence.len() < 32 && !evidence.iter().any(|item| item == value) {
        evidence.push(clean(value));
    }
}

fn push_finding(indicators: &mut OfficeIndicators, kind: &str, source: &str, detail: &str, envelope: &mut Envelope) {
    if indicators.findings.len() >= MAX_OFFICE_FINDINGS {
        envelope.truncated = true;
        return;
    }
    indicators.findings.push(serde_json::json!({
        "kind": kind,
        "source": clean(source),
        "detail": clean(detail),
    }));
}

fn is_office_xml_part(name: &str) -> bool {
    name.ends_with(".xml") || name.ends_with(".rels") || name == "[content_types].xml"
}

fn xml_local_name(name: &[u8]) -> &[u8] {
    match name.iter().rposition(|byte| *byte == b':') {
        Some(index) => &name[index + 1..],
        None => name,
    }
}

fn contains_ascii_case_insensitive(bytes: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && bytes.windows(needle.len()).any(|window| {
            window.iter().zip(needle).all(|(left, right)| left.to_ascii_lowercase() == right.to_ascii_lowercase())
        })
}

fn parse_exif(bytes: &[u8], envelope: &mut Envelope) -> serde_json::Value {
    match ExifReader::new().read_from_container(&mut Cursor::new(bytes)) {
        Ok(exif) => {
            let mut fields = Vec::new();
            for field in exif.fields() {
                if fields.len() >= MAX_RESULTS {
                    envelope.truncated = true;
                    break;
                }
                fields.push(serde_json::json!({
                    "tag": clean(&field.tag.to_string()),
                    "ifd": format!("{:?}", field.ifd_num),
                    "value": clean(&field.display_value().to_string()),
                }));
            }
            serde_json::json!({ "count": fields.len(), "fields": fields })
        }
        Err(error) => {
            envelope.warnings.push(clean(&error.to_string()));
            serde_json::json!({ "count": 0, "fields": [] })
        }
    }
}

fn parse_certificate(bytes: &[u8], envelope: &mut Envelope) -> serde_json::Value {
    match x509_parser::parse_x509_certificate(bytes) {
        Ok((_, cert)) => serde_json::json!({
            "subject": clean(&cert.subject().to_string()),
            "issuer": clean(&cert.issuer().to_string()),
            "serial": cert.raw_serial_as_string(),
            "notBefore": clean(&cert.validity().not_before.to_string()),
            "notAfter": clean(&cert.validity().not_after.to_string()),
            "signatureAlgorithm": clean(&cert.signature_algorithm.oid().to_id_string()),
        }),
        Err(error) => {
            envelope.warnings.push(clean(&error.to_string()));
            serde_json::json!({})
        }
    }
}

fn parse_plist(bytes: &[u8], envelope: &mut Envelope) -> serde_json::Value {
    match plist::Value::from_reader(Cursor::new(bytes)) {
        Ok(value) => summarize_plist(&value, 0, envelope),
        Err(error) => {
            envelope.warnings.push(clean(&error.to_string()));
            serde_json::json!({})
        }
    }
}

fn parse_lnk(bytes: &[u8], envelope: &mut Envelope) -> serde_json::Value {
    if bytes.len() < 0x4c || bytes[0..4] != [0x4c, 0, 0, 0] {
        envelope
            .warnings
            .push("input is not a Shell Link header".into());
        return serde_json::json!({});
    }
    let flags = u32::from_le_bytes(bytes[0x14..0x18].try_into().unwrap_or([0; 4]));
    let file_attributes = u32::from_le_bytes(bytes[0x18..0x1c].try_into().unwrap_or([0; 4]));
    let mut extra = Vec::new();
    if flags & 1 != 0 {
        extra.push("hasLinkTargetIdList");
    }
    if flags & 2 != 0 {
        extra.push("hasLinkInfo");
    }
    if flags & 4 != 0 {
        extra.push("hasName");
    }
    if flags & 8 != 0 {
        extra.push("hasRelativePath");
    }
    if flags & 0x10 != 0 {
        extra.push("hasWorkingDir");
    }
    if flags & 0x20 != 0 {
        extra.push("hasArguments");
    }
    if flags & 0x80 != 0 {
        extra.push("hasIconLocation");
    }
    serde_json::json!({
        "headerSize": u32::from_le_bytes(bytes[0..4].try_into().unwrap_or([0; 4])),
        "flags": format!("0x{flags:x}"),
        "fileAttributes": format!("0x{file_attributes:x}"),
        "features": extra,
        "localBasePath": extract_ascii(bytes, 0x4c, 260),
    })
}

fn parse_minidump(bytes: &[u8], envelope: &mut Envelope) -> serde_json::Value {
    if bytes.len() < 32 || bytes[0..4] != [b'M', b'D', b'M', b'P'] {
        envelope.warnings.push("input is not a minidump".into());
        return serde_json::json!({});
    }
    let stream_count = u32::from_le_bytes(bytes[8..12].try_into().unwrap_or([0; 4]));
    let directory_rva = u32::from_le_bytes(bytes[12..16].try_into().unwrap_or([0; 4])) as usize;
    let mut streams = Vec::new();
    for index in 0..stream_count.min(MAX_RESULTS as u32) {
        let offset = directory_rva.saturating_add(index as usize * 12);
        if offset + 12 > bytes.len() {
            envelope.truncated = true;
            break;
        }
        streams.push(serde_json::json!({
            "type": u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap_or([0; 4])),
            "size": u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap_or([0; 4])),
            "rva": u32::from_le_bytes(bytes[offset + 8..offset + 12].try_into().unwrap_or([0; 4])),
        }));
    }
    serde_json::json!({
        "version": u16::from_le_bytes(bytes[4..6].try_into().unwrap_or([0; 2])),
        "implementation": u16::from_le_bytes(bytes[6..8].try_into().unwrap_or([0; 2])),
        "streamCount": stream_count,
        "streams": streams,
    })
}

fn demangle_symbol(options: &serde_json::Value, envelope: &mut Envelope) -> serde_json::Value {
    let symbol = options
        .get("symbol")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    if symbol.is_empty() {
        envelope.warnings.push("symbol is required".into());
        return serde_json::json!({ "input": "", "output": "" });
    }
    if let Ok(demangled) = rustc_demangle::try_demangle(symbol) {
        return serde_json::json!({ "input": clean(symbol), "language": "rust", "output": clean(&demangled.to_string()) });
    }
    match cpp_demangle::Symbol::new(symbol) {
        Ok(parsed) => {
            serde_json::json!({ "input": clean(symbol), "language": "c++", "output": clean(&parsed.to_string()) })
        }
        Err(_) => {
            serde_json::json!({ "input": clean(symbol), "language": "unknown", "output": clean(symbol) })
        }
    }
}

fn parse_dotnet(bytes: &[u8], envelope: &mut Envelope) -> serde_json::Value {
    match Object::parse(bytes) {
        Ok(Object::PE(binary)) => {
            let clr = binary
                .clr_data
                .as_ref()
                .map(|runtime| {
                    serde_json::json!({
                        "valid": runtime.is_valid(),
                        "signature": format!("0x{:x}", runtime.signature),
                        "metadataBytes": runtime.metadata_data.len(),
                    })
                })
                .unwrap_or(serde_json::Value::Null);
            if clr.is_null() {
                envelope.warnings.push("no CLR runtime directory".into());
            }
            serde_json::json!({
                "isDotnet": !clr.is_null(),
                "clr": clr,
                "imports": binary.imports.iter().take(64).map(|item| clean(&item.name)).collect::<Vec<_>>(),
            })
        }
        Ok(_) => {
            envelope
                .warnings
                .push(".NET metadata is implemented for PE only".into());
            serde_json::json!({ "isDotnet": false })
        }
        Err(error) => {
            envelope.warnings.push(clean(&error.to_string()));
            serde_json::json!({ "isDotnet": false })
        }
    }
}

fn inspect_overlay(bytes: &[u8], envelope: &mut Envelope) -> serde_json::Value {
    match Object::parse(bytes) {
        Ok(Object::PE(binary)) => {
            let end = binary
                .sections
                .iter()
                .map(|section| {
                    section
                        .pointer_to_raw_data
                        .saturating_add(section.size_of_raw_data) as usize
                })
                .max()
                .unwrap_or(0)
                .min(bytes.len());
            let overlay = if end < bytes.len() {
                &bytes[end..]
            } else {
                &[]
            };
            serde_json::json!({
                "format": "pe",
                "overlayOffset": end,
                "overlaySize": overlay.len(),
                "overlayEntropy": if overlay.is_empty() { 0.0 } else { shannon(overlay) },
                "previewHex": hex::encode(&overlay[..overlay.len().min(MAX_OVERLAY_PREVIEW)]),
            })
        }
        Ok(Object::Elf(binary)) => inspect_elf_overlay(bytes, &binary),
        Ok(_) => {
            envelope
                .warnings
                .push("overlay inspection is implemented for PE and ELF".into());
            serde_json::json!({ "format": "unsupported", "overlaySize": 0 })
        }
        Err(error) => {
            envelope.warnings.push(clean(&error.to_string()));
            serde_json::json!({ "format": "unknown", "overlaySize": 0 })
        }
    }
}

fn inspect_elf_overlay(bytes: &[u8], binary: &elf::Elf<'_>) -> serde_json::Value {
    let end = binary
        .section_headers
        .iter()
        .map(|header| header.sh_offset.saturating_add(header.sh_size) as usize)
        .max()
        .unwrap_or(0)
        .min(bytes.len());
    let overlay = if end < bytes.len() {
        &bytes[end..]
    } else {
        &[]
    };
    serde_json::json!({
        "format": "elf",
        "overlayOffset": end,
        "overlaySize": overlay.len(),
        "overlayEntropy": if overlay.is_empty() { 0.0 } else { shannon(overlay) },
        "previewHex": hex::encode(&overlay[..overlay.len().min(MAX_OVERLAY_PREVIEW)]),
    })
}

fn list_zip(bytes: &[u8], envelope: &mut Envelope) -> serde_json::Value {
    let cursor = Cursor::new(bytes);
    let mut archive = match ZipArchive::new(cursor) {
        Ok(archive) => archive,
        Err(error) => {
            envelope.warnings.push(clean(&error.to_string()));
            return serde_json::json!({ "format": "zip", "entries": [] });
        }
    };
    let mut entries = Vec::new();
    for index in 0..archive.len() {
        if entries.len() >= MAX_RESULTS {
            envelope.truncated = true;
            break;
        }
        match archive.by_index(index) {
            Ok(file) => entries.push(serde_json::json!({
                "index": index,
                "name": clean(file.name()),
                "size": file.size(),
                "compressedSize": file.compressed_size(),
                "encrypted": file.encrypted(),
                "directory": file.is_dir(),
            })),
            Err(error) => envelope.warnings.push(clean(&error.to_string())),
        }
    }
    serde_json::json!({ "format": "zip", "count": archive.len(), "entries": entries })
}

fn extract_zip(
    bytes: &[u8],
    index: usize,
    max_output: usize,
    envelope: &mut Envelope,
) -> serde_json::Value {
    let cursor = Cursor::new(bytes);
    let mut archive = match ZipArchive::new(cursor) {
        Ok(archive) => archive,
        Err(error) => {
            envelope.warnings.push(clean(&error.to_string()));
            return serde_json::json!({ "format": "zip" });
        }
    };
    let mut file = match archive.by_index(index) {
        Ok(file) => file,
        Err(error) => {
            envelope.warnings.push(clean(&error.to_string()));
            return serde_json::json!({ "format": "zip" });
        }
    };
    if file.size() > max_output as u64 {
        envelope
            .warnings
            .push("entry exceeds maxOutputBytes".into());
        return serde_json::json!({
            "format": "zip",
            "index": index,
            "name": clean(file.name()),
            "size": file.size(),
        });
    }
    let mut data = Vec::new();
    if let Err(error) = file.read_to_end(&mut data) {
        envelope.warnings.push(clean(&error.to_string()));
        return serde_json::json!({ "format": "zip", "index": index, "name": clean(file.name()) });
    }
    serde_json::json!({
        "format": "zip",
        "index": index,
        "name": clean(file.name()),
        "size": data.len(),
        "sha256": hex::encode(Sha256::digest(&data)),
        "bytesHex": hex::encode(&data[..data.len().min(MAX_OVERLAY_PREVIEW)]),
        "contentBase64": base64(&data),
    })
}

fn list_tar(bytes: &[u8], envelope: &mut Envelope) -> serde_json::Value {
    let mut archive = tar::Archive::new(Cursor::new(bytes));
    let mut entries = Vec::new();
    match archive.entries() {
        Ok(iter) => {
            for (index, entry) in iter.enumerate() {
                if entries.len() >= MAX_RESULTS {
                    envelope.truncated = true;
                    break;
                }
                match entry {
                    Ok(file) => entries.push(serde_json::json!({
                        "index": index,
                        "name": clean(&file.path().map(|path| path.display().to_string()).unwrap_or_default()),
                        "size": file.size(),
                        "directory": file.header().entry_type().is_dir(),
                    })),
                    Err(error) => envelope.warnings.push(clean(&error.to_string())),
                }
            }
        }
        Err(error) => envelope.warnings.push(clean(&error.to_string())),
    }
    serde_json::json!({ "format": "tar", "entries": entries })
}

fn extract_tar(
    bytes: &[u8],
    index: usize,
    max_output: usize,
    envelope: &mut Envelope,
) -> serde_json::Value {
    let mut archive = tar::Archive::new(Cursor::new(bytes));
    let Ok(iter) = archive.entries() else {
        envelope
            .warnings
            .push("unable to iterate tar entries".into());
        return serde_json::json!({ "format": "tar" });
    };
    for (current, entry) in iter.enumerate() {
        let Ok(mut file) = entry else { continue };
        if current != index {
            continue;
        }
        if file.size() > max_output as u64 {
            envelope
                .warnings
                .push("entry exceeds maxOutputBytes".into());
            return serde_json::json!({
                "format": "tar",
                "index": index,
                "name": clean(&file.path().map(|path| path.display().to_string()).unwrap_or_default()),
                "size": file.size(),
            });
        }
        let mut data = Vec::new();
        if let Err(error) = file.read_to_end(&mut data) {
            envelope.warnings.push(clean(&error.to_string()));
            return serde_json::json!({ "format": "tar", "index": index });
        }
        return serde_json::json!({
            "format": "tar",
            "index": index,
            "name": clean(&file.path().map(|path| path.display().to_string()).unwrap_or_default()),
            "size": data.len(),
            "sha256": hex::encode(Sha256::digest(&data)),
            "bytesHex": hex::encode(&data[..data.len().min(MAX_OVERLAY_PREVIEW)]),
            "contentBase64": base64(&data),
        });
    }
    envelope.warnings.push("tar entry index not found".into());
    serde_json::json!({ "format": "tar", "index": index })
}

fn summarize_plist(
    value: &plist::Value,
    depth: usize,
    envelope: &mut Envelope,
) -> serde_json::Value {
    if depth > 6 {
        envelope.truncated = true;
        return serde_json::json!("[truncated]");
    }
    match value {
        plist::Value::String(text) => serde_json::Value::String(clean(text)),
        plist::Value::Boolean(flag) => serde_json::Value::Bool(*flag),
        plist::Value::Real(number) => serde_json::json!(number),
        plist::Value::Integer(number) => serde_json::json!(number.to_string()),
        plist::Value::Data(data) => {
            serde_json::json!({ "dataHex": hex::encode(&data[..data.len().min(64)]) })
        }
        plist::Value::Date(date) => serde_json::Value::String(clean(&date.to_xml_format())),
        plist::Value::Uid(uid) => serde_json::json!({ "uid": uid.get() }),
        plist::Value::Array(items) => {
            let selected: Vec<_> = items
                .iter()
                .take(64)
                .map(|item| summarize_plist(item, depth + 1, envelope))
                .collect();
            if items.len() > 64 {
                envelope.truncated = true;
            }
            serde_json::Value::Array(selected)
        }
        plist::Value::Dictionary(map) => {
            let mut object = serde_json::Map::new();
            for (index, (key, item)) in map.iter().enumerate() {
                if index >= 64 {
                    envelope.truncated = true;
                    break;
                }
                object.insert(clean(key), summarize_plist(item, depth + 1, envelope));
            }
            serde_json::Value::Object(object)
        }
        _ => serde_json::json!("[unsupported]"),
    }
}

fn embedded_at(bytes: &[u8], index: usize) -> Option<(&'static str, usize)> {
    let rest = &bytes[index..];
    if rest.starts_with(&[0x7f, b'E', b'L', b'F']) {
        return Some(("elf", rest.len().min(4096)));
    }
    if rest.starts_with(b"MZ") {
        return Some(("pe", rest.len().min(4096)));
    }
    if rest.starts_with(b"PK\x03\x04") {
        return Some(("zip", rest.len().min(4096)));
    }
    if rest.starts_with(b"%PDF") {
        return Some(("pdf", rest.len().min(4096)));
    }
    if rest.starts_with(&[0x1f, 0x8b]) {
        return Some(("gzip", rest.len().min(4096)));
    }
    if rest.starts_with(b"\x89PNG") {
        return Some(("png", rest.len().min(4096)));
    }
    if rest.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some(("jpeg", rest.len().min(4096)));
    }
    if rest.starts_with(b"Rar!") {
        return Some(("rar", rest.len().min(4096)));
    }
    if rest.starts_with(b"7z\xbc\xaf\x27\x1c") {
        return Some(("7z", rest.len().min(4096)));
    }
    None
}

fn looks_like_tar(bytes: &[u8]) -> bool {
    bytes.len() >= 512 && bytes[257..262] == *b"ustar"
}

fn magic_label(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x7f, b'E', b'L', b'F']) {
        "elf"
    } else if bytes.starts_with(b"MZ") {
        "pe"
    } else if bytes.starts_with(b"%PDF") {
        "pdf"
    } else if bytes.starts_with(b"PK") {
        "zip"
    } else if bytes.starts_with(b"\x89PNG") {
        "png"
    } else if bytes.len() >= 8 && bytes[0..4] == [0x4c, 0, 0, 0] {
        "lnk"
    } else if bytes.starts_with(b"MDMP") {
        "minidump"
    } else {
        "unknown"
    }
}

fn shannon(bytes: &[u8]) -> f64 {
    if bytes.is_empty() {
        return 0.0;
    }
    let mut counts = [0u64; 256];
    for byte in bytes {
        counts[*byte as usize] += 1;
    }
    let length = bytes.len() as f64;
    counts.iter().fold(0.0, |entropy, count| {
        if *count == 0 {
            entropy
        } else {
            let probability = *count as f64 / length;
            entropy - probability * probability.log2()
        }
    })
}

fn count_token(text: &str, token: &str) -> usize {
    text.matches(token).count().min(MAX_RESULTS)
}

fn extract_ascii(bytes: &[u8], offset: usize, max: usize) -> String {
    if offset >= bytes.len() {
        return String::new();
    }
    let end = (offset + max).min(bytes.len());
    let slice = bytes[offset..end]
        .iter()
        .take_while(|byte| **byte != 0)
        .copied()
        .collect::<Vec<_>>();
    clean(&String::from_utf8_lossy(&slice))
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::new();
    for chunk in bytes.chunks(3) {
        let a = chunk[0] as usize;
        let b = chunk.get(1).copied().unwrap_or(0) as usize;
        let c = chunk.get(2).copied().unwrap_or(0) as usize;
        output.push(TABLE[a >> 2] as char);
        output.push(TABLE[((a & 3) << 4) | (b >> 4)] as char);
        if chunk.len() > 1 {
            output.push(TABLE[((b & 15) << 2) | (c >> 6)] as char);
        } else {
            output.push('=');
        }
        if chunk.len() > 2 {
            output.push(TABLE[c & 63] as char);
        } else {
            output.push('=');
        }
    }
    output
}

fn clean(value: &str) -> String {
    value.chars().take(MAX_STRING_BYTES).collect()
}
