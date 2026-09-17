//! Bounded packfile (`PACK` v2/v3) inspection and single-entry extraction.
//!
//! A pack is: 12-byte header, per-entry (type/size varint, optional delta base
//! reference, zlib stream), and a trailing SHA-1 over all preceding bytes.
//! Entry boundaries are only known by running each zlib stream to its end, so
//! scanning inflates-to-discard under an aggregate byte budget. Extraction
//! resolves `ofs-delta`/`ref-delta` chains with explicit depth, cycle, and
//! budget bounds; `ref-delta` bases are located by hashing resolved objects
//! (no companion `.idx` is required).

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use crate::delta::apply_delta;
use crate::zlib::{inflate_bounded, inflate_measure};
use crate::{
    base64_encode, hex_encode, u32_be, Report, MAX_DELTA_DEPTH, MAX_ITEMS, MAX_OBJECT_BYTES,
    MAX_PREVIEW_BYTES, MAX_SCAN_ENTRIES, RESOLVE_BUDGET_BYTES,
};

const OBJ_COMMIT: u8 = 1;
const OBJ_TREE: u8 = 2;
const OBJ_BLOB: u8 = 3;
const OBJ_TAG: u8 = 4;
const OBJ_OFS_DELTA: u8 = 6;
const OBJ_REF_DELTA: u8 = 7;

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct InspectOptions {
    #[serde(alias = "max_items")]
    max_items: Option<usize>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct EntryOptions {
    index: Option<u64>,
    offset: Option<u64>,
    #[serde(alias = "max_preview_bytes")]
    max_preview_bytes: Option<usize>,
}

impl EntryOptions {
    fn preview_limit(&self) -> usize {
        self.max_preview_bytes
            .unwrap_or(8192)
            .min(MAX_PREVIEW_BYTES)
    }
}

#[derive(Clone)]
pub(crate) struct EntryHead {
    pub offset: u64,
    kind: u8,
    declared_size: u64,
    /// Absolute offset of the entry's zlib stream.
    data_offset: usize,
    /// Compressed stream length in bytes.
    data_len: usize,
    base_offset: Option<u64>,
    base_sha1: Option<[u8; 20]>,
    /// Set when the measured decompressed size differed from `declared_size`.
    size_mismatch: bool,
}

pub(crate) struct PackView<'a> {
    bytes: &'a [u8],
    version: u32,
    declared: u32,
    entries: Vec<EntryHead>,
    /// Every declared entry was located; false on early end, stream errors,
    /// budget exhaustion, or the scan-entry cap.
    scan_complete: bool,
    checksum_valid: bool,
    /// Absolute offset where entry streams stop being parseable.
    consumed_end: usize,
    /// Offset of the 20-byte trailer.
    body_end: usize,
    trailer_hex: String,
    warnings: Vec<String>,
}

impl<'a> PackView<'a> {
    fn parse(bytes: &'a [u8]) -> Result<Self, &'static str> {
        if bytes.len() < 4 || &bytes[..4] != b"PACK" {
            return Err("not_pack");
        }
        if bytes.len() < 12 {
            return Err("truncated_input");
        }
        if bytes.len() < 32 {
            return Err("truncated_input");
        }
        let version = u32_be(bytes, 4);
        if version != 2 && version != 3 {
            return Err("unsupported_pack_version");
        }
        let declared = u32_be(bytes, 8);
        let body_end = bytes.len() - 20;
        let trailer = &bytes[body_end..];
        let checksum_valid = crate::sha1_bytes(&bytes[..body_end]) == trailer;

        let mut view = PackView {
            bytes,
            version,
            declared,
            entries: Vec::new(),
            scan_complete: false,
            checksum_valid,
            consumed_end: 12,
            body_end,
            trailer_hex: hex_encode(trailer),
            warnings: Vec::new(),
        };

        let mut budget: i64 = RESOLVE_BUDGET_BYTES as i64;
        let mut pos = 12usize;
        let target = (declared as usize).min(MAX_SCAN_ENTRIES);
        for index in 0..target {
            if pos >= body_end {
                view.warnings
                    .push(format!("pack ended after {index} of {declared} declared entries"));
                break;
            }
            let head = match parse_entry_head(bytes, pos) {
                Ok(head) => head,
                Err(code) => {
                    view.warnings
                        .push(format!("entry {index} header error at {pos}: {code}"));
                    break;
                }
            };
            if head.data_offset > body_end {
                view.warnings
                    .push(format!("entry {index} extends past pack trailer"));
                break;
            }
            // Bound this stream by both its declared size and the shared
            // budget; a corrupt stream that overshoots either stops the scan.
            let cap = head
                .declared_size
                .min(MAX_OBJECT_BYTES as u64)
                .min(budget.max(0) as u64);
            let measured = match inflate_measure(&bytes[head.data_offset..body_end], cap) {
                Ok(measured) => measured,
                Err(code) => {
                    view.warnings
                        .push(format!("entry {index} stream error: {code}"));
                    break;
                }
            };
            let mut head = head;
            head.data_len = measured.consumed;
            if measured.out_len != head.declared_size {
                head.size_mismatch = true;
                view.warnings.push(format!(
                    "entry {index} produced {} bytes, declared {}",
                    measured.out_len, head.declared_size
                ));
            }
            budget -= measured.out_len as i64;
            pos = head.data_offset + head.data_len;
            view.entries.push(head);
            if budget <= 0 {
                view.warnings
                    .push("decompression budget exhausted during scan".to_string());
                break;
            }
        }
        view.consumed_end = pos;
        view.scan_complete = view.entries.len() == declared as usize;
        if declared as usize > MAX_SCAN_ENTRIES {
            view.warnings.push(format!(
                "entry scan capped at {MAX_SCAN_ENTRIES} of {declared} declared"
            ));
        }
        Ok(view)
    }

    fn by_offset(&self) -> HashMap<u64, usize> {
        self.entries
            .iter()
            .enumerate()
            .map(|(i, e)| (e.offset, i))
            .collect()
    }
}

/// Parse an entry header at `offset`: type/size varint plus the delta base
/// reference. `data_len` stays zero until the zlib stream is measured.
fn parse_entry_head(bytes: &[u8], offset: usize) -> Result<EntryHead, &'static str> {
    let mut pos = offset;
    let mut byte = *bytes.get(pos).ok_or("truncated_input")?;
    pos += 1;
    let kind = (byte >> 4) & 7;
    let mut size = (byte & 0x0f) as u64;
    let mut shift = 4u32;
    while byte & 0x80 != 0 {
        if shift > 60 {
            return Err("malformed_header");
        }
        byte = *bytes.get(pos).ok_or("truncated_input")?;
        pos += 1;
        size |= ((byte & 0x7f) as u64) << shift;
        shift += 7;
    }
    let mut head = EntryHead {
        offset: offset as u64,
        kind,
        declared_size: size,
        data_offset: pos,
        data_len: 0,
        base_offset: None,
        base_sha1: None,
        size_mismatch: false,
    };
    match kind {
        OBJ_OFS_DELTA => {
            // Offset encoding: 7-bit groups with a +1 carry per continuation.
            let mut byte = *bytes.get(pos).ok_or("truncated_input")?;
            pos += 1;
            let mut distance = (byte & 0x7f) as u64;
            while byte & 0x80 != 0 {
                byte = *bytes.get(pos).ok_or("truncated_input")?;
                pos += 1;
                distance = ((distance + 1) << 7) | (byte & 0x7f) as u64;
            }
            if distance == 0 || distance > offset as u64 {
                return Err("malformed_header");
            }
            head.base_offset = Some(offset as u64 - distance);
            head.data_offset = pos;
        }
        OBJ_REF_DELTA => {
            let end = pos.checked_add(20).ok_or("truncated_input")?;
            if end > bytes.len() {
                return Err("truncated_input");
            }
            let mut sha = [0u8; 20];
            sha.copy_from_slice(&bytes[pos..end]);
            head.base_sha1 = Some(sha);
            head.data_offset = end;
        }
        OBJ_COMMIT | OBJ_TREE | OBJ_BLOB | OBJ_TAG => {}
        _ => return Err("malformed_header"),
    }
    Ok(head)
}

pub(crate) struct Resolved {
    pub kind: &'static str,
    pub data: Rc<Vec<u8>>,
    pub depth: u32,
}

/// Chain resolver over a scanned pack. Caches resolved objects and their
/// object ids; `budget` bounds aggregate decompressed bytes across the call,
/// `path` bounds/cycle-guards recursion.
struct Resolver<'p, 'a> {
    view: &'p PackView<'a>,
    by_offset: HashMap<u64, usize>,
    cache: HashMap<usize, Rc<Resolved>>,
    sha_map: HashMap<[u8; 20], usize>,
    depth_memo: HashMap<usize, Option<u32>>,
    path: Vec<usize>,
    budget: i64,
    budget_exceeded: bool,
    /// Monotonic scan position for `ref-delta` base search; the linear scan is
    /// never rewound, so total work across all lookups stays O(entries).
    scan_pos: usize,
}

impl<'p, 'a> Resolver<'p, 'a> {
    fn new(view: &'p PackView<'a>) -> Self {
        Self {
            view,
            by_offset: view.by_offset(),
            cache: HashMap::new(),
            sha_map: HashMap::new(),
            depth_memo: HashMap::new(),
            path: Vec::new(),
            budget: RESOLVE_BUDGET_BYTES as i64,
            budget_exceeded: false,
            scan_pos: 0,
        }
    }

    fn spend(&mut self, bytes: u64) -> Result<(), &'static str> {
        self.budget -= bytes as i64;
        if self.budget < 0 {
            self.budget_exceeded = true;
            return Err("budget_exceeded");
        }
        Ok(())
    }

    /// Inflate one entry's stream, enforcing the declared size.
    fn inflate_entry(&mut self, index: usize) -> Result<Vec<u8>, &'static str> {
        let head = &self.view.entries[index];
        if head.declared_size > MAX_OBJECT_BYTES as u64 {
            return Err("object_too_large");
        }
        self.spend(head.declared_size)?;
        let end = head
            .data_offset
            .checked_add(head.data_len)
            .ok_or("malformed_pack")?;
        let inflated = inflate_bounded(
            &self.view.bytes[head.data_offset..end],
            head.declared_size as usize,
        )?;
        if !inflated.complete || inflated.data.len() as u64 != head.declared_size {
            return Err("size_mismatch");
        }
        Ok(inflated.data)
    }

    /// Fully resolve an entry to object bytes. `depth` counts delta links and
    /// is hard-capped at MAX_DELTA_DEPTH for extraction.
    fn resolve(&mut self, index: usize, depth: usize) -> Result<Rc<Resolved>, &'static str> {
        if let Some(hit) = self.cache.get(&index) {
            return Ok(hit.clone());
        }
        if depth > MAX_DELTA_DEPTH {
            return Err("delta_depth_exceeded");
        }
        if self.path.contains(&index) {
            return Err("delta_cycle");
        }
        self.path.push(index);
        let result = self.resolve_uncached(index, depth);
        self.path.pop();
        match &result {
            Ok(resolved) => {
                self.cache.insert(index, resolved.clone());
            }
            Err(_) => {
                // Keep the failure terminal for this call: report it again
                // without redoing the work.
                self.depth_memo.entry(index).or_insert(None);
            }
        }
        result
    }

    fn resolve_uncached(&mut self, index: usize, depth: usize) -> Result<Rc<Resolved>, &'static str> {
        let head = self.view.entries[index].clone();
        match head.kind {
            OBJ_COMMIT | OBJ_TREE | OBJ_BLOB | OBJ_TAG => Ok(Rc::new(Resolved {
                kind: kind_name(head.kind),
                data: Rc::new(self.inflate_entry(index)?),
                depth: 0,
            })),
            OBJ_OFS_DELTA | OBJ_REF_DELTA => {
                let base_index = match (head.kind, head.base_offset, head.base_sha1) {
                    (OBJ_OFS_DELTA, Some(base), _) => *self
                        .by_offset
                        .get(&base)
                        .ok_or("delta_base_missing")?,
                    (OBJ_REF_DELTA, _, Some(sha)) => self.find_by_sha(&sha)?,
                    _ => return Err("malformed_pack"),
                };
                let base = self.resolve(base_index, depth + 1)?;
                let delta = self.inflate_entry(index)?;
                let out = apply_delta(&base.data, &delta, MAX_OBJECT_BYTES)?;
                self.spend(out.len() as u64)?;
                Ok(Rc::new(Resolved {
                    kind: base.kind,
                    data: Rc::new(out),
                    depth: base.depth + 1,
                }))
            }
            _ => Err("malformed_pack"),
        }
    }

    /// Locate the entry whose resolved object id equals `want`, scanning
    /// forward from the shared `scan_pos` and hashing each newly resolved
    /// object. Unresolvable entries are skipped.
    fn find_by_sha(&mut self, want: &[u8; 20]) -> Result<usize, &'static str> {
        if let Some(&index) = self.sha_map.get(want) {
            return Ok(index);
        }
        while self.scan_pos < self.view.entries.len() {
            let index = self.scan_pos;
            self.scan_pos += 1;
            let resolved = match self.resolve(index, 0) {
                Ok(resolved) => resolved,
                Err(_) => continue,
            };
            let id = crate::sha1_bytes_prefixed(resolved.kind, &resolved.data);
            self.sha_map.insert(id, index);
            if &id == want {
                return Ok(index);
            }
        }
        Err("base_not_found")
    }

    /// Structural chain depth for reporting. `ofs-delta` links are followed by
    /// offset alone (no inflation); `ref-delta` links resolve their base under
    /// the shared budget. Returns None when a base is missing, the budget is
    /// exhausted, or the chain exceeds the extraction depth cap.
    fn depth_of(&mut self, index: usize) -> Option<u32> {
        let mut path = Vec::new();
        let mut seen = HashSet::new();
        let mut current = index;
        let terminal = loop {
            if let Some(&depth) = self.depth_memo.get(&current) {
                break depth;
            }
            if !seen.insert(current) {
                break None;
            }
            let head = &self.view.entries[current];
            let next = match head.kind {
                OBJ_COMMIT | OBJ_TREE | OBJ_BLOB | OBJ_TAG => break Some(0),
                OBJ_OFS_DELTA => head
                    .base_offset
                    .and_then(|base| self.by_offset.get(&base).copied()),
                OBJ_REF_DELTA => head
                    .base_sha1
                    .and_then(|sha| self.find_by_sha(&sha).ok()),
                _ => None,
            };
            match next {
                Some(base) => {
                    path.push(current);
                    current = base;
                }
                None => break None,
            }
        };
        self.depth_memo.insert(current, terminal);
        let mut depth = terminal;
        for &entry in path.iter().rev() {
            depth = depth.map(|value| value + 1);
            self.depth_memo.insert(entry, depth);
        }
        self.depth_memo.get(&index).copied().flatten()
    }
}

fn select(view: &PackView<'_>, options: &EntryOptions) -> Result<usize, &'static str> {
    let by_offset = view.by_offset();
    match (options.index, options.offset) {
        (Some(index), None) if index < view.entries.len() as u64 => Ok(index as usize),
        (Some(_), None) => Err("entry_not_found"),
        (None, Some(offset)) => by_offset.get(&offset).copied().ok_or("entry_not_found"),
        (Some(_), Some(_)) => Err("conflicting_selectors"),
        (None, None) => Err("missing_selector"),
    }
}

/// `git_pack_inspect`: header, per-entry listing, delta-chain statistics, and
/// trailer checksum verification.
pub(crate) fn inspect(
    bytes: &[u8],
    options: &InspectOptions,
    report: &mut Report,
) -> Result<Value, &'static str> {
    let view = PackView::parse(bytes)?;
    report.warnings.extend(view.warnings.iter().cloned());
    let limit = options.max_items.unwrap_or(MAX_ITEMS).clamp(1, MAX_ITEMS);

    let mut resolver = Resolver::new(&view);
    let mut ofs_delta_count = 0usize;
    let mut ref_delta_count = 0usize;
    let mut max_chain_depth = 0u32;
    let mut unresolved_bases = 0usize;
    for index in 0..view.entries.len() {
        let head = &view.entries[index];
        match head.kind {
            OBJ_OFS_DELTA => ofs_delta_count += 1,
            OBJ_REF_DELTA => ref_delta_count += 1,
            _ => continue,
        }
        match resolver.depth_of(index) {
            Some(depth) => max_chain_depth = max_chain_depth.max(depth),
            None => unresolved_bases += 1,
        }
    }

    let listed: Vec<Value> = view
        .entries
        .iter()
        .take(limit)
        .enumerate()
        .map(|(index, head)| {
            let mut entry = json!({
                "index": index,
                "offset": head.offset,
                "type": kind_name(head.kind),
                "size": head.declared_size,
                "compressedSize": head.data_len,
            });
            if let Some(base) = head.base_offset {
                entry["baseOffset"] = json!(base);
            }
            if let Some(sha) = &head.base_sha1 {
                entry["baseSha1"] = json!(hex_encode(sha));
            }
            if head.kind == OBJ_OFS_DELTA || head.kind == OBJ_REF_DELTA {
                entry["depth"] = match resolver.depth_of(index) {
                    Some(depth) => json!(depth),
                    None => Value::Null,
                };
            }
            if head.size_mismatch {
                entry["sizeMismatch"] = json!(true);
            }
            entry
        })
        .collect();
    if view.entries.len() > listed.len() {
        report.truncated = true;
        report.warnings.push(format!(
            "entries truncated from {} to {}",
            view.entries.len(),
            listed.len()
        ));
    }
    if resolver.budget_exceeded {
        report
            .warnings
            .push("ref-delta resolution budget exhausted; depths incomplete".to_string());
    }

    Ok(json!({
        "schema_version": 1,
        "kind": "pack",
        "version": view.version,
        "declaredObjects": view.declared,
        "parsedObjects": view.entries.len(),
        "scanComplete": view.scan_complete,
        "bytesConsumed": view.consumed_end,
        "paddingBytes": view.body_end.saturating_sub(view.consumed_end),
        "checksum": {
            "algorithm": "sha1",
            "value": view.trailer_hex,
            "valid": view.checksum_valid,
        },
        "deltas": {
            "ofsDeltaCount": ofs_delta_count,
            "refDeltaCount": ref_delta_count,
            "maxChainDepth": max_chain_depth,
            "unresolvedBases": unresolved_bases,
            "resolutionIncomplete": resolver.budget_exceeded,
        },
        "entries": listed,
        "truncated": report.truncated,
        "warnings": report.warnings,
    }))
}

/// Shared extraction path for `git_pack_entry` / `git_pack_entry_raw`:
/// scan the pack, select one entry, resolve its delta chain.
pub(crate) fn entry_data(
    bytes: &[u8],
    options: &EntryOptions,
    report: &mut Report,
) -> Result<(usize, EntryHead, Rc<Resolved>), &'static str> {
    let view = PackView::parse(bytes)?;
    report.warnings.extend(view.warnings.iter().cloned());
    let index = select(&view, options)?;
    let head = view.entries[index].clone();
    let mut resolver = Resolver::new(&view);
    let resolved = resolver.resolve(index, 0)?;
    Ok((index, head, resolved))
}

/// `git_pack_entry`: resolve one object and return metadata plus a bounded
/// base64 preview. Full bytes are available through `git_pack_entry_raw`.
pub(crate) fn entry(
    bytes: &[u8],
    options: &EntryOptions,
    report: &mut Report,
) -> Result<Value, &'static str> {
    let (index, head, resolved) = entry_data(bytes, options, report)?;
    let preview = resolved.data.len().min(options.preview_limit());
    if preview < resolved.data.len() {
        report.truncated = true;
        report
            .warnings
            .push(format!("content preview truncated to {preview} bytes"));
    }
    Ok(json!({
        "schema_version": 1,
        "index": index,
        "offset": head.offset,
        "type": resolved.kind,
        "size": resolved.data.len(),
        "sha1": hex_encode(&crate::sha1_bytes_prefixed(resolved.kind, &resolved.data)),
        "sha256": crate::sha256_hex(&resolved.data),
        "chainDepth": resolved.depth,
        "previewBase64": base64_encode(&resolved.data[..preview]),
        "previewBytes": preview,
        "previewTruncated": preview < resolved.data.len(),
        "warnings": report.warnings,
    }))
}

/// `git_pack_entry_raw`: the full resolved object bytes as one bounded byte
/// vector (<= 128 MiB). Error codes are reported as strings to the caller.
pub(crate) fn entry_raw(
    bytes: &[u8],
    options: &EntryOptions,
    report: &mut Report,
) -> Result<Vec<u8>, &'static str> {
    let (_, _, resolved) = entry_data(bytes, options, report)?;
    Ok((*resolved.data).clone())
}

fn kind_name(kind: u8) -> &'static str {
    match kind {
        OBJ_COMMIT => "commit",
        OBJ_TREE => "tree",
        OBJ_BLOB => "blob",
        OBJ_TAG => "tag",
        OBJ_OFS_DELTA => "ofs_delta",
        OBJ_REF_DELTA => "ref_delta",
        _ => "unknown",
    }
}
