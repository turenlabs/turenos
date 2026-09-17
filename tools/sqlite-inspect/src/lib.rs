//! Bounded, offline, read-only forensics for SQLite 3 database files.
//!
//! Input is always one database file's bytes. No journal/WAL sidecar is
//! consulted and the input is never modified: this module reports structural
//! facts from the main database file only. Every operation returns bounded
//! JSON (`{"schema_version":1,...}`); expected failures return
//! `{"schema_version":1,"error":"<code>","message":"..."}`.
//!
//! Implemented against the public-domain SQLite file format specification
//! (<https://sqlite.org/fileformat.html>). No SQLite source code is used.

mod carve;
mod db;
mod freelist;
mod inspect;
mod record;
mod rows;
mod schema;
mod stats;

#[cfg(test)]
mod tests;

use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::panic::{catch_unwind, AssertUnwindSafe};
use wasm_bindgen::prelude::*;

pub(crate) const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const MAX_OPTIONS_BYTES: usize = 4 * 1024;
pub(crate) const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
/// Cap on reported collections (schema records, freelist trunks, carve
/// candidates, warnings).
pub(crate) const MAX_ITEMS: usize = 4096;
/// `sqlite_rows` hard cap (option `maxRows` clamps to this).
pub(crate) const MAX_ROWS: usize = 256;
pub(crate) const DEFAULT_ROWS: usize = 64;
/// Columns decoded per record (SQLite's own column ceiling is 2000).
pub(crate) const MAX_COLUMNS: usize = 2000;
/// Per-cell record payload bytes materialized for row decode.
pub(crate) const MAX_CELL_PAYLOAD: u64 = 8 * 1024 * 1024;
/// Overflow pages followed per cell (also bounded by the on-disk page count).
pub(crate) const MAX_OVERFLOW_PAGES: usize = 4096;
/// `sql` text kept per schema record.
pub(crate) const MAX_SQL_TEXT: usize = 8192;
/// Decoded text value cap (post-transcode bytes kept in JSON).
pub(crate) const MAX_TEXT_VALUE: usize = 4096;
/// Blob hex preview ceiling; full blobs are never inlined, only hashed.
pub(crate) const MAX_BLOB_PREVIEW: usize = 256;
pub(crate) const DEFAULT_BLOB_PREVIEW: usize = 32;
/// `sqlite_carve` candidate ceiling.
pub(crate) const MAX_CARVE_CANDIDATES: usize = 4096;
pub(crate) const DEFAULT_CARVE_CANDIDATES: usize = 256;
/// Varints scanned per carve candidate while looking for a record header.
pub(crate) const MAX_CARVE_HEADER: usize = 4096;
/// Columns decoded into a carved candidate preview; also the serial-type
/// cap per probe so per-offset scan cost stays bounded.
pub(crate) const MAX_CARVE_COLUMNS: usize = 64;
/// Global probe budget: total byte-offsets probed per `sqlite_carve` call.
/// Bounds wall time on adversarial free-region contents.
pub(crate) const MAX_CARVE_PROBES: u64 = 8_000_000;

/// Shared per-request state: collected warnings and a truncation flag that
/// serializers echo back in the report body.
pub(crate) struct Report {
    pub warnings: Vec<String>,
    pub truncated: bool,
}

impl Report {
    pub(crate) fn new() -> Self {
        Self {
            warnings: Vec::new(),
            truncated: false,
        }
    }

    pub(crate) fn warn(&mut self, message: impl Into<String>) {
        if self.warnings.len() < 64 {
            self.warnings.push(message.into());
        }
    }
}

/// `sqlite_inspect` (default op): decode the 100-byte database header —
/// magic, page size, journal mode (WAL vs rollback), change counter,
/// in-header db size, freelist summary, schema cookie/format, autovacuum,
/// text encoding, user version, application id, and validity flags.
#[wasm_bindgen]
pub fn sqlite_inspect(bytes: &[u8], options_json: &str) -> String {
    guard(bytes, options_json, inspect::inspect)
}

/// `sqlite_schema`: walk the sqlite_master b-tree rooted at page 1 and emit
/// every schema record `{type, name, tblName, rootpage, sql}` (bounded).
#[wasm_bindgen]
pub fn sqlite_schema(bytes: &[u8], options_json: &str) -> String {
    guard(bytes, options_json, schema::schema)
}

/// `sqlite_table_stats`: per-table b-tree walk — page counts by type,
/// overflow pages, row count, depth, min/max rowid, corrupt findings.
/// Option `{"table":"name"}` limits the walk to one table.
#[wasm_bindgen]
pub fn sqlite_table_stats(bytes: &[u8], options_json: &str) -> String {
    guard(bytes, options_json, stats::table_stats)
}

/// `sqlite_rows`: decode rows of the named table's root b-tree in rowid
/// order. Options: `{"table":"name","maxRows":<=256,"blobPreviewBytes":<=256}`.
/// Blobs are reported as `{type:"blob",length,sha256,previewHex}` — never
/// inlined beyond the preview cap.
#[wasm_bindgen]
pub fn sqlite_rows(bytes: &[u8], options_json: &str) -> String {
    guard(bytes, options_json, rows::rows)
}

/// `sqlite_freelist`: walk the freelist trunk-page chain — each trunk's next
/// pointer and leaf-page list, declared vs counted free pages, broken links,
/// cycles, and carvable-byte statistics.
#[wasm_bindgen]
pub fn sqlite_freelist(bytes: &[u8], options_json: &str) -> String {
    guard(bytes, options_json, freelist::freelist)
}

/// `sqlite_carve`: heuristic scan of unallocated gaps, freeblock bodies, and
/// freelist pages for record-shaped data. Candidates are labelled heuristic —
/// they are not verified live rows.
#[wasm_bindgen]
pub fn sqlite_carve(bytes: &[u8], options_json: &str) -> String {
    guard(bytes, options_json, carve::carve)
}

fn finish(result: std::thread::Result<Result<Value, &'static str>>) -> String {
    let value = match result {
        Ok(Ok(value)) => value,
        Ok(Err(code)) => return error_json(code),
        Err(_) => return error_json("internal_error"),
    };
    match serde_json::to_string(&value) {
        Ok(output) if output.len() <= MAX_OUTPUT_BYTES => output,
        Ok(_) => error_json("output_too_large"),
        Err(_) => error_json("serialization_error"),
    }
}

/// Common pre-allocation limits and error-JSON convention for JSON ops.
fn guard<O, F>(bytes: &[u8], options_json: &str, op: F) -> String
where
    O: DeserializeOwned,
    F: FnOnce(&[u8], &O, &mut Report) -> Result<Value, &'static str>,
{
    if options_json.len() > MAX_OPTIONS_BYTES {
        return error_json("options_too_large");
    }
    if bytes.is_empty() {
        return error_json("empty_input");
    }
    if bytes.len() > MAX_INPUT_BYTES {
        return error_json("input_too_large");
    }
    let options = match serde_json::from_str::<O>(options_json) {
        Ok(options) => options,
        Err(_) => return error_json("invalid_options"),
    };
    let mut report = Report::new();
    finish(catch_unwind(AssertUnwindSafe(|| {
        op(bytes, &options, &mut report)
    })))
}

pub(crate) fn error_json(code: &str) -> String {
    json!({
        "schema_version": 1,
        "error": code,
        "message": error_message(code),
    })
    .to_string()
}

fn error_message(code: &str) -> &'static str {
    match code {
        "empty_input" => "input is empty",
        "input_too_large" => "input exceeds the 32 MiB limit",
        "options_too_large" => "options JSON exceeds the 4 KiB limit",
        "invalid_options" => "options JSON is malformed or fails validation",
        "output_too_large" => "serialized report exceeds the 4 MiB limit",
        "not_sqlite" => "input is too small or lacks the SQLite 3 header",
        "invalid_page_size" => "header page size is not a usable power of two",
        "page_out_of_range" => "a referenced page lies outside the file",
        "table_not_found" => "no table with that name in sqlite_master",
        "not_a_table" => "schema object has no table b-tree root (view/trigger)",
        "missing_table" => "the \"table\" option is required",
        "record_header" => "record header is malformed",
        "reserved_serial_type" => "record uses reserved serial type 10/11",
        "payload_too_large" => "cell payload exceeds the decode cap",
        "internal_error" => "internal error",
        _ => "operation failed",
    }
}

pub(crate) fn u16_be(bytes: &[u8], offset: usize) -> u16 {
    u16::from_be_bytes([bytes[offset], bytes[offset + 1]])
}

pub(crate) fn u24_be(bytes: &[u8], offset: usize) -> u32 {
    ((bytes[offset] as u32) << 16) | ((bytes[offset + 1] as u32) << 8) | bytes[offset + 2] as u32
}

pub(crate) fn u32_be(bytes: &[u8], offset: usize) -> u32 {
    u32::from_be_bytes([bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]])
}

pub(crate) fn u48_be(bytes: &[u8], offset: usize) -> u64 {
    ((bytes[offset] as u64) << 40)
        | ((bytes[offset + 1] as u64) << 32)
        | ((bytes[offset + 2] as u64) << 24)
        | ((bytes[offset + 3] as u64) << 16)
        | ((bytes[offset + 4] as u64) << 8)
        | bytes[offset + 5] as u64
}

/// SQLite varint: 1–9 big-endian bytes, 7 bits each; the ninth byte
/// contributes all 8 bits. Returns `(value, bytes_consumed)`; `None` when the
/// slice is too short.
pub(crate) fn varint(bytes: &[u8]) -> Option<(u64, usize)> {
    let mut value: u64 = 0;
    for i in 0..8 {
        let byte = *bytes.get(i)?;
        value = (value << 7) | (byte & 0x7f) as u64;
        if byte & 0x80 == 0 {
            return Some((value, i + 1));
        }
    }
    let ninth = *bytes.get(8)?;
    value = (value << 8) | ninth as u64;
    Some((value, 9))
}

pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

pub(crate) fn sha256_hex(data: &[u8]) -> String {
    use sha2::Digest;
    hex_encode(&sha2::Sha256::digest(data))
}
