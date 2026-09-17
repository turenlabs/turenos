//! Bounded Chromium LevelDB write-log (`.log`) parsing, hand-rolled from
//! `doc/log_format.md`: 32 KiB blocks of physical records
//! `{crc32, length, type, data}` where the checksum is the masked CRC-32C
//! of `type ++ data`, FULL/FIRST/MIDDLE/LAST fragments reassembled into
//! logical records, and each logical record decoded as a WriteBatch
//! (`sequence fixed64, count fixed32, then count tagged entries`).
//! Corruption follows LevelDB reader semantics — the bad record and the
//! remainder of its block are reported and skipped, never fatal.

use serde::Deserialize;

use crate::{
    clamp_limit, leveldb_record_crc, preview, u16_le, u32_le, u64_le, varint32, Envelope,
    Fail, DEFAULT_RESULTS, LEVELDB_BLOCK_SIZE, MAX_LOGICAL_RECORD, MAX_RESULTS,
};

#[derive(Deserialize, Default)]
pub(crate) struct LogOptions {
    pub(crate) max_results: Option<u64>,
    pub(crate) verify_crc: Option<bool>,
}

// Physical record types (leveldb log_format).
const TYPE_ZERO: u8 = 0; // preallocated/padding region
const TYPE_FULL: u8 = 1;
const TYPE_FIRST: u8 = 2;
const TYPE_MIDDLE: u8 = 3;
const TYPE_LAST: u8 = 4;

// WriteBatch entry tags (leveldb dbformat).
const TAG_DELETION: u8 = 0;
const TAG_VALUE: u8 = 1;

const HEADER_SIZE: usize = 7;

/// Cheap probe used by `analyze`: the first physical record must be a
/// well-formed FULL/FIRST/MIDDLE/LAST header whose masked CRC-32C verifies.
pub(crate) fn probe_log(bytes: &[u8]) -> bool {
    if bytes.len() < HEADER_SIZE {
        return false;
    }
    let Some(length) = u16_le(bytes, 4) else {
        return false;
    };
    let rtype = bytes[6];
    if !(TYPE_FULL..=TYPE_LAST).contains(&rtype) {
        return false;
    }
    let end = HEADER_SIZE + length as usize;
    if end > bytes.len() || end > LEVELDB_BLOCK_SIZE {
        return false;
    }
    let Some(stored) = u32_le(bytes, 0) else {
        return false;
    };
    leveldb_record_crc(rtype, &bytes[HEADER_SIZE..end]) == stored
}

struct Stats {
    physical_records: u64,
    logical_records: u64,
    write_batches: u64,
    batch_entries: u64,
    unparsed_records: u64,
    corrupt_records: u64,
    crc_failures: u64,
    dropped_bytes: u64,
    padding_bytes: u64,
    record_index: u64,
}

pub(crate) fn run(
    bytes: &[u8],
    options: &LogOptions,
    envelope: &mut Envelope,
) -> Result<serde_json::Value, Fail> {
    let max_results = clamp_limit(options.max_results, DEFAULT_RESULTS, MAX_RESULTS);
    let verify_crc = options.verify_crc.unwrap_or(true);

    let mut stats = Stats {
        physical_records: 0,
        logical_records: 0,
        write_batches: 0,
        batch_entries: 0,
        unparsed_records: 0,
        corrupt_records: 0,
        crc_failures: 0,
        dropped_bytes: 0,
        padding_bytes: 0,
        record_index: 0,
    };
    let mut records: Vec<serde_json::Value> = Vec::new();
    // Reassembly buffer for FIRST/MIDDLE/LAST fragmentation.
    let mut scratch: Vec<u8> = Vec::new();
    let mut scratch_offset: u64 = 0;
    let mut fragmented = false;

    for (block_index, block) in bytes.chunks(LEVELDB_BLOCK_SIZE).enumerate() {
        let block_base = block_index * LEVELDB_BLOCK_SIZE;
        let mut pos = 0usize;
        while pos + HEADER_SIZE <= block.len() {
            let stored_crc = u32_le(block, pos).unwrap_or(0);
            let length = u16_le(block, pos + 4).unwrap_or(0) as usize;
            let rtype = block[pos + 6];

            if stored_crc == 0 && length == 0 && rtype == TYPE_ZERO {
                // Zeroed header: leveldb leaves preallocated regions
                // zeroed; the rest of the block is padding.
                stats.padding_bytes += (block.len() - pos) as u64;
                if block[pos..].iter().any(|b| *b != 0) {
                    envelope.warn(format!(
                        "block {block_index}: nonzero data after padding header at {block_base}+{pos:#x}"
                    ));
                }
                pos = block.len();
                break;
            }

            let data_end = pos + HEADER_SIZE + length;
            if data_end > block.len() || rtype > TYPE_LAST {
                let reason = if data_end > block.len() {
                    format!("length {length} overruns block")
                } else {
                    format!("unknown type {rtype}")
                };
                stats.corrupt_records += 1;
                stats.dropped_bytes += (block.len() - pos) as u64;
                envelope.warn(format!(
                    "block {block_index}: corrupt record at file offset {} ({reason}); skipped rest of block",
                    block_base + pos
                ));
                if fragmented {
                    envelope.warn("partial fragmented record dropped".to_string());
                    scratch.clear();
                    fragmented = false;
                }
                pos = block.len();
                break;
            }

            let data = &block[pos + HEADER_SIZE..data_end];
            if verify_crc && leveldb_record_crc(rtype, data) != stored_crc {
                stats.crc_failures += 1;
                stats.corrupt_records += 1;
                stats.dropped_bytes += (block.len() - pos) as u64;
                envelope.warn(format!(
                    "block {block_index}: crc32c mismatch at file offset {}; skipped rest of block",
                    block_base + pos
                ));
                if fragmented {
                    envelope.warn("partial fragmented record dropped".to_string());
                    scratch.clear();
                    fragmented = false;
                }
                pos = block.len();
                break;
            }
            stats.physical_records += 1;

            match rtype {
                TYPE_FULL => {
                    if fragmented {
                        envelope.warn(format!(
                            "FULL record at {} superseded an unfinished fragmented record",
                            block_base + pos
                        ));
                        scratch.clear();
                        fragmented = false;
                    }
                    emit_logical(
                        data,
                        (block_base + pos) as u64,
                        &mut stats,
                        &mut records,
                        max_results,
                    );
                }
                TYPE_FIRST => {
                    if fragmented {
                        envelope.warn(format!(
                            "FIRST record at {} superseded an unfinished fragmented record",
                            block_base + pos
                        ));
                    }
                    scratch = data.to_vec();
                    scratch_offset = (block_base + pos) as u64;
                    fragmented = true;
                }
                TYPE_MIDDLE | TYPE_LAST => {
                    if !fragmented {
                        envelope.warn(format!(
                            "orphan {} fragment at {}; dropped",
                            if rtype == TYPE_MIDDLE { "MIDDLE" } else { "LAST" },
                            block_base + pos
                        ));
                    } else if scratch.len() + data.len() > MAX_LOGICAL_RECORD {
                        envelope.warn(format!(
                            "fragmented record at {scratch_offset} exceeds {MAX_LOGICAL_RECORD} bytes; dropped"
                        ));
                        scratch.clear();
                        fragmented = false;
                    } else {
                        scratch.extend_from_slice(data);
                        if rtype == TYPE_LAST {
                            let logical = std::mem::take(&mut scratch);
                            emit_logical(
                                &logical,
                                scratch_offset,
                                &mut stats,
                                &mut records,
                                max_results,
                            );
                            fragmented = false;
                        }
                    }
                }
                _ => {
                    // TYPE_ZERO with nonzero length/crc is not padding.
                    stats.corrupt_records += 1;
                    envelope.warn(format!(
                        "block {block_index}: zero-type record with data at {}",
                        block_base + pos
                    ));
                }
            }
            pos = data_end;
        }
        // Fewer than HEADER_SIZE bytes left: block trailer, must be zeros.
        let trailer = &block[pos.min(block.len())..];
        if !trailer.is_empty() && trailer.iter().any(|b| *b != 0) {
            envelope.warn(format!(
                "block {block_index}: {} nonzero trailer bytes at file offset {}",
                trailer.len(),
                block_base + pos
            ));
        }
    }
    if fragmented {
        envelope.warn("log ended mid-fragmented-record".to_string());
    }

    if stats.physical_records == 0 {
        return Err(Fail::new("not_leveldb_log"));
    }
    if stats.record_index > records.len() as u64 {
        envelope.truncated = true;
        envelope.warn(format!(
            "record list truncated at {} of {} emitted records",
            records.len(),
            stats.record_index
        ));
    }

    Ok(serde_json::json!({
        "kind": "leveldb_log",
        "block_size": LEVELDB_BLOCK_SIZE,
        "file_size": bytes.len(),
        "blocks": bytes.len().div_ceil(LEVELDB_BLOCK_SIZE),
        "verify_crc": verify_crc,
        "physical_records": stats.physical_records,
        "logical_records": stats.logical_records,
        "write_batches": stats.write_batches,
        "batch_entries": stats.batch_entries,
        "unparsed_records": stats.unparsed_records,
        "corrupt_records": stats.corrupt_records,
        "crc_failures": stats.crc_failures,
        "dropped_bytes": stats.dropped_bytes,
        "padding_bytes": stats.padding_bytes,
        "record_count": stats.record_index,
        "records_returned": records.len(),
        "records": records,
    }))
}

/// Decode one reassembled logical record as a WriteBatch and emit one row
/// per batch entry; non-WriteBatch payloads emit a single `"unparsed"`
/// row (MANIFEST VersionEdits, meta-journal writes, etc.).
fn emit_logical(
    data: &[u8],
    log_offset: u64,
    stats: &mut Stats,
    records: &mut Vec<serde_json::Value>,
    max_results: usize,
) {
    stats.logical_records += 1;
    match decode_batch(data) {
        Some((sequence, entries)) => {
            stats.write_batches += 1;
            for (entry_index, entry) in entries.iter().enumerate() {
                stats.batch_entries += 1;
                stats.record_index += 1;
                if records.len() >= max_results {
                    continue;
                }
                records.push(serde_json::json!({
                    "index": stats.record_index - 1,
                    "log_offset": log_offset,
                    "batch_sequence": sequence,
                    "entry_index": entry_index,
                    "sequence": sequence + entry_index as u64,
                    "operation": entry.operation,
                    "key": preview(&entry.key),
                    "value": entry.value.as_ref().map(|v| preview(v)),
                }));
            }
        }
        None => {
            stats.unparsed_records += 1;
            stats.record_index += 1;
            if records.len() < max_results {
                records.push(serde_json::json!({
                    "index": stats.record_index - 1,
                    "log_offset": log_offset,
                    "batch_sequence": serde_json::Value::Null,
                    "entry_index": serde_json::Value::Null,
                    "sequence": serde_json::Value::Null,
                    "operation": "unparsed",
                    "key": serde_json::Value::Null,
                    "value": preview(data),
                    "reason": "not_write_batch",
                }));
            }
        }
    }
}

struct BatchEntry {
    operation: &'static str,
    key: Vec<u8>,
    value: Option<Vec<u8>>,
}

/// Strict WriteBatch decode: `sequence fixed64 ++ count fixed32 ++
/// count * (tag ++ fields)`, every byte consumed. Returns None when the
/// payload is not a well-formed batch (e.g. a MANIFEST VersionEdit).
fn decode_batch(data: &[u8]) -> Option<(u64, Vec<BatchEntry>)> {
    if data.len() < 12 {
        return None;
    }
    let sequence = u64_le(data, 0)?;
    let count = u32_le(data, 8)? as usize;
    let mut pos = 12usize;
    let mut entries = Vec::new();
    for _ in 0..count {
        let tag = *data.get(pos)?;
        pos += 1;
        match tag {
            TAG_VALUE => {
                let key = take_varint_bytes(data, &mut pos)?;
                let value = take_varint_bytes(data, &mut pos)?;
                entries.push(BatchEntry {
                    operation: "put",
                    key,
                    value: Some(value),
                });
            }
            TAG_DELETION => {
                let key = take_varint_bytes(data, &mut pos)?;
                entries.push(BatchEntry {
                    operation: "delete",
                    key,
                    value: None,
                });
            }
            _ => return None,
        }
    }
    if pos != data.len() {
        return None;
    }
    Some((sequence, entries))
}

fn take_varint_bytes(data: &[u8], pos: &mut usize) -> Option<Vec<u8>> {
    let len = varint32(data, pos)? as usize;
    let out = data.get(*pos..pos.checked_add(len)?)?.to_vec();
    *pos += len;
    Some(out)
}
