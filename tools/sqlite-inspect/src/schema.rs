//! `sqlite_schema`: walk the sqlite_master b-tree rooted at page 1 (the
//! b-tree header sits at offset 100 on that page) and emit every schema
//! record. Also provides the shared schema-row collector used by
//! `sqlite_table_stats` and `sqlite_rows` to resolve table names.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::db::{read_payload, walk_table_btree, BtreePage, Db};
use crate::record;
use crate::{Report, MAX_ITEMS, MAX_SQL_TEXT};

#[derive(Deserialize)]
pub(crate) struct SchemaOptions {
    #[serde(default, alias = "max_items", alias = "maxItems")]
    max_items: Option<usize>,
}

/// One decoded sqlite_master row.
pub(crate) struct SchemaRow {
    pub kind: String,
    pub name: String,
    pub tbl_name: String,
    pub rootpage: i64,
    pub sql: String,
    /// Text columns failed to decode losslessly.
    pub partial: bool,
}

/// Collect all sqlite_master records (page 1 b-tree, table-kind). Corrupt
/// cells are skipped with warnings; decoding never aborts the walk.
pub(crate) fn schema_rows(db: &Db, report: &mut Report) -> Vec<SchemaRow> {
    let mut rows = Vec::new();
    // The leaf closure cannot borrow `report` (the walk holds it), so
    // warnings go to a local buffer merged after the walk.
    let mut warns: Vec<String> = Vec::new();
    let mut hit_cap = false;
    {
        let warns = &mut warns;
        walk_table_btree(db, 1, report, |page, offset| {
            if rows.len() >= MAX_ITEMS {
                hit_cap = true;
                return false;
            }
            let cell = match crate::db::table_leaf_cell(db, page, offset) {
                Ok(cell) => cell,
                Err(code) => {
                    warns.push(format!(
                        "sqlite_master cell at page {} offset {}: {}",
                        page.number, offset, code
                    ));
                    return true;
                }
            };
            let mut inner = Report::new();
            let payload = match read_payload(
                db,
                cell.local,
                cell.overflow_page,
                cell.payload_size,
                &mut inner,
            ) {
                Ok(p) => p,
                Err(code) => {
                    warns.push(format!(
                        "sqlite_master payload at page {} offset {}: {}",
                        page.number, offset, code
                    ));
                    warns.extend(inner.warnings);
                    return true;
                }
            };
            let values = match record::decode_record(db, &payload.bytes, 0, &mut inner) {
                Ok(v) => v,
                Err(code) => {
                    warns.push(format!(
                        "sqlite_master record at page {} offset {}: {}",
                        page.number, offset, code
                    ));
                    warns.extend(inner.warnings);
                    return true;
                }
            };
            warns.extend(inner.warnings);
            rows.push(schema_row(&values));
            true
        });
    }
    for w in warns {
        report.warn(w);
    }
    if hit_cap {
        report.truncated = true;
    }
    rows
}

fn text_of(value: &Value) -> String {
    let text = value.get("value").and_then(Value::as_str).unwrap_or("");
    if text.len() <= MAX_SQL_TEXT {
        return text.to_string();
    }
    // Truncate at a UTF-8 boundary.
    let mut end = MAX_SQL_TEXT;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

fn schema_row(values: &[Value]) -> SchemaRow {
    let get = |i: usize| values.get(i).cloned().unwrap_or(json!({"type": "null"}));
    let int_of = |v: &Value| v.get("value").and_then(Value::as_i64).unwrap_or(0);
    let partial = values.iter().any(|v| v.get("lossless") == Some(&json!(false)));
    SchemaRow {
        kind: text_of(&get(0)),
        name: text_of(&get(1)),
        tbl_name: text_of(&get(2)),
        rootpage: int_of(&get(3)),
        sql: text_of(&get(4)),
        partial,
    }
}

pub(crate) fn schema(
    bytes: &[u8],
    options: &SchemaOptions,
    report: &mut Report,
) -> Result<Value, &'static str> {
    let db = Db::parse(bytes)?;
    let max_items = options.max_items.unwrap_or(MAX_ITEMS).clamp(1, MAX_ITEMS);
    if !db.header.magic_ok {
        report.warn("SQLite magic mismatch — parsing best-effort");
    }
    let root_kind = db
        .page(1)
        .and_then(|p| BtreePage::parse(&p))
        .map(|b| b.kind);
    let mut rows_all = schema_rows(&db, report);
    let total = rows_all.len();
    let truncated = report.truncated || total > max_items;
    if truncated {
        report.truncated = true;
        report.warn(format!("schema list capped at {max_items} items"));
    }
    rows_all.truncate(max_items);
    let records: Vec<Value> = rows_all
        .iter()
        .map(|row| {
            json!({
                "type": row.kind,
                "name": row.name,
                "tblName": row.tbl_name,
                "rootpage": row.rootpage,
                "sql": row.sql,
                "partialDecode": row.partial,
            })
        })
        .collect();
    Ok(json!({
        "schema_version": 1,
        "kind": "sqlite3-schema",
        "byteLength": bytes.len(),
        "magicOk": db.header.magic_ok,
        "rootPageKind": root_kind.map(|k| k.name()),
        "recordCount": records.len(),
        "totalRecords": total,
        "records": records,
        "truncated": report.truncated || truncated,
        "warnings": report.warnings,
    }))
}
