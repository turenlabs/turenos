//! `sqlite_freelist`: walk the freelist trunk-page chain. Each trunk page
//! holds a next-trunk pointer, a leaf count, and leaf page pointers; pages
//! referenced but out of range, cycles, and mismatched totals are reported.
//! Also reports how many bytes are potentially carvable: freelist leaf pages
//! are whole stale pages, and trunk pages have unused tails.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::db::Db;
use crate::{Report, MAX_ITEMS};

#[derive(Deserialize)]
pub(crate) struct FreelistOptions {
    #[serde(default, alias = "max_items", alias = "maxItems")]
    max_items: Option<usize>,
    /// Include the full leaf-page pointer list per trunk (default true).
    #[serde(default, alias = "include_leaves", alias = "includeLeaves")]
    include_leaves: Option<bool>,
}

pub(crate) fn freelist(
    bytes: &[u8],
    options: &FreelistOptions,
    report: &mut Report,
) -> Result<Value, &'static str> {
    let db = Db::parse(bytes)?;
    if !db.header.magic_ok {
        report.warn("SQLite magic mismatch — parsing best-effort");
    }
    let include_leaves = options.include_leaves.unwrap_or(true);
    let max_items = options.max_items.unwrap_or(MAX_ITEMS).clamp(1, MAX_ITEMS);
    let (trunks, mut broken) = db.freelist_trunks(report);
    let pages_in_file = db.pages_in_file();
    let usable = db.usable_size();

    let mut trunk_json = Vec::new();
    let mut leaf_total: u64 = 0;
    let mut leaf_bytes: u64 = 0;
    let mut trunk_unused: u64 = 0;
    let mut invalid_leaf_pages: Vec<u32> = Vec::new();
    for trunk in &trunks {
        leaf_total += trunk.leaves.len() as u64;
        // Unused trunk tail: everything after [next:u32][count:u32][leaves].
        let used = 8 + trunk.leaves.len().saturating_mul(4);
        if usable > used {
            trunk_unused += (usable - used) as u64;
        }
        for leaf in &trunk.leaves {
            if *leaf == 0 || *leaf > pages_in_file {
                invalid_leaf_pages.push(*leaf);
                broken = true;
            } else {
                leaf_bytes += usable as u64;
            }
        }
        if trunk_json.len() < max_items {
            trunk_json.push(json!({
                "page": trunk.page,
                "nextTrunk": trunk.next,
                "declaredLeafCount": trunk.declared_leaves,
                "leafPages": if include_leaves {
                    json!(trunk.leaves)
                } else {
                    json!(trunk.leaves.len())
                },
            }));
        }
    }
    if trunks.len() > max_items {
        report.truncated = true;
    }
    let counted = leaf_total + trunks.len() as u64;
    let declared = db.header.freelist_page_count as u64;
    if counted != declared {
        report.warn(format!(
            "freelist page count mismatch: header declares {declared}, chain contains {counted}"
        ));
    }
    Ok(json!({
        "schema_version": 1,
        "kind": "sqlite3-freelist",
        "byteLength": bytes.len(),
        "magicOk": db.header.magic_ok,
        "firstTrunkPage": db.header.first_freelist_trunk,
        "declaredFreePages": declared,
        "countedFreePages": counted,
        "countMatchesDeclared": counted == declared,
        "trunkCount": trunks.len(),
        "trunks": trunk_json,
        "invalidLeafPages": invalid_leaf_pages,
        "broken": broken,
        // Forensic value: bytes available to carve on free pages — every
        // valid freelist leaf page's usable area plus each trunk's unused
        // tail.
        "carving": {
            "freelistLeafBytes": leaf_bytes,
            "trunkUnusedBytes": trunk_unused,
            "totalCarvableBytes": leaf_bytes + trunk_unused,
            "usableBytesPerPage": usable,
        },
        "truncated": report.truncated,
        "warnings": report.warnings,
    }))
}
