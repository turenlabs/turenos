//! Bounded `.tracev3` unified-log parsing via `macos-unifiedlogs`
//! (Mandiant, Apache-2.0). The crate is used strictly byte-to-bytes:
//! `parse_log` deconstructs the supplied file into header + catalogs +
//! chunksets, then `build_log` reconstructs entries against an empty
//! `FileProvider` — no uuidtext, shared-cache (dsc), or timesync files exist
//! in this module, so format-string resolution degrades to explicit
//! `<Missing message data>` markers and counted warnings. Nothing is
//! silently skipped.

use macos_unifiedlogs::dsc::SharedCacheStrings;
use macos_unifiedlogs::parser::{build_log, parse_log};
use macos_unifiedlogs::traits::{FileProvider, SourceFile};
use macos_unifiedlogs::unified_log::LogData;
use macos_unifiedlogs::uuidtext::UUIDText;
use serde::Deserialize;
use std::collections::HashMap;
use std::io::Error;
use std::io::ErrorKind;

use crate::{
    clean, clamp_limit, Envelope, Fail, MAX_RESULTS, MAX_STRING_CHARS, DEFAULT_RESULTS,
};

#[derive(Deserialize, Default)]
pub(crate) struct TraceOptions {
    pub(crate) max_results: Option<u64>,
}

/// A `FileProvider` that yields nothing: every external lookup fails
/// cleanly, which is what drives the crate's explicit missing-string path.
struct EmptyProvider;

impl FileProvider for EmptyProvider {
    fn tracev3_files(&self) -> Box<dyn Iterator<Item = Box<dyn SourceFile>>> {
        Box::new(std::iter::empty())
    }
    fn uuidtext_files(&self) -> Box<dyn Iterator<Item = Box<dyn SourceFile>>> {
        Box::new(std::iter::empty())
    }
    fn read_uuidtext(&self, _uuid: &str) -> Result<UUIDText, Error> {
        Err(Error::new(ErrorKind::NotFound, "byte-only provider"))
    }
    fn cached_uuidtext(&self, _uuid: &str) -> Option<&UUIDText> {
        None
    }
    fn update_uuid(&mut self, _uuid: &str, _uuid2: &str) {}
    fn dsc_files(&self) -> Box<dyn Iterator<Item = Box<dyn SourceFile>>> {
        Box::new(std::iter::empty())
    }
    fn read_dsc_uuid(&self, _uuid: &str) -> Result<SharedCacheStrings, Error> {
        Err(Error::new(ErrorKind::NotFound, "byte-only provider"))
    }
    fn cached_dsc(&self, _uuid: &str) -> Option<&SharedCacheStrings> {
        None
    }
    fn update_dsc(&mut self, _uuid: &str, _uuid2: &str) {}
    fn timesync_files(&self) -> Box<dyn Iterator<Item = Box<dyn SourceFile>>> {
        Box::new(std::iter::empty())
    }
}

/// tracev3 chunk preamble: tag u32, subtag u32, data size u64 (16 bytes).
const PREAMBLE: usize = 16;
const CHUNK_HEADER: u32 = 0x1000;
const CHUNK_CATALOG: u32 = 0x600b;
const CHUNK_CHUNKSET: u32 = 0x600d;
const KNOWN_CHUNKS: &[u32] = &[
    CHUNK_HEADER,
    CHUNK_CATALOG,
    CHUNK_CHUNKSET,
    0x6001,
    0x6002,
    0x6003,
    0x6004,
    0x6005,
    0x6006,
    0x6101,
];

/// A file plausibly starts a tracev3 stream when its first chunk preamble
/// carries a known tag.
pub(crate) fn looks_like_tracev3(bytes: &[u8]) -> bool {
    if bytes.len() < PREAMBLE {
        return false;
    }
    let tag = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    KNOWN_CHUNKS.contains(&tag)
}

/// Walk chunk preambles and return the longest prefix containing only
/// complete chunks. The crate fails the whole file when a trailing chunk is
/// truncated; feeding it the well-formed prefix keeps partial logs usable.
fn wellformed_prefix(bytes: &[u8]) -> (usize, bool) {
    let mut cursor = 0usize;
    let mut complete_any = false;
    loop {
        let remaining = bytes.len() - cursor;
        if remaining < PREAMBLE {
            return (cursor, remaining > 0 && complete_any);
        }
        let size = u64::from_le_bytes(
            bytes[cursor + 8..cursor + 16].try_into().unwrap_or_default(),
        );
        let chunk_total = match (size as usize).checked_add(PREAMBLE) {
            Some(total) => total,
            None => return (cursor, complete_any),
        };
        if chunk_total > remaining {
            return (cursor, complete_any);
        }
        complete_any = true;
        cursor += chunk_total;
        // Chunks are 8-byte aligned relative to the chunk data size.
        let padding = (8 - (size as usize % 8)) % 8;
        let left = bytes.len() - cursor;
        cursor += padding.min(left);
    }
}

pub(crate) fn run(
    bytes: &[u8],
    options: &TraceOptions,
    envelope: &mut Envelope,
) -> Result<serde_json::Value, Fail> {
    let max_results = clamp_limit(options.max_results, DEFAULT_RESULTS, MAX_RESULTS);

    let (prefix, truncated_tail) = wellformed_prefix(bytes);
    if truncated_tail {
        envelope.truncated = true;
        envelope.warn(format!(
            "tracev3 tail truncated: {} bytes after last complete chunk",
            bytes.len() - prefix
        ));
    }
    if prefix == 0 {
        return Err(Fail::new("invalid_tracev3"));
    }

    let unified = match parse_log(&bytes[..prefix], "wasm") {
        Ok(unified) => unified,
        Err(_) => return Err(Fail::new("invalid_tracev3")),
    };

    let header_json = unified.header.first().map(|header| {
        serde_json::json!({
            "mach_time_numerator": header.mach_time_numerator,
            "mach_time_denominator": header.mach_time_denominator,
            "continuous_time": header.continous_time,
            "bias_min": header.bias_min,
            "daylight_savings": header.daylight_savings == 1,
            "build_version": clean(header.build_version_string.trim_end_matches('\0'), 64),
            "hardware_model": clean(header.hardware_model_string.trim_end_matches('\0'), 64),
            "boot_uuid": header.boot_uuid,
            "logd_pid": header.logd_pid,
            "timezone_path": clean(header.timezone_path.trim_end_matches('\0'), 256),
        })
    });
    if unified.header.is_empty() {
        envelope.warn("no header chunk parsed".to_string());
    }

    let mut catalogs = Vec::new();
    let mut firehose_chunks: usize = 0;
    for catalog in &unified.catalog_data {
        firehose_chunks += catalog.firehose.len();
        catalogs.push(serde_json::json!({
            "process_entries": catalog.catalog.catalog_process_info_entries.len(),
            "uuids": catalog.catalog.catalog_uuids.len(),
            "subsystem_strings_bytes": catalog.catalog.catalog_subsystem_strings.len(),
            "subchunks": catalog.catalog.catalog_subchunks.len(),
            "firehose_chunks": catalog.firehose.len(),
            "oversize_chunks": catalog.oversize.len(),
            "statedump_chunks": catalog.statedump.len(),
            "simpledump_chunks": catalog.simpledump.len(),
        }));
    }

    let mut entries: Vec<serde_json::Value> = Vec::new();
    let mut total_entries: usize = 0;
    let mut missing_messages: usize = 0;
    let mut missing_chunks: usize = 0;

    if !unified.header.is_empty() {
        let mut provider = EmptyProvider;
        let timesync: HashMap<String, macos_unifiedlogs::timesync::TimesyncBoot> =
            HashMap::new();
        let (logs, missing) = build_log(&unified, &mut provider, &timesync, false);
        missing_chunks += missing
            .catalog_data
            .iter()
            .map(|catalog| catalog.firehose.len())
            .sum::<usize>();
        total_entries = logs.len();
        for entry in logs.into_iter().take(max_results) {
            if entry.message.contains("<Missing message data>")
                || entry.message.contains("Failed to get string message")
                || entry.raw_message.contains("Failed to get string message")
            {
                missing_messages += 1;
            }
            entries.push(entry_json(&entry));
        }
    } else {
        envelope.warn("log reconstruction skipped: missing header chunk".to_string());
    }

    if total_entries > entries.len() {
        envelope.truncated = true;
        envelope.warn(format!(
            "entries truncated at {} of {}",
            entries.len(),
            total_entries
        ));
    }
    if missing_messages > 0 {
        envelope.warn(format!(
            "{missing_messages} entries have unresolved format strings (uuidtext/dsc files not supplied)"
        ));
    }
    if missing_chunks > 0 {
        envelope.warn(format!(
            "{missing_chunks} firehose chunks reference data in other tracev3 files"
        ));
    }
    if unified.oversize.len() > 0 {
        envelope.warn(format!(
            "{} oversize string chunks retained",
            unified.oversize.len()
        ));
    }

    Ok(serde_json::json!({
        "kind": "unified_log",
        "header": header_json,
        "catalog_count": unified.catalog_data.len(),
        "catalogs": catalogs,
        "firehose_chunks": firehose_chunks,
        "entry_count": total_entries,
        "entries_returned": entries.len(),
        "missing_message_entries": missing_messages,
        "entries": entries,
    }))
}

fn entry_json(entry: &LogData) -> serde_json::Value {
    serde_json::json!({
        "timestamp": entry.timestamp,
        "continuous_time": entry.time,
        "process": clean(&entry.process, MAX_STRING_CHARS),
        "process_uuid": entry.process_uuid,
        "pid": entry.pid,
        "euid": entry.euid,
        "thread_id": entry.thread_id,
        "activity_id": entry.activity_id,
        "parent_activity_id": entry.parent_activity_id,
        "library": clean(&entry.library, MAX_STRING_CHARS),
        "library_uuid": entry.library_uuid,
        "subsystem": clean(&entry.subsystem, MAX_STRING_CHARS),
        "category": clean(&entry.category, MAX_STRING_CHARS),
        "event_type": entry.event_type,
        "log_type": entry.log_type,
        "message": clean(&entry.message, MAX_STRING_CHARS * 4),
        "raw_message": clean(&entry.raw_message, MAX_STRING_CHARS * 4),
        "boot_uuid": entry.boot_uuid,
        "timezone": entry.timezone_name,
        "message_flags": entry.message_flags,
    })
}
