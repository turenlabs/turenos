//! `sqlite_inspect`: decode the 100-byte database header and report validity
//! flags. Forensic in nature — a bad magic or odd page size is reported, not
//! fatal.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::db::{Db, Header};
use crate::Report;

#[derive(Deserialize)]
pub(crate) struct InspectOptions {
    /// Unused today; reserved for future sub-reports.
    #[serde(default)]
    #[allow(dead_code)]
    verbose: Option<bool>,
}

pub(crate) fn inspect(
    bytes: &[u8],
    _options: &InspectOptions,
    report: &mut Report,
) -> Result<Value, &'static str> {
    let header = Header::parse(bytes)?;
    let page_size = header.page_size;
    let file_bytes = bytes.len();
    let pages_in_file = page_size.map(|size| file_bytes.div_ceil(size));
    let full_pages = page_size.map(|size| file_bytes / size);
    let size_is_multiple = page_size.is_some_and(|size| file_bytes % size == 0);
    // The in-header database size is only authoritative when the change
    // counter matches the version-valid-for counter.
    let in_header_valid = header.change_counter == header.version_valid_for;

    let mut flags = Vec::new();
    if !header.magic_ok {
        flags.push("bad_magic");
    }
    if page_size.is_none() {
        flags.push("bad_page_size");
    }
    if header.max_payload_fraction != 64
        || header.min_payload_fraction != 32
        || header.leaf_payload_fraction != 32
    {
        flags.push("bad_payload_fractions");
    }
    if page_size.is_some() && header.reserved as usize > page_size.unwrap() - 480 {
        flags.push("reserved_space_too_large");
    }
    if !header.reserved_tail_zero {
        flags.push("reserved_tail_nonzero");
    }
    if !(1..=4).contains(&header.schema_format) {
        flags.push("unusual_schema_format");
    }
    if !(1..=3).contains(&header.text_encoding) {
        flags.push("unknown_text_encoding");
    }
    if let Some(size) = page_size {
        if file_bytes > size && !size_is_multiple {
            flags.push("trailing_partial_page");
        }
        if in_header_valid && header.db_size_pages != 0 {
            let expected = header.db_size_pages as usize * size;
            if expected != file_bytes {
                flags.push("db_size_mismatch");
            }
        }
    }
    if file_bytes < page_size.unwrap_or(512) {
        flags.push("short_first_page");
    }

    let usable = page_size.map(|size| size.saturating_sub(header.reserved as usize));
    if page_size.is_some() {
        // Cross-check the freelist numbers we can sanity check cheaply.
        let db = Db { bytes, header };
        let (trunks, broken) = db.freelist_trunks(report);
        let counted: u64 = trunks
            .iter()
            .map(|t| t.declared_leaves.min(t.leaves.len()) as u64 + 1)
            .sum();
        return Ok(json!({
            "schema_version": 1,
            "kind": "sqlite3",
            "byteLength": file_bytes,
            "header": header_json(&db.header),
            "pages": {
                "pageSize": page_size,
                "usableBytes": usable,
                "pagesInFile": pages_in_file,
                "fullPages": full_pages,
                "fileSizeIsMultiple": size_is_multiple,
                "inHeaderSizePages": db.header.db_size_pages,
                "inHeaderSizeValid": in_header_valid,
            },
            "journalMode": db.header.journal_mode(),
            "freelist": {
                "firstTrunkPage": db.header.first_freelist_trunk,
                "declaredFreePages": db.header.freelist_page_count,
                "countedPages": counted,
                "trunkPages": trunks.len(),
                "countMatchesDeclared": counted == db.header.freelist_page_count as u64,
                "broken": broken,
            },
            "flags": flags,
            "warnings": report.warnings,
        }));
    }

    // Header itself is suspect; still report what decoded.
    if !header.magic_ok {
        report.warn("SQLite magic mismatch — header fields are best-effort");
    }
    Ok(json!({
        "schema_version": 1,
        "kind": if header.magic_ok { "sqlite3" } else { "unknown" },
        "byteLength": file_bytes,
        "header": header_json(&header),
        "journalMode": header.journal_mode(),
        "flags": flags,
        "warnings": report.warnings,
    }))
}

fn header_json(header: &Header) -> Value {
    json!({
        "magicOk": header.magic_ok,
        "pageSizeField": header.page_size_field,
        "pageSize": header.page_size,
        "writeVersion": header.write_version,
        "readVersion": header.read_version,
        "reservedBytesPerPage": header.reserved,
        "payloadFractions": {
            "maxEmbedded": header.max_payload_fraction,
            "minEmbedded": header.min_payload_fraction,
            "leaf": header.leaf_payload_fraction,
            "valid": header.max_payload_fraction == 64
                && header.min_payload_fraction == 32
                && header.leaf_payload_fraction == 32,
        },
        "fileChangeCounter": header.change_counter,
        "databaseSizePages": header.db_size_pages,
        "firstFreelistTrunkPage": header.first_freelist_trunk,
        "freelistPageCount": header.freelist_page_count,
        "schemaCookie": header.schema_cookie,
        "schemaFormat": header.schema_format,
        "defaultCacheSize": header.default_cache_size,
        "largestRootBtreePage": header.largest_root_page,
        "autovacuum": header.largest_root_page != 0,
        "incrementalVacuum": header.incremental_vacuum != 0,
        "textEncoding": {
            "code": header.text_encoding,
            "name": header.encoding_name(),
        },
        "userVersion": header.user_version,
        "applicationId": header.application_id,
        "reservedTailZero": header.reserved_tail_zero,
        "versionValidFor": header.version_valid_for,
        "sqliteVersionNumber": header.sqlite_version,
    })
}
