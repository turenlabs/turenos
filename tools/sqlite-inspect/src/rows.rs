//! `sqlite_rows`: decode rows of one named table's root b-tree in key order
//! (rowid order for rowid tables; PK order for WITHOUT ROWID index b-trees).
//! Row caps apply before decode; blobs are hashed + previewed, never inlined.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::db::{index_cell, read_payload, table_leaf_cell, walk_table_btree, BtreeKind, BtreePage, Db};
use crate::record;
use crate::schema::schema_rows;
use crate::{Report, DEFAULT_BLOB_PREVIEW, DEFAULT_ROWS, MAX_BLOB_PREVIEW, MAX_ROWS};

#[derive(Deserialize)]
pub(crate) struct RowsOptions {
    #[serde(default)]
    table: Option<String>,
    #[serde(default, alias = "max_rows", alias = "maxRows")]
    max_rows: Option<usize>,
    #[serde(
        default,
        alias = "blob_preview_bytes",
        alias = "blobPreviewBytes",
        alias = "include_blobs_preview",
        alias = "includeBlobsPreview"
    )]
    blob_preview: Option<usize>,
}

/// Best-effort column-name extraction from a `CREATE TABLE` statement.
/// Returns `None` when the parenthesized column list cannot be isolated or a
/// name cannot be read; callers treat this as unknown, not corrupt.
fn parse_column_names(sql: &str) -> Option<Vec<String>> {
    let open = sql.find('(')?;
    let mut depth = 0i32;
    let mut close = None;
    let mut in_quote: Option<u8> = None;
    for (i, byte) in sql.bytes().enumerate().skip(open) {
        if let Some(q) = in_quote {
            if byte == q {
                in_quote = None;
            }
            continue;
        }
        match byte {
            b'\'' | b'"' | b'`' => in_quote = Some(byte),
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    close = Some(i);
                    break;
                }
            }
            _ => {}
        }
    }
    let close = close?;
    let inner = &sql[open + 1..close];
    // Split top-level commas (paren depth 0, outside quotes).
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut in_quote: Option<u8> = None;
    let mut start = 0usize;
    for (i, byte) in inner.bytes().enumerate() {
        if let Some(q) = in_quote {
            if byte == q {
                in_quote = None;
            }
            continue;
        }
        match byte {
            b'\'' | b'"' | b'`' => in_quote = Some(byte),
            b'(' => depth += 1,
            b')' => depth -= 1,
            b',' if depth == 0 => {
                parts.push(&inner[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&inner[start..]);
    const CONSTRAINTS: [&str; 6] =
        ["CONSTRAINT", "PRIMARY", "FOREIGN", "UNIQUE", "CHECK", "EXCLUDE"];
    let mut names = Vec::new();
    for part in parts {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }
        let first = trimmed
            .split(|c: char| c.is_whitespace() || c == '(')
            .next()?;
        let upper = first.to_uppercase();
        if CONSTRAINTS.contains(&upper.as_str()) {
            continue;
        }
        let name = first
            .trim_matches(|c| matches!(c, '"' | '`' | '\'' | '[' | ']'))
            .to_string();
        if name.is_empty() {
            return None;
        }
        names.push(name);
    }
    if names.is_empty() {
        None
    } else {
        Some(names)
    }
}

pub(crate) fn rows(
    bytes: &[u8],
    options: &RowsOptions,
    report: &mut Report,
) -> Result<Value, &'static str> {
    let Some(table) = &options.table else {
        return Err("missing_table");
    };
    let max_rows = options.max_rows.unwrap_or(DEFAULT_ROWS).clamp(1, MAX_ROWS);
    let blob_preview = options
        .blob_preview
        .unwrap_or(DEFAULT_BLOB_PREVIEW)
        .min(MAX_BLOB_PREVIEW);
    let db = Db::parse(bytes)?;
    if !db.header.magic_ok {
        report.warn("SQLite magic mismatch — parsing best-effort");
    }
    let schema = schema_rows(&db, report);
    let Some(row) = schema.iter().find(|row| row.name == *table) else {
        return Err("table_not_found");
    };
    if row.kind != "table" || row.rootpage == 0 {
        return Err("not_a_table");
    }
    let root = u32::try_from(row.rootpage).map_err(|_| "page_out_of_range")?;
    let columns = parse_column_names(&row.sql);
    let sql_says_without_rowid = row.sql.to_uppercase().contains("WITHOUT ROWID");

    let mut out_rows = Vec::new();
    let mut corrupt_cells = 0usize;
    // The leaf closure cannot borrow `report` (the walk holds it); buffer
    // warnings locally and merge afterwards.
    let mut warns: Vec<String> = Vec::new();
    let mut hit_cap = false;
    let stats = {
        let warns = &mut warns;
        walk_table_btree(&db, root, report, |page, offset| {
            if out_rows.len() >= max_rows {
                hit_cap = true;
                return false;
            }
            let btree = BtreePage::parse(page);
            match btree.map(|b| b.kind) {
                Some(BtreeKind::LeafTable) => {
                    let cell = match table_leaf_cell(&db, page, offset) {
                        Ok(cell) => cell,
                        Err(code) => {
                            corrupt_cells += 1;
                            warns.push(format!(
                                "row cell at page {} offset {}: {}",
                                page.number, offset, code
                            ));
                            return true;
                        }
                    };
                    let mut inner = Report::new();
                    let payload = match read_payload(
                        &db,
                        cell.local,
                        cell.overflow_page,
                        cell.payload_size,
                        &mut inner,
                    ) {
                        Ok(p) => p,
                        Err(code) => {
                            corrupt_cells += 1;
                            warns.push(format!(
                                "row payload at page {} offset {}: {}",
                                page.number, offset, code
                            ));
                            warns.extend(inner.warnings);
                            return true;
                        }
                    };
                    match record::decode_record(&db, &payload.bytes, blob_preview, &mut inner) {
                        Ok(values) => out_rows.push(json!({
                            "rowid": cell.rowid,
                            "page": page.number,
                            "values": values,
                            "overflowPages": payload.overflow_pages,
                            "payloadTruncated": payload.truncated || !payload.complete,
                        })),
                        Err(code) => {
                            corrupt_cells += 1;
                            warns.push(format!(
                                "row record at page {} offset {}: {}",
                                page.number, offset, code
                            ));
                        }
                    }
                    warns.extend(inner.warnings);
                }
                Some(BtreeKind::LeafIndex) => {
                    let cell = match index_cell(&db, page, offset, false) {
                        Ok(cell) => cell,
                        Err(code) => {
                            corrupt_cells += 1;
                            warns.push(format!(
                                "index cell at page {} offset {}: {}",
                                page.number, offset, code
                            ));
                            return true;
                        }
                    };
                    let mut inner = Report::new();
                    let payload = match read_payload(
                        &db,
                        cell.local,
                        cell.overflow_page,
                        cell.payload_size,
                        &mut inner,
                    ) {
                        Ok(p) => p,
                        Err(code) => {
                            corrupt_cells += 1;
                            warns.push(format!(
                                "index payload at page {} offset {}: {}",
                                page.number, offset, code
                            ));
                            warns.extend(inner.warnings);
                            return true;
                        }
                    };
                    match record::decode_record(&db, &payload.bytes, blob_preview, &mut inner) {
                        Ok(values) => out_rows.push(json!({
                            "rowid": Value::Null,
                            "page": page.number,
                            "values": values,
                            "overflowPages": payload.overflow_pages,
                            "payloadTruncated": payload.truncated || !payload.complete,
                        })),
                        Err(code) => {
                            corrupt_cells += 1;
                            warns.push(format!(
                                "index record at page {} offset {}: {}",
                                page.number, offset, code
                            ));
                        }
                    }
                    warns.extend(inner.warnings);
                }
                _ => {
                    warns.push(format!("page {} is not a leaf b-tree page", page.number));
                }
            }
            true
        })
    };
    for w in warns {
        report.warn(w);
    }
    if hit_cap {
        report.truncated = true;
    }

    let without_rowid = stats.index_tree || sql_says_without_rowid;
    Ok(json!({
        "schema_version": 1,
        "kind": "sqlite3-rows",
        "byteLength": bytes.len(),
        "magicOk": db.header.magic_ok,
        "table": row.name,
        "rootpage": row.rootpage,
        "withoutRowid": without_rowid,
        "withoutRowidNote": if without_rowid {
            "index b-tree key order: PRIMARY KEY columns first, then remaining columns in CREATE TABLE order"
        } else {
            ""
        },
        "columnNames": columns,
        "rowCount": out_rows.len(),
        "maxRows": max_rows,
        "rows": out_rows,
        "corruptCells": corrupt_cells,
        "corruptPages": stats.corrupt_pages,
        "cycles": stats.cycles,
        "truncated": report.truncated,
        "warnings": report.warnings,
    }))
}
