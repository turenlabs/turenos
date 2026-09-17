//! Bounded Chromium LevelDB table (`.ldb`/`.sst`) parsing, hand-rolled
//! from `doc/table_format.md`: a 48-byte footer carrying the metaindex and
//! index BlockHandles plus magic `0xdb4775248b80fb57`; blocks of
//! `{shared, non_shared, value_len} varint32` entries followed by a
//! restart array; 5-byte block trailers `{compression u8, crc32 u32}`
//! whose masked CRC-32C covers `contents ++ compression`. Snappy blocks
//! use the raw `snap` format with the declared length checked against the
//! decompression cap before allocation. Data-block keys are internal keys
//! (`user_key ++ (sequence << 8 | value_type) fixed64-le`): type 1 is a
//! put, type 0 a delete tombstone.

use serde::Deserialize;

use crate::{
    clamp_limit, mask_crc, preview, u32_le, u64_le, varint32, varint64, Envelope, Fail,
    DEFAULT_RESULTS, MAX_BLOCK_ENTRIES, MAX_DECOMPRESSED_BYTES, MAX_RESULTS, MAX_TABLE_BLOCKS,
};

#[derive(Deserialize, Default)]
pub(crate) struct TableOptions {
    pub(crate) max_results: Option<u64>,
    pub(crate) verify_crc: Option<bool>,
    pub(crate) include_index: Option<bool>,
}

const FOOTER_SIZE: usize = 48;
const BLOCK_TRAILER_SIZE: usize = 5;
const TABLE_MAGIC: u64 = 0xdb4775248b80fb57;
const INTERNAL_TRAILER: usize = 8;

const COMPRESSION_NONE: u8 = 0;
const COMPRESSION_SNAPPY: u8 = 1;

/// Footer magic probe used by `analyze`.
pub(crate) fn has_table_magic(bytes: &[u8]) -> bool {
    bytes.len() >= FOOTER_SIZE && u64_le(bytes, bytes.len() - 8) == Some(TABLE_MAGIC)
}

#[derive(Clone, Copy)]
struct BlockHandle {
    offset: u64,
    size: u64,
}

fn read_handle(data: &[u8], pos: &mut usize) -> Option<BlockHandle> {
    let offset = varint64(data, pos)?;
    let size = varint64(data, pos)?;
    Some(BlockHandle { offset, size })
}

fn handle_slice<'a>(bytes: &'a [u8], handle: BlockHandle) -> Option<&'a [u8]> {
    let start = usize::try_from(handle.offset).ok()?;
    let size = usize::try_from(handle.size).ok()?;
    bytes.get(start..start.checked_add(size)?)
}

struct BlockData {
    /// Decoded block contents (owned when decompressed).
    contents: Vec<u8>,
    compression: u8,
    crc_valid: Option<bool>,
}

/// Read one block: bounds-checked slice, trailer decode, optional CRC-32C
/// verification, snappy decompression under the declared-length cap.
fn read_block(
    bytes: &[u8],
    handle: BlockHandle,
    verify_crc: bool,
    block_label: &str,
    envelope: &mut Envelope,
) -> Option<BlockData> {
    let raw = handle_slice(bytes, handle)?;
    let offset = usize::try_from(handle.offset).ok()?;
    let trailer = bytes.get(offset + raw.len()..offset + raw.len() + BLOCK_TRAILER_SIZE)?;
    let compression = trailer[0];
    let stored_crc = u32_le(trailer, 1).unwrap_or(0);
    let computed = mask_crc(crc32c::crc32c_append(
        crc32c::crc32c(raw),
        &[compression],
    ));
    let crc_valid = if verify_crc {
        let valid = computed == stored_crc;
        if !valid {
            envelope.warn(format!(
                "{block_label}: crc32c mismatch (stored {stored_crc:#010x}, computed {computed:#010x})"
            ));
        }
        Some(valid)
    } else {
        None
    };
    match compression {
        COMPRESSION_NONE => Some(BlockData {
            contents: raw.to_vec(),
            compression,
            crc_valid,
        }),
        COMPRESSION_SNAPPY => {
            let declared = match snap::raw::decompress_len(raw) {
                Ok(declared) => declared,
                Err(error) => {
                    envelope.warn(format!("{block_label}: bad snappy stream ({error})"));
                    return None;
                }
            };
            if declared > MAX_DECOMPRESSED_BYTES {
                envelope.warn(format!(
                    "{block_label}: snappy block declares {declared} bytes (cap {MAX_DECOMPRESSED_BYTES}); skipped"
                ));
                return None;
            }
            match snap::raw::Decoder::new().decompress_vec(raw) {
                Ok(contents) => Some(BlockData {
                    contents,
                    compression,
                    crc_valid,
                }),
                Err(error) => {
                    envelope.warn(format!("{block_label}: snappy decompression failed ({error})"));
                    None
                }
            }
        }
        other => {
            envelope.warn(format!("{block_label}: unknown compression type {other}; skipped"));
            None
        }
    }
}

struct BlockEntry {
    /// Offset of this entry inside the decoded block.
    offset: u64,
    key: Vec<u8>,
    value: Vec<u8>,
}

/// Decode one block's entry sequence and restart array. Returns the
/// entries plus the restart offsets; anomalies degrade to warnings.
fn decode_block(
    block: &[u8],
    block_label: &str,
    envelope: &mut Envelope,
) -> (Vec<BlockEntry>, Vec<u32>) {
    if block.len() < 4 {
        envelope.warn(format!("{block_label}: block too small for restart array"));
        return (Vec::new(), Vec::new());
    }
    let num_restarts = u32_le(block, block.len() - 4).unwrap_or(0) as usize;
    // Entries end where the restart array begins.
    let restarts_start = if num_restarts == 0 {
        envelope.warn(format!("{block_label}: restart array is empty"));
        block.len() - 4
    } else if num_restarts > block.len() / 4 {
        envelope.warn(format!(
            "{block_label}: restart count {num_restarts} exceeds block capacity"
        ));
        block.len() - 4
    } else {
        block.len() - 4 - 4 * num_restarts
    };
    let mut restarts = Vec::new();
    if num_restarts > 0 && num_restarts <= block.len() / 4 {
        for i in 0..num_restarts {
            let offset = u32_le(block, restarts_start + 4 * i).unwrap_or(0);
            if offset as usize >= restarts_start && !restarts.is_empty() {
                envelope.warn(format!(
                    "{block_label}: restart offset {offset} outside entries region"
                ));
                break;
            }
            restarts.push(offset);
        }
        if restarts.first() != Some(&0) {
            envelope.warn(format!("{block_label}: first restart offset is not 0"));
        }
    }

    let mut entries = Vec::new();
    let mut cursor = 0usize;
    let mut last_key: Vec<u8> = Vec::new();
    while cursor < restarts_start {
        if entries.len() >= MAX_BLOCK_ENTRIES {
            envelope.warn(format!(
                "{block_label}: entry count capped at {MAX_BLOCK_ENTRIES}"
            ));
            break;
        }
        let entry_offset = cursor;
        let (Some(shared), Some(non_shared), Some(value_len)) = (
            varint32(block, &mut cursor),
            varint32(block, &mut cursor),
            varint32(block, &mut cursor),
        ) else {
            envelope.warn(format!(
                "{block_label}: truncated entry header at +{entry_offset:#x}"
            ));
            break;
        };
        if shared as usize > last_key.len() {
            envelope.warn(format!(
                "{block_label}: shared prefix {shared} exceeds previous key {} at +{entry_offset:#x}",
                last_key.len()
            ));
            break;
        }
        let key_end = match cursor.checked_add(non_shared as usize) {
            Some(end) if end <= restarts_start => end,
            _ => {
                envelope.warn(format!(
                    "{block_label}: truncated key delta at +{entry_offset:#x}"
                ));
                break;
            }
        };
        let mut key = Vec::with_capacity(shared as usize + non_shared as usize);
        key.extend_from_slice(&last_key[..shared as usize]);
        key.extend_from_slice(&block[cursor..key_end]);
        cursor = key_end;
        let value_end = match cursor.checked_add(value_len as usize) {
            Some(end) if end <= restarts_start => end,
            _ => {
                envelope.warn(format!(
                    "{block_label}: truncated value at +{entry_offset:#x}"
                ));
                break;
            }
        };
        let value = block[cursor..value_end].to_vec();
        cursor = value_end;
        last_key = key.clone();
        entries.push(BlockEntry {
            offset: entry_offset as u64,
            key,
            value,
        });
    }
    (entries, restarts)
}

/// Decode an internal key (`user_key ++ trailer fixed64-le` where the
/// trailer is `sequence << 8 | value_type`). Returns the user-key slice
/// length, sequence, and operation name.
fn decode_internal_key(key: &[u8]) -> (usize, u64, &'static str) {
    if key.len() < INTERNAL_TRAILER {
        return (key.len(), 0, "unparsed");
    }
    let trailer = u64_le(key, key.len() - INTERNAL_TRAILER).unwrap_or(0);
    let sequence = trailer >> 8;
    let operation = match trailer & 0xff {
        0 => "delete",
        1 => "put",
        _ => "unparsed",
    };
    (key.len() - INTERNAL_TRAILER, sequence, operation)
}

fn internal_key_json(key: &[u8]) -> serde_json::Value {
    let (user_len, sequence, operation) = decode_internal_key(key);
    serde_json::json!({
        "user_key": preview(&key[..user_len]),
        "sequence": sequence,
        "operation": operation,
    })
}

struct Stats {
    index_entries: u64,
    data_blocks_walked: u64,
    blocks_failed: u64,
    crc_failures: u64,
    snappy_blocks: u64,
    uncompressed_blocks: u64,
    entries_total: u64,
    record_index: u64,
}

pub(crate) fn run(
    bytes: &[u8],
    options: &TableOptions,
    envelope: &mut Envelope,
) -> Result<serde_json::Value, Fail> {
    let max_results = clamp_limit(options.max_results, DEFAULT_RESULTS, MAX_RESULTS);
    let verify_crc = options.verify_crc.unwrap_or(true);
    let include_index = options.include_index.unwrap_or(false);

    if bytes.len() < FOOTER_SIZE {
        return Err(Fail::new("invalid_sstable").with("detail", "file smaller than footer"));
    }
    let footer = &bytes[bytes.len() - FOOTER_SIZE..];
    let mut pos = 0usize;
    let metaindex = read_handle(footer, &mut pos)
        .ok_or_else(|| Fail::new("invalid_sstable").with("detail", "bad metaindex handle"))?;
    let index = read_handle(footer, &mut pos)
        .ok_or_else(|| Fail::new("invalid_sstable").with("detail", "bad index handle"))?;
    if pos > 40 {
        return Err(Fail::new("invalid_sstable").with("detail", "footer handles overrun"));
    }
    if u64_le(footer, 40) != Some(TABLE_MAGIC) {
        return Err(Fail::new("invalid_sstable").with("detail", "bad footer magic"));
    }

    let mut stats = Stats {
        index_entries: 0,
        data_blocks_walked: 0,
        blocks_failed: 0,
        crc_failures: 0,
        snappy_blocks: 0,
        uncompressed_blocks: 0,
        entries_total: 0,
        record_index: 0,
    };
    let mut records: Vec<serde_json::Value> = Vec::new();
    let mut block_rows: Vec<serde_json::Value> = Vec::new();
    let mut blocks_walked: usize = 0;

    // --- metaindex block: report entry keys (filter policy names etc.) ---
    let mut metaindex_rows: Vec<serde_json::Value> = Vec::new();
    match read_block(
        bytes,
        metaindex,
        verify_crc,
        "metaindex block",
        envelope,
    ) {
        Some(block) => {
            blocks_walked += 1;
            if block.crc_valid == Some(false) {
                stats.crc_failures += 1;
            }
            let (entries, restarts) = decode_block(&block.contents, "metaindex block", envelope);
            for entry in &entries {
                let mut handle_pos = 0usize;
                let handle = read_handle(&entry.value, &mut handle_pos);
                metaindex_rows.push(serde_json::json!({
                    "key": preview(&entry.key),
                    "handle": handle.map(|h| serde_json::json!({"offset": h.offset, "size": h.size})),
                }));
            }
            block_rows.push(serde_json::json!({
                "role": "metaindex",
                "offset": metaindex.offset,
                "size": metaindex.size,
                "compression": block.compression,
                "crc_valid": block.crc_valid,
                "entries": entries.len(),
                "restarts": restarts.len(),
            }));
        }
        None => {
            stats.blocks_failed += 1;
            envelope.warn("metaindex block unreadable".to_string());
        }
    }

    // --- index block: handle entries point at data blocks ---
    let index_block = match read_block(bytes, index, verify_crc, "index block", envelope) {
        Some(block) => block,
        None => {
            return Err(
                Fail::new("invalid_sstable").with("detail", "index block unreadable")
            );
        }
    };
    blocks_walked += 1;
    if index_block.crc_valid == Some(false) {
        stats.crc_failures += 1;
    }
    let (index_entries, index_restarts) =
        decode_block(&index_block.contents, "index block", envelope);
    stats.index_entries = index_entries.len() as u64;
    block_rows.push(serde_json::json!({
        "role": "index",
        "offset": index.offset,
        "size": index.size,
        "compression": index_block.compression,
        "crc_valid": index_block.crc_valid,
        "entries": index_entries.len(),
        "restarts": index_restarts.len(),
    }));

    let mut index_rows: Vec<serde_json::Value> = Vec::new();
    for (entry_index, entry) in index_entries.iter().enumerate() {
        if include_index && index_rows.len() >= max_results {
            envelope.truncated = true;
        }
        if include_index && index_rows.len() < max_results {
            let mut handle_pos = 0usize;
            let handle = read_handle(&entry.value, &mut handle_pos);
            index_rows.push(serde_json::json!({
                "index": entry_index,
                "key": internal_key_json(&entry.key),
                "handle": handle.map(|h| serde_json::json!({"offset": h.offset, "size": h.size})),
            }));
        }
        let mut handle_pos = 0usize;
        let Some(handle) = read_handle(&entry.value, &mut handle_pos) else {
            envelope.warn(format!("index entry {entry_index}: bad block handle"));
            stats.blocks_failed += 1;
            continue;
        };
        if blocks_walked >= MAX_TABLE_BLOCKS {
            envelope.warn(format!("table block walk capped at {MAX_TABLE_BLOCKS}"));
            break;
        }
        let block = match read_block(
            bytes,
            handle,
            verify_crc,
            &format!("data block {entry_index}"),
            envelope,
        ) {
            Some(block) => block,
            None => {
                stats.blocks_failed += 1;
                continue;
            }
        };
        blocks_walked += 1;
        stats.data_blocks_walked += 1;
        if block.crc_valid == Some(false) {
            stats.crc_failures += 1;
        }
        match block.compression {
            COMPRESSION_SNAPPY => stats.snappy_blocks += 1,
            COMPRESSION_NONE => stats.uncompressed_blocks += 1,
            _ => {}
        }
        let (entries, restarts) =
            decode_block(&block.contents, &format!("data block {entry_index}"), envelope);
        stats.entries_total += entries.len() as u64;
        block_rows.push(serde_json::json!({
            "role": "data",
            "index_entry": entry_index,
            "offset": handle.offset,
            "size": handle.size,
            "compression": block.compression,
            "crc_valid": block.crc_valid,
            "decoded_size": block.contents.len(),
            "entries": entries.len(),
            "restarts": restarts.len(),
        }));
        for entry in &entries {
            stats.record_index += 1;
            if records.len() >= max_results {
                continue;
            }
            let (user_len, sequence, operation) = decode_internal_key(&entry.key);
            records.push(serde_json::json!({
                "index": stats.record_index - 1,
                "block": entry_index,
                "block_offset": handle.offset,
                "entry_offset": entry.offset,
                "sequence": sequence,
                "operation": operation,
                "key": preview(&entry.key[..user_len]),
                "value": preview(&entry.value),
            }));
        }
    }

    if stats.record_index > records.len() as u64 {
        envelope.truncated = true;
        envelope.warn(format!(
            "record list truncated at {} of {} emitted records",
            records.len(),
            stats.record_index
        ));
    }

    let mut result = serde_json::json!({
        "kind": "leveldb_table",
        "file_size": bytes.len(),
        "verify_crc": verify_crc,
        "footer": {
            "metaindex": { "offset": metaindex.offset, "size": metaindex.size },
            "index": { "offset": index.offset, "size": index.size },
            "magic": format!("0x{TABLE_MAGIC:016x}"),
        },
        "index_entry_count": stats.index_entries,
        "data_blocks_walked": stats.data_blocks_walked,
        "blocks_failed": stats.blocks_failed,
        "crc_failures": stats.crc_failures,
        "snappy_blocks": stats.snappy_blocks,
        "uncompressed_blocks": stats.uncompressed_blocks,
        "entry_count": stats.entries_total,
        "record_count": stats.record_index,
        "records_returned": records.len(),
        "records": records,
        "metaindex_entries": metaindex_rows,
        "blocks": block_rows,
    });
    if include_index {
        result["index_entries"] = serde_json::Value::Array(index_rows);
    }
    Ok(result)
}
