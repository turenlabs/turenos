//! Bounded `.DS_Store` parsing, hand-rolled from the documented format:
//! a 36-byte `Bud1` header, a buddy-allocator root block holding block
//! offsets and the TOC (`DSDB` names the superblock), then a B-tree of
//! entries `{filename, code, typecode, value}`. All reads are bounds-checked,
//! the tree walk is depth-limited and cycle-guarded, and values render
//! bounded (`blob` -> `{length, sha256, preview}`; `Iloc` -> `{x, y}`;
//! `bwsp`/`lsvp`/`lsvP`/`icvp` -> inline bounded plist JSON).

use serde::Deserialize;
use std::collections::HashSet;

use crate::{
    clean, clamp_limit, hex_preview, sha256_hex, Envelope, Fail, MAX_DSSTORE_BLOCKS,
    MAX_DSSTORE_DEPTH, MAX_PATH_CHARS, MAX_RESULTS, MAX_STRING_CHARS, DEFAULT_RESULTS,
};

#[derive(Deserialize, Default)]
pub(crate) struct DsStoreOptions {
    pub(crate) max_results: Option<u64>,
}

/// Cursor over one block's bytes; every read is checked.
struct Block<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Block<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let out = self.data.get(self.pos..self.pos.checked_add(n)?)?;
        self.pos += n;
        Some(out)
    }
    fn u8(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }
    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_be_bytes(self.take(4)?.try_into().ok()?))
    }
    fn u64(&mut self) -> Option<u64> {
        Some(u64::from_be_bytes(self.take(8)?.try_into().ok()?))
    }
}

struct Allocator<'a> {
    offsets: Vec<u32>,
    toc: Vec<(String, u32)>,
    blocks_file: &'a [u8],
}

impl<'a> Allocator<'a> {
    /// Block `number` resolves through the offsets table: low 5 bits are the
    /// size exponent, the rest is a file offset relative to byte 4.
    fn block(&self, number: u32) -> Option<Block<'a>> {
        let addr = *self.offsets.get(number as usize)?;
        let offset = ((addr & !0x1f) as usize).checked_add(4)?;
        let size = 1usize.checked_shl(addr & 0x1f)?;
        Some(Block::new(self.blocks_file.get(offset..offset.checked_add(size)?)?))
    }
}

struct Ctx<'a> {
    allocator: &'a Allocator<'a>,
    visited: HashSet<u32>,
    blocks_walked: usize,
    records_total: u64,
    max_results: usize,
}

pub(crate) fn run(
    bytes: &[u8],
    options: &DsStoreOptions,
    envelope: &mut Envelope,
) -> Result<serde_json::Value, Fail> {
    let max_results = clamp_limit(options.max_results, DEFAULT_RESULTS, MAX_RESULTS);

    // Header: u32 magic(=1), "Bud1", u32 root offset, u32 root size,
    // u32 offset copy, 16 unknown bytes.
    let mut head = Block::new(bytes);
    let magic = head.u32().ok_or_else(|| Fail::new("invalid_ds_store"))?;
    let bud = head.take(4).ok_or_else(|| Fail::new("invalid_ds_store"))?;
    if magic != 1 || bud != b"Bud1" {
        return Err(Fail::new("invalid_ds_store"));
    }
    let root_offset = head.u32().ok_or_else(|| Fail::new("invalid_ds_store"))?;
    let root_size = head.u32().ok_or_else(|| Fail::new("invalid_ds_store"))?;
    let root_offset2 = head.u32().ok_or_else(|| Fail::new("invalid_ds_store"))?;
    head.take(16);
    if root_offset != root_offset2 {
        envelope.warn("root block offset fields disagree".to_string());
    }

    let root_start = (root_offset as usize)
        .checked_add(4)
        .ok_or_else(|| Fail::new("invalid_ds_store"))?;
    let root_end = root_start
        .checked_add(root_size as usize)
        .ok_or_else(|| Fail::new("invalid_ds_store"))?;
    let root_data = bytes
        .get(root_start..root_end)
        .ok_or_else(|| Fail::new("invalid_ds_store"))?;
    let mut root_block = Block::new(root_data);

    let offset_count = root_block
        .u32()
        .ok_or_else(|| Fail::new("invalid_ds_store"))? as usize;
    let _unknown2 = root_block.u32();
    if offset_count > MAX_DSSTORE_BLOCKS {
        return Err(Fail::new("invalid_ds_store").with("detail", "offset table too large"));
    }
    // Offsets are stored padded to 256-entry pages.
    let pages = offset_count.saturating_add(255) / 256;
    let mut raw_offsets = Vec::with_capacity(offset_count);
    for _ in 0..pages {
        for _ in 0..256 {
            let value = match root_block.u32() {
                Some(value) => value,
                None => return Err(Fail::new("invalid_ds_store").with("detail", "offset table truncated")),
            };
            if raw_offsets.len() < offset_count {
                raw_offsets.push(value);
            }
        }
    }

    // TOC: u32 count, then nlen u8 + name + u32 block number.
    let mut toc = Vec::new();
    if let Some(toc_count) = root_block.u32() {
        for _ in 0..toc_count.min(MAX_DSSTORE_BLOCKS as u32) {
            let nlen = match root_block.u8() {
                Some(n) => n as usize,
                None => break,
            };
            let name = match root_block.take(nlen) {
                Some(raw) => String::from_utf8_lossy(raw).to_string(),
                None => break,
            };
            let block = match root_block.u32() {
                Some(b) => b,
                None => break,
            };
            toc.push((name, block));
        }
    }

    // Free lists follow the TOC: 32 lists of u32 count + u32 addresses.
    let mut free_blocks: u64 = 0;
    let mut freelists_ok = true;
    for _ in 0..32 {
        match root_block.u32() {
            Some(count) => {
                if root_block.take(count as usize * 4).is_none() {
                    freelists_ok = false;
                    break;
                }
                free_blocks = free_blocks.saturating_add(count as u64);
            }
            None => {
                freelists_ok = false;
                break;
            }
        }
    }
    if !freelists_ok {
        envelope.warn("free lists truncated".to_string());
    }

    let allocator = Allocator {
        offsets: raw_offsets,
        toc,
        blocks_file: bytes,
    };

    let dsdb = allocator
        .toc
        .iter()
        .find(|(name, _)| name == "DSDB")
        .map(|(_, block)| *block)
        .ok_or_else(|| Fail::new("invalid_ds_store").with("detail", "no DSDB in TOC"))?;

    let mut superblock = allocator
        .block(dsdb)
        .ok_or_else(|| Fail::new("invalid_ds_store").with("detail", "DSDB block unreadable"))?;
    let root_node = superblock
        .u32()
        .ok_or_else(|| Fail::new("invalid_ds_store").with("detail", "superblock truncated"))?;
    let levels = superblock.u32().unwrap_or(0);
    let record_count = superblock.u32().unwrap_or(0);
    let node_count = superblock.u32().unwrap_or(0);
    let page_size = superblock.u32().unwrap_or(0);

    let mut ctx = Ctx {
        allocator: &allocator,
        visited: HashSet::new(),
        blocks_walked: 0,
        records_total: 0,
        max_results,
    };
    let mut records = Vec::new();
    walk_node(
        &mut ctx,
        root_node,
        0,
        &mut records,
        envelope,
    );

    if ctx.records_total as usize > records.len() {
        envelope.truncated = true;
        envelope.warn(format!(
            "records truncated at {} of {}",
            records.len(),
            ctx.records_total
        ));
    }

    Ok(serde_json::json!({
        "kind": "ds_store",
        "block_offsets": allocator.offsets.len(),
        "toc": allocator
            .toc
            .iter()
            .map(|(name, block)| serde_json::json!({ "name": name, "block": block }))
            .collect::<Vec<_>>(),
        "free_blocks": free_blocks,
        "superblock": {
            "root_node": root_node,
            "levels": levels,
            "records": record_count,
            "nodes": node_count,
            "page_size": page_size,
        },
        "records_returned": records.len(),
        "record_count": ctx.records_total,
        "blocks_walked": ctx.blocks_walked,
        "records": records,
    }))
}

/// B-tree node walk: `{next_node u32, count u32}` then either `count`
/// entries (leaf) or `count` interleaved `{child u32, entry}` pairs followed
/// by the `next_node` chain (internal). Depth and visited-set guards make
/// cyclic block graphs terminate.
fn walk_node(
    ctx: &mut Ctx,
    node: u32,
    depth: usize,
    records: &mut Vec<serde_json::Value>,
    envelope: &mut Envelope,
) {
    if depth > MAX_DSSTORE_DEPTH {
        envelope.warn(format!("B-tree depth capped at {MAX_DSSTORE_DEPTH}"));
        return;
    }
    if ctx.blocks_walked >= MAX_DSSTORE_BLOCKS {
        envelope.warn("block walk limit reached".to_string());
        return;
    }
    if !ctx.visited.insert(node) {
        envelope.warn(format!("cyclic block reference {node}"));
        return;
    }
    let mut block = match ctx.allocator.block(node) {
        Some(block) => block,
        None => {
            envelope.warn(format!("block {node} unreadable"));
            return;
        }
    };
    ctx.blocks_walked += 1;
    let (next_node, count) = match (block.u32(), block.u32()) {
        (Some(next), Some(count)) => (next, count),
        _ => {
            envelope.warn(format!("block {node} header truncated"));
            return;
        }
    };

    for _ in 0..count {
        if next_node != 0 {
            // Internal node: child pointer precedes each entry.
            match block.u32() {
                Some(child) => walk_node(ctx, child, depth + 1, records, envelope),
                None => {
                    envelope.warn(format!("block {node} child pointer truncated"));
                    return;
                }
            }
        }
        match read_entry(&mut block, ctx, envelope) {
            Some(entry) => {
                ctx.records_total += 1;
                if records.len() < ctx.max_results {
                    records.push(entry);
                }
            }
            None => return,
        }
    }
    if next_node != 0 {
        walk_node(ctx, next_node, depth, records, envelope);
    }
}

/// One `.DS_Store` entry: filename (utf-16be), 4-char code, 4-char typecode,
/// then the typed value.
fn read_entry(
    block: &mut Block,
    ctx: &mut Ctx,
    envelope: &mut Envelope,
) -> Option<serde_json::Value> {
    let nlen = block.u32()? as usize;
    if nlen > 65536 {
        envelope.warn("entry filename length implausible".to_string());
        return None;
    }
    let raw_name = block.take(nlen.checked_mul(2)?)?;
    let filename = clean(&decode_utf16be(raw_name), MAX_PATH_CHARS);
    let code = block
        .take(4)
        .map(|c| String::from_utf8_lossy(c).to_string())
        .unwrap_or_default();
    let typecode = block
        .take(4)
        .map(|c| String::from_utf8_lossy(c).to_string())
        .unwrap_or_default();

    let value = match typecode.as_str() {
        "bool" => block.u8().map(|b| serde_json::Value::Bool(b != 0)),
        "long" | "shor" => block.u32().map(serde_json::Value::from),
        "comp" | "dutc" => block.u64().map(serde_json::Value::from),
        "type" => block.take(4).map(|raw| {
            serde_json::Value::String(String::from_utf8_lossy(raw).to_string())
        }),
        "ustr" => {
            let vlen = block.u32()? as usize;
            if vlen > 65536 {
                envelope.warn("entry ustr length implausible".to_string());
                return None;
            }
            let raw = block.take(vlen.checked_mul(2)?)?;
            Some(serde_json::Value::String(clean(
                &decode_utf16be(raw),
                MAX_STRING_CHARS,
            )))
        }
        "blob" => {
            let vlen = block.u32()? as usize;
            if vlen > 4 * 1024 * 1024 {
                envelope.warn("entry blob length implausible".to_string());
                return None;
            }
            let raw = block.take(vlen)?;
            Some(decode_blob(&code, raw, ctx))
        }
        _ => {
            envelope.warn(format!("unknown entry type '{typecode}'"));
            return None;
        }
    };
    value.map(|value| {
        serde_json::json!({
            "filename": filename,
            "code": code,
            "type": typecode,
            "value": value,
        })
    })
}

fn decode_blob(code: &str, raw: &[u8], _ctx: &mut Ctx) -> serde_json::Value {
    match code {
        "Iloc" if raw.len() >= 8 => serde_json::json!({
            "x": u32::from_be_bytes(raw[0..4].try_into().unwrap_or_default()),
            "y": u32::from_be_bytes(raw[4..8].try_into().unwrap_or_default()),
            "length": raw.len(),
        }),
        "bwsp" | "lsvp" | "lsvP" | "icvp" => {
            match crate::plistdoc::embedded_plist(raw) {
                Some(plist) => serde_json::json!({
                    "plist": plist,
                    "length": raw.len(),
                    "sha256": sha256_hex(raw),
                }),
                None => serde_json::json!({
                    "length": raw.len(),
                    "sha256": sha256_hex(raw),
                    "preview": hex_preview(raw),
                }),
            }
        }
        _ => serde_json::json!({
            "length": raw.len(),
            "sha256": sha256_hex(raw),
            "preview": hex_preview(raw),
        }),
    }
}

fn decode_utf16be(raw: &[u8]) -> String {
    let units: Vec<u16> = raw
        .chunks_exact(2)
        .map(|c| u16::from_be_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16_lossy(&units)
}
