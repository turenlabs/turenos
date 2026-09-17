//! Android sparse image (simg) parsing and expansion.
//!
//! The little-endian 28-byte header (magic 0xed26ff3a, version 1.0) describes
//! a block device image split into `total_blks` output blocks of `blk_sz`
//! bytes. Each chunk carries a 12-byte header — type, output block count,
//! and total on-disk size — followed by its payload:
//!
//! - `raw` (0xcac1): `blocks * blk_sz` payload bytes copied verbatim
//! - `fill` (0xcac2): a fill pattern (4 bytes in the AOSP writer; longer
//!   patterns tile cyclically) repeated across the output span
//! - `dont_care` (0xcac3): payload skipped; expands to 0x00 bytes
//! - `crc32` (0xcac4): 4-byte CRC32 of the expanded image, verified on expand
//!
//! `parse` reports the chunk table and expanded size without materializing
//! the image; `expand` produces it under the 128 MiB transform cap.

use serde_json::{json, Value};

use crate::{crc32::crc32, err, error_json, hex};

const SPARSE_MAGIC: u32 = 0xED26_FF3A;
const HEADER_LEN: usize = 28;
const CHUNK_HEADER_LEN: usize = 12;
const CHUNK_RAW: u16 = 0xCAC1;
const CHUNK_FILL: u16 = 0xCAC2;
const CHUNK_DONT_CARE: u16 = 0xCAC3;
const CHUNK_CRC32: u16 = 0xCAC4;

pub(crate) struct ParseOptions {
    /// Expand in memory to verify a CRC32 chunk when present (default true).
    pub verify_crc: bool,
    pub max_chunks: usize,
}

pub(crate) struct ExpandOptions {
    pub max_output_bytes: u64,
}

struct Head {
    major: u16,
    minor: u16,
    file_header_size: usize,
    chunk_header_size: usize,
    block_size: u64,
    total_blocks: u32,
    total_chunks: u32,
    image_checksum: u32,
}

struct ChunkInfo {
    index: u64,
    kind: u16,
    output_blocks: u32,
    output_bytes: u64,
    total_size: u32,
    data_offset: usize,
    data_len: usize,
}

#[derive(Default)]
struct WalkStats {
    chunks_seen: u64,
    output_blocks: u64,
    expanded_bytes: u64,
    crc_values: Vec<u32>,
    trailing_bytes: usize,
}

fn le16(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        bytes.get(offset..offset + 2)?.try_into().ok()?,
    ))
}

fn le32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn read_head(bytes: &[u8]) -> Result<Head, String> {
    if bytes.len() < HEADER_LEN {
        return Err(err(
            "truncated",
            format!("sparse header needs {HEADER_LEN} bytes, got {}", bytes.len()),
        ));
    }
    let magic = le32(bytes, 0).unwrap_or(0);
    if magic != SPARSE_MAGIC {
        return Err(err(
            "bad_magic",
            format!("magic 0x{magic:08x} is not 0xed26ff3a"),
        ));
    }
    let head = Head {
        major: le16(bytes, 4).unwrap_or(0),
        minor: le16(bytes, 6).unwrap_or(0),
        file_header_size: le16(bytes, 8).unwrap_or(0) as usize,
        chunk_header_size: le16(bytes, 10).unwrap_or(0) as usize,
        block_size: le32(bytes, 12).unwrap_or(0) as u64,
        total_blocks: le32(bytes, 16).unwrap_or(0),
        total_chunks: le32(bytes, 20).unwrap_or(0),
        image_checksum: le32(bytes, 24).unwrap_or(0),
    };
    if head.major != 1 {
        return Err(err(
            "unsupported_version",
            format!("sparse major version {} is not 1", head.major),
        ));
    }
    if head.file_header_size < HEADER_LEN {
        return Err(err(
            "malformed",
            format!("file header size {} < {HEADER_LEN}", head.file_header_size),
        ));
    }
    if head.file_header_size > bytes.len() {
        return Err(err(
            "truncated",
            format!(
                "file header size {} exceeds input {}",
                head.file_header_size,
                bytes.len()
            ),
        ));
    }
    if head.chunk_header_size < CHUNK_HEADER_LEN {
        return Err(err(
            "malformed",
            format!(
                "chunk header size {} < {CHUNK_HEADER_LEN}",
                head.chunk_header_size
            ),
        ));
    }
    if head.block_size == 0 {
        return Err(err("malformed", "block size is zero"));
    }
    Ok(head)
}

/// Walk `head.total_chunks` chunk records, invoking `f` on each validated
/// chunk. Returns aggregate statistics.
fn walk_chunks(
    bytes: &[u8],
    head: &Head,
    mut f: impl FnMut(&ChunkInfo) -> Result<(), String>,
) -> Result<WalkStats, String> {
    let mut stats = WalkStats::default();
    let mut pos = head.file_header_size;
    for index in 0..head.total_chunks as u64 {
        if pos + head.chunk_header_size > bytes.len() {
            return Err(err(
                "truncated",
                format!("chunk {index} header past end of input"),
            ));
        }
        let kind = le16(bytes, pos).unwrap_or(0);
        let output_blocks = le32(bytes, pos + 4).unwrap_or(0);
        let total_size = le32(bytes, pos + 8).unwrap_or(0);
        if (total_size as usize) < head.chunk_header_size {
            return Err(err(
                "malformed",
                format!("chunk {index} total size {total_size} < chunk header"),
            ));
        }
        let data_offset = pos + head.chunk_header_size;
        let data_len = total_size as usize - head.chunk_header_size;
        if data_offset + data_len > bytes.len() {
            return Err(err(
                "truncated",
                format!("chunk {index} payload past end of input"),
            ));
        }
        let output_bytes = output_blocks as u64 * head.block_size;
        let chunk = ChunkInfo {
            index,
            kind,
            output_blocks,
            output_bytes,
            total_size,
            data_offset,
            data_len,
        };
        match kind {
            CHUNK_RAW => {
                if data_len as u64 != output_bytes {
                    return Err(err(
                        "malformed",
                        format!(
                            "raw chunk {index} payload {data_len} != {output_bytes} output bytes"
                        ),
                    ));
                }
            }
            CHUNK_FILL => {
                if data_len < 4 {
                    return Err(err(
                        "malformed",
                        format!("fill chunk {index} payload {data_len} < 4 bytes"),
                    ));
                }
            }
            CHUNK_DONT_CARE => {}
            CHUNK_CRC32 => {
                if data_len != 4 {
                    return Err(err(
                        "malformed",
                        format!("crc32 chunk {index} payload {data_len} != 4 bytes"),
                    ));
                }
                stats
                    .crc_values
                    .push(le32(bytes, data_offset).unwrap_or(0));
            }
            other => {
                return Err(err(
                    "unknown_chunk",
                    format!("chunk {index} has unknown type 0x{other:04x}"),
                ));
            }
        }
        stats.chunks_seen += 1;
        stats.output_blocks += output_blocks as u64;
        stats.expanded_bytes += output_bytes;
        f(&chunk)?;
        pos += total_size as usize;
    }
    stats.trailing_bytes = bytes.len() - pos;
    Ok(stats)
}

fn chunk_type_name(kind: u16) -> &'static str {
    match kind {
        CHUNK_RAW => "raw",
        CHUNK_FILL => "fill",
        CHUNK_DONT_CARE => "dont_care",
        CHUNK_CRC32 => "crc32",
        _ => "unknown",
    }
}

/// Expand into a fresh vector; the caller has already bounded `expanded`.
/// The running cap is still enforced per chunk as defense in depth.
fn expand_inner(bytes: &[u8], head: &Head) -> Result<Vec<u8>, String> {
    let mut out: Vec<u8> = Vec::new();
    walk_chunks(bytes, &head, |chunk| {
        if out.len() as u64 + chunk.output_bytes > crate::MAX_TRANSFORM_BYTES {
            return Err(err("output_too_large", "expanded image exceeds cap"));
        }
        match chunk.kind {
            CHUNK_RAW => {
                out.extend_from_slice(&bytes[chunk.data_offset..chunk.data_offset + chunk.data_len]);
            }
            CHUNK_FILL => {
                let pattern = &bytes[chunk.data_offset..chunk.data_offset + chunk.data_len];
                let mut remaining = chunk.output_bytes;
                let mut at = 0usize;
                while remaining > 0 {
                    let take = (pattern.len() - at).min(remaining as usize);
                    out.extend_from_slice(&pattern[at..at + take]);
                    remaining -= take as u64;
                    at = (at + take) % pattern.len();
                }
            }
            CHUNK_DONT_CARE => {
                out.resize(out.len() + chunk.output_bytes as usize, 0);
            }
            _ => {}
        }
        Ok(())
    })?;
    Ok(out)
}

pub(crate) fn parse(bytes: &[u8], options: &ParseOptions) -> Result<Value, String> {
    let head = read_head(bytes)?;

    let mut chunks: Vec<Value> = Vec::new();
    let mut chunks_truncated = false;
    let mut fill_nonstandard = 0u64;
    let stats = walk_chunks(bytes, &head, |chunk| {
        if chunk.kind == CHUNK_FILL && chunk.data_len != 4 {
            fill_nonstandard += 1;
        }
        if chunks.len() < options.max_chunks {
            chunks.push(json!({
                "index": chunk.index,
                "type": chunk_type_name(chunk.kind),
                "chunk_type": chunk.kind,
                "output_blocks": chunk.output_blocks,
                "output_bytes": chunk.output_bytes.to_string(),
                "total_size": chunk.total_size,
                "data_size": chunk.data_len,
            }));
        } else {
            chunks_truncated = true;
        }
        Ok(())
    })?;

    let mut warnings: Vec<String> = Vec::new();
    if stats.output_blocks != head.total_blocks as u64 {
        warnings.push(format!(
            "block_count_mismatch: header {} vs chunks {}",
            head.total_blocks, stats.output_blocks
        ));
    }
    if chunks_truncated {
        warnings.push("chunk_list_truncated".into());
    }
    if stats.trailing_bytes > 0 {
        warnings.push(format!("trailing_bytes:{}", stats.trailing_bytes));
    }
    if fill_nonstandard > 0 {
        warnings.push(format!("nonstandard_fill_chunks:{fill_nonstandard}"));
    }
    if head.minor != 0 {
        warnings.push(format!("unusual_minor_version:{}", head.minor));
    }

    // Verify a CRC32 chunk by expanding in memory when the image fits the
    // transform cap; skipped verification is reported, never assumed.
    let (crc_stored, crc_valid) = match stats.crc_values.last() {
        None => (None, None),
        Some(&stored) => {
            if !options.verify_crc {
                (Some(stored), None)
            } else if stats.expanded_bytes > crate::MAX_TRANSFORM_BYTES {
                warnings.push("crc_not_verified:expanded_over_cap".into());
                (Some(stored), None)
            } else {
                let image = expand_inner(bytes, &head)?;
                (Some(stored), Some(crc32(&image) == stored))
            }
        }
    };

    Ok(json!({
        "schema_version": 1,
        "kind": "android-sparse",
        "input_bytes": bytes.len(),
        "version": { "major": head.major, "minor": head.minor },
        "file_header_size": head.file_header_size,
        "chunk_header_size": head.chunk_header_size,
        "block_size": head.block_size,
        "total_blocks": head.total_blocks,
        "total_chunks": head.total_chunks,
        "chunk_count": stats.chunks_seen,
        "output_blocks": stats.output_blocks,
        "expanded_bytes": stats.expanded_bytes.to_string(),
        "image_checksum": hex(head.image_checksum as u64),
        "chunks": chunks,
        "chunks_truncated": chunks_truncated,
        "crc": {
            "stored": crc_stored.map(|value| hex(value as u64)),
            "valid": crc_valid,
            "count": stats.crc_values.len(),
        },
        "trailing_bytes": stats.trailing_bytes,
        "truncated": chunks_truncated,
        "warnings": warnings,
    }))
}

pub(crate) fn expand(bytes: &[u8], options: &ExpandOptions) -> Result<Vec<u8>, String> {
    let head = read_head(bytes)?;
    // Bound check before allocation: total output size is pure arithmetic.
    let stats = walk_chunks(bytes, &head, |_| Ok(()))?;
    if stats.expanded_bytes > options.max_output_bytes {
        return Err(error_json(
            "output_too_large",
            json!({ "size": stats.expanded_bytes, "limit": options.max_output_bytes }),
        ));
    }
    let out = expand_inner(bytes, &head)?;
    if let Some(&stored) = stats.crc_values.last() {
        let computed = crc32(&out);
        if computed != stored {
            return Err(error_json(
                "crc_mismatch",
                json!({ "stored": hex(stored as u64), "computed": hex(computed as u64) }),
            ));
        }
    }
    Ok(out)
}
