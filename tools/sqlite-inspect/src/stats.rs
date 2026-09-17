//! `sqlite_table_stats`: walk each table's root b-tree (or one named table)
//! and report page counts by type, overflow pages, row count, depth, and
//! min/max rowid. Cycles and corrupt pages are reported, never fatal.

use std::collections::HashSet;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::db::{index_cell, table_leaf_cell, walk_table_btree, BtreePage, Db};
use crate::schema::schema_rows;
use crate::{Report, MAX_ITEMS, MAX_OVERFLOW_PAGES};

#[derive(Deserialize)]
pub(crate) struct TableStatsOptions {
    #[serde(default)]
    table: Option<String>,
    #[serde(default, alias = "max_items", alias = "maxItems")]
    max_items: Option<usize>,
}

/// Count the overflow pages reachable from `first`, bounds- and
/// cycle-checked against the database.
fn count_overflow(db: &Db, first: u32, visited: &mut HashSet<u32>) -> usize {
    let mut count = 0usize;
    let mut next = first;
    while next != 0 && count < MAX_OVERFLOW_PAGES {
        if !visited.insert(next) {
            break;
        }
        let Some(page) = db.page(next) else {
            break;
        };
        let usable = page.usable();
        if usable.len() < 4 {
            break;
        }
        next = crate::u32_be(usable, 0);
        count += 1;
    }
    count
}

fn table_stats_json(
    db: &Db,
    name: &str,
    rootpage: i64,
    sql: &str,
    report: &mut Report,
) -> Value {
    let root = u32::try_from(rootpage).unwrap_or(u32::MAX);
    let mut overflow_pages = 0usize;
    let mut overflow_seen: HashSet<u32> = HashSet::new();
    let mut cells_with_overflow = 0usize;
    let mut corrupt_cells = 0usize;
    let stats = walk_table_btree(db, root, report, |page, offset| {
        let btree = BtreePage::parse(page);
        let is_index = btree.is_some_and(|b| b.kind.is_index());
        let result = if is_index {
            index_cell(db, page, offset, false).map(|c| (c.payload_size, c.overflow_page))
        } else {
            table_leaf_cell(db, page, offset).map(|c| (c.payload_size, c.overflow_page))
        };
        match result {
            Ok((_, overflow_page)) if overflow_page != 0 => {
                cells_with_overflow += 1;
                overflow_pages += count_overflow(db, overflow_page, &mut overflow_seen);
            }
            Ok(_) => {}
            Err(_) => corrupt_cells += 1,
        }
        true
    });
    json!({
        "table": name,
        "rootpage": rootpage,
        "withoutRowid": stats.index_tree || sql.to_uppercase().contains("WITHOUT ROWID"),
        "pages": {
            "total": stats.leaf_pages + stats.interior_pages,
            "interior": stats.interior_pages,
            "leaf": stats.leaf_pages,
            "overflow": overflow_pages,
        },
        "rows": stats.leaf_cells,
        "depth": stats.depth,
        "rowid": {
            "min": stats.min_rowid,
            "max": stats.max_rowid,
        },
        "cellsWithOverflow": cells_with_overflow,
        "fragmentedFreeBytes": stats.fragmented_free_bytes,
        "corruptCells": corrupt_cells,
        "corruptPages": stats.corrupt_pages,
        "cycles": stats.cycles,
        "brokenChildren": stats.broken_children,
        "corrupt": !stats.corrupt_pages.is_empty()
            || !stats.cycles.is_empty()
            || corrupt_cells > 0
            || stats.broken_children > 0,
    })
}

pub(crate) fn table_stats(
    bytes: &[u8],
    options: &TableStatsOptions,
    report: &mut Report,
) -> Result<Value, &'static str> {
    let db = Db::parse(bytes)?;
    if !db.header.magic_ok {
        report.warn("SQLite magic mismatch — parsing best-effort");
    }
    let rows = schema_rows(&db, report);
    let tables: Vec<&crate::schema::SchemaRow> = rows
        .iter()
        .filter(|row| row.kind == "table" && row.rootpage != 0)
        .collect();
    if let Some(name) = &options.table {
        let Some(row) = rows.iter().find(|row| row.name == *name) else {
            return Err("table_not_found");
        };
        if row.kind != "table" || row.rootpage == 0 {
            return Err("not_a_table");
        }
        let stats = table_stats_json(&db, &row.name, row.rootpage, &row.sql, report);
        return Ok(json!({
            "schema_version": 1,
            "kind": "sqlite3-table-stats",
            "byteLength": bytes.len(),
            "magicOk": db.header.magic_ok,
            "tables": [stats],
            "tableCount": 1,
            "warnings": report.warnings,
        }));
    }
    let max_items = options.max_items.unwrap_or(MAX_ITEMS).clamp(1, MAX_ITEMS);
    let mut out = Vec::new();
    for row in tables.iter().take(max_items) {
        out.push(table_stats_json(&db, &row.name, row.rootpage, &row.sql, report));
    }
    if tables.len() > max_items {
        report.truncated = true;
        report.warn(format!("table stats capped at {max_items} tables"));
    }
    Ok(json!({
        "schema_version": 1,
        "kind": "sqlite3-table-stats",
        "byteLength": bytes.len(),
        "magicOk": db.header.magic_ok,
        "tables": out,
        "tableCount": tables.len(),
        "truncated": report.truncated,
        "warnings": report.warnings,
    }))
}
