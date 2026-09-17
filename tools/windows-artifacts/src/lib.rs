use serde::Serialize;
use std::io::Cursor;
use wasm_bindgen::prelude::*;

const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_RESULTS: usize = 4096;
const FILETIME_UNIX_DELTA: i64 = 11_644_473_600;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    schema_version: u8,
    truncated: bool,
    warnings: Vec<String>,
    result: serde_json::Value,
}

#[wasm_bindgen]
pub fn analyze(bytes: &[u8], options_json: &str) -> Result<String, JsError> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(JsError::new(&format!("input size {} exceeds limit {}", bytes.len(), MAX_INPUT_BYTES)));
    }
    let options: serde_json::Value = if options_json.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(options_json).map_err(|error| JsError::new(&error.to_string()))?
    };
    let mut envelope = Envelope {
        schema_version: 1,
        truncated: false,
        warnings: Vec::new(),
        result: serde_json::Value::Null,
    };
    envelope.result = parse_artifact(bytes, &options, &mut envelope);
    let json = serde_json::to_string(&envelope).map_err(|error| JsError::new(&error.to_string()))?;
    if json.len() > MAX_OUTPUT_BYTES {
        return Err(JsError::new(&format!("serialized output size {} exceeds limit {}", json.len(), MAX_OUTPUT_BYTES)));
    }
    Ok(json)
}

fn parse_artifact(bytes: &[u8], options: &serde_json::Value, envelope: &mut Envelope) -> serde_json::Value {
    let max_results = options.get("maxResults").and_then(serde_json::Value::as_u64).unwrap_or(256).min(MAX_RESULTS as u64) as usize;
    let kind = detect_kind(bytes, options.get("kind").and_then(serde_json::Value::as_str));
    match kind.as_str() {
        "prefetch" => parse_prefetch(bytes, max_results, envelope),
        "evtx" => parse_evtx(bytes, max_results, envelope),
        "mft" => parse_mft(bytes, max_results, envelope),
        "amcache" => parse_amcache(bytes, max_results, envelope),
        "lnk" => parse_lnk(bytes, envelope),
        "jumplist" => parse_jumplist(bytes, options, envelope),
        "hive" => parse_hive(bytes, max_results, envelope),
        _ => {
            envelope.warnings.push("unrecognized Windows artifact".into());
            serde_json::json!({ "kind": "unknown" })
        }
    }
}

fn detect_kind(bytes: &[u8], requested: Option<&str>) -> String {
    if let Some(kind) = requested {
        if kind != "auto" {
            return kind.to_string();
        }
    }
    if bytes.starts_with(b"MAM\x04") || bytes.starts_with(b"SCCA") {
        return "prefetch".into();
    }
    if bytes.starts_with(b"ElfFile\0") {
        return "evtx".into();
    }
    if bytes.starts_with(b"FILE") {
        return "mft".into();
    }
    if bytes.starts_with(b"regf") {
        return "hive".into();
    }
    if bytes.len() >= 20 && bytes[0..4] == [0x4c, 0x00, 0x00, 0x00] {
        return "lnk".into();
    }
    if bytes.starts_with(&[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) {
        return "jumplist".into();
    }
    "unknown".into()
}

fn parse_prefetch(bytes: &[u8], max_results: usize, envelope: &mut Envelope) -> serde_json::Value {
    match prefetch_core::parse(bytes) {
        Ok(info) => {
            let total = info.filenames.len();
            let filenames: Vec<_> = info.filenames.into_iter().take(max_results).collect();
            if total > filenames.len() {
                envelope.truncated = true;
            }
            serde_json::json!({
                "kind": "prefetch",
                "executable": info.executable,
                "runCount": info.run_count,
                "lastRunTimes": info.last_run_times.iter().filter_map(|value| filetime_unix(*value)).collect::<Vec<_>>(),
                "filenames": filenames,
            })
        }
        Err(error) => {
            envelope.warnings.push(format!("{error:?}"));
            serde_json::json!({ "kind": "prefetch" })
        }
    }
}

fn parse_evtx(bytes: &[u8], max_results: usize, envelope: &mut Envelope) -> serde_json::Value {
    let mut parser = match evtx::EvtxParser::from_buffer(bytes.to_vec()) {
        Ok(parser) => parser,
        Err(error) => {
            envelope.warnings.push(error.to_string());
            return serde_json::json!({ "kind": "evtx", "records": [] });
        }
    };
    let mut records = Vec::new();
    for record in parser.records_json_value() {
        if records.len() >= max_results {
            envelope.truncated = true;
            break;
        }
        match record {
            Ok(item) => records.push(serde_json::json!({
                "eventRecordId": item.event_record_id,
                "timestamp": item.timestamp.to_string(),
                "data": item.data,
            })),
            Err(error) => envelope.warnings.push(error.to_string()),
        }
    }
    serde_json::json!({ "kind": "evtx", "count": records.len(), "records": records })
}

fn parse_mft(bytes: &[u8], max_results: usize, envelope: &mut Envelope) -> serde_json::Value {
    if bytes.len() < 1024 || !bytes.starts_with(b"FILE") {
        envelope.warnings.push("input is not an NTFS MFT record stream".into());
        return serde_json::json!({ "kind": "mft", "entries": [] });
    }
    let mut parser = match mft::MftParser::from_buffer(bytes.to_vec()) {
        Ok(parser) => parser,
        Err(error) => {
            envelope.warnings.push(error.to_string());
            return serde_json::json!({ "kind": "mft", "entries": [] });
        }
    };
    let mut entries = Vec::new();
    for entry in parser.iter_entries() {
        if entries.len() >= max_results {
            envelope.truncated = true;
            break;
        }
        match entry {
            Ok(item) => {
                let name = item.find_best_name_attribute().map(|attr| attr.name);
                entries.push(serde_json::json!({
                    "recordNumber": item.header.record_number,
                    "sequence": item.header.sequence,
                    "name": name,
                }));
            }
            Err(error) => envelope.warnings.push(error.to_string()),
        }
    }
    serde_json::json!({ "kind": "mft", "count": entries.len(), "entries": entries })
}

fn parse_amcache(bytes: &[u8], max_results: usize, envelope: &mut Envelope) -> serde_json::Value {
    match amcache_core::parse_bytes(bytes) {
        Ok(amcache) => {
            let total = amcache.file_entries.len();
            let files: Vec<_> = amcache
                .file_entries
                .into_iter()
                .take(max_results)
                .map(|item| {
                    serde_json::json!({
                        "name": item.name,
                        "fullPath": item.full_path,
                        "sha1": item.sha1,
                        "publisher": item.publisher,
                        "size": item.size,
                    })
                })
                .collect();
            if total > files.len() {
                envelope.truncated = true;
            }
            serde_json::json!({ "kind": "amcache", "count": files.len(), "files": files })
        }
        Err(error) => {
            envelope.warnings.push(error.to_string());
            serde_json::json!({ "kind": "amcache", "files": [] })
        }
    }
}

fn parse_lnk(bytes: &[u8], envelope: &mut Envelope) -> serde_json::Value {
    match lnk_core::parse_shell_link(bytes) {
        Some(link) => serde_json::json!({
            "kind": "lnk",
            "path": link.link_info.as_ref().and_then(|info| info.local_base_path.clone()),
            "name": link.string_data.name.clone(),
            "arguments": link.string_data.arguments.clone(),
            "workingDir": link.string_data.working_dir.clone(),
            "created": unix_or_none(link.header.creation_time),
            "accessed": unix_or_none(link.header.access_time),
            "written": unix_or_none(link.header.write_time),
            "machineId": link.tracker.as_ref().map(|tracker| tracker.machine_id.clone()),
        }),
        None => {
            envelope.warnings.push("input is not a valid Shell Link".into());
            serde_json::json!({ "kind": "lnk" })
        }
    }
}

fn parse_jumplist(bytes: &[u8], options: &serde_json::Value, envelope: &mut Envelope) -> serde_json::Value {
    let kind = options.get("jumplistKind").and_then(serde_json::Value::as_str).unwrap_or("automatic");
    let jumplist_type = if kind == "custom" {
        jumplist_parser::JumplistType::Custom
    } else {
        jumplist_parser::JumplistType::Automatic
    };
    let mut cursor = Cursor::new(bytes.to_vec());
    match jumplist_parser::JumplistParser::from_reader(&mut cursor, jumplist_type) {
        Ok(parsed) => serde_json::json!({ "kind": "jumplist", "appId": parsed.app_id, "appName": parsed.app_name, "data": parsed.data }),
        Err(error) => {
            envelope.warnings.push(error.to_string());
            serde_json::json!({ "kind": "jumplist" })
        }
    }
}

fn parse_hive(bytes: &[u8], max_results: usize, envelope: &mut Envelope) -> serde_json::Value {
    match winreg_core::hive::Hive::from_bytes(bytes.to_vec()) {
        Ok(hive) => {
            let mut keys = Vec::new();
            match winreg_core::iter::BfsIter::new(&hive) {
                Ok(iter) => {
                    for item in iter {
                        if keys.len() >= max_results {
                            envelope.truncated = true;
                            break;
                        }
                        match item {
                            Ok(key) => keys.push(serde_json::json!({
                                "name": key.name(),
                                "subkeyCount": key.subkey_count(),
                                "valueCount": key.value_count(),
                                "lastWritten": filetime_unix(key.last_written_raw() as i64),
                            })),
                            Err(error) => envelope.warnings.push(error.to_string()),
                        }
                    }
                }
                Err(error) => envelope.warnings.push(error.to_string()),
            }
            serde_json::json!({
                "kind": "hive",
                "fileName": hive.file_name(),
                "clean": hive.is_clean(),
                "count": keys.len(),
                "keys": keys,
            })
        }
        Err(error) => {
            envelope.warnings.push(error.to_string());
            serde_json::json!({ "kind": "hive", "keys": [] })
        }
    }
}

fn filetime_unix(value: i64) -> Option<i64> {
    if value <= 0 {
        return None;
    }
    Some((value / 10_000_000) - FILETIME_UNIX_DELTA)
}

fn unix_or_none(value: i64) -> Option<i64> {
    if value == 0 { None } else { Some(value) }
}
