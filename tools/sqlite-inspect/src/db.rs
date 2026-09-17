//! SQLite 3 database file model: 100-byte header decode, page access,
//! b-tree page headers, cell layout, overflow chains, free regions, and
//! bounded b-tree traversal. All offsets are bounds-checked; every page
//! chain is cycle-guarded.

use std::collections::HashSet;

use crate::{u16_be, u32_be, varint, Report};

/// Decoded database header (first 100 bytes).
pub(crate) struct Header {
    pub magic_ok: bool,
    /// Raw page-size field at offset 16 (value 1 means 65536).
    pub page_size_field: u16,
    /// Effective page size in bytes, when a usable power of two.
    pub page_size: Option<usize>,
    pub write_version: u8,
    pub read_version: u8,
    /// Reserved bytes at the end of every page (usually 0).
    pub reserved: u8,
    pub max_payload_fraction: u8,
    pub min_payload_fraction: u8,
    pub leaf_payload_fraction: u8,
    pub change_counter: u32,
    /// In-header database size in pages; only authoritative when
    /// `version_valid_for == change_counter`.
    pub db_size_pages: u32,
    pub first_freelist_trunk: u32,
    pub freelist_page_count: u32,
    pub schema_cookie: u32,
    pub schema_format: u32,
    pub default_cache_size: u32,
    /// Largest root b-tree page when auto/incremental vacuum is enabled.
    pub largest_root_page: u32,
    /// 1 = UTF-8, 2 = UTF-16le, 3 = UTF-16be.
    pub text_encoding: u32,
    pub user_version: u32,
    pub incremental_vacuum: u32,
    pub application_id: u32,
    /// Bytes 72..92 are reserved and must be zero.
    pub reserved_tail_zero: bool,
    pub version_valid_for: u32,
    pub sqlite_version: u32,
}

impl Header {
    pub fn parse(bytes: &[u8]) -> Result<Header, &'static str> {
        if bytes.len() < 100 {
            return Err("not_sqlite");
        }
        let page_size_field = u16_be(bytes, 16);
        let raw = if page_size_field == 1 {
            65536usize
        } else {
            page_size_field as usize
        };
        let page_size = if (512..=65536).contains(&raw) && raw.is_power_of_two() {
            Some(raw)
        } else {
            None
        };
        Ok(Header {
            magic_ok: &bytes[..16] == b"SQLite format 3\0",
            page_size_field,
            page_size,
            write_version: bytes[18],
            read_version: bytes[19],
            reserved: bytes[20],
            max_payload_fraction: bytes[21],
            min_payload_fraction: bytes[22],
            leaf_payload_fraction: bytes[23],
            change_counter: u32_be(bytes, 24),
            db_size_pages: u32_be(bytes, 28),
            first_freelist_trunk: u32_be(bytes, 32),
            freelist_page_count: u32_be(bytes, 36),
            schema_cookie: u32_be(bytes, 40),
            schema_format: u32_be(bytes, 44),
            default_cache_size: u32_be(bytes, 48),
            largest_root_page: u32_be(bytes, 52),
            text_encoding: u32_be(bytes, 56),
            user_version: u32_be(bytes, 60),
            incremental_vacuum: u32_be(bytes, 64),
            application_id: u32_be(bytes, 68),
            reserved_tail_zero: bytes[72..92].iter().all(|b| *b == 0),
            version_valid_for: u32_be(bytes, 92),
            sqlite_version: u32_be(bytes, 96),
        })
    }

    pub fn encoding_name(&self) -> &'static str {
        match self.text_encoding {
            1 => "utf-8",
            2 => "utf-16le",
            3 => "utf-16be",
            _ => "unknown",
        }
    }

    /// Journal mode implied by the file-format write/read versions.
    pub fn journal_mode(&self) -> &'static str {
        match (self.write_version, self.read_version) {
            (1, 1) => "rollback",
            (2, 2) => "wal",
            _ => "unknown",
        }
    }
}

/// Opened database: header plus page access.
pub(crate) struct Db<'a> {
    pub bytes: &'a [u8],
    pub header: Header,
}

/// One database page (full `page_size` slice; callers respect `usable_end`).
pub(crate) struct Page<'a> {
    pub number: u32,
    /// Bytes of the whole page (`page_size` long, or less for a short tail
    /// page — the file may not be a clean multiple of the page size).
    pub data: &'a [u8],
    /// Offset of the b-tree page header within `data` (100 for page 1).
    pub btree_offset: usize,
    /// Usable end within `data`: `page_size - reserved`.
    pub usable_end: usize,
}

impl<'a> Page<'a> {
    /// Page content between the b-tree header region and the usable end —
    /// i.e. the area where cells, the cell pointer array, freeblocks, and
    /// the unallocated gap all live.
    pub fn usable(&self) -> &'a [u8] {
        &self.data[..self.usable_end.min(self.data.len())]
    }
}

impl<'a> Db<'a> {
    /// Parse the header. Magic is a validity flag, not a gate — a corrupt
    /// magic still yields a parseable file when the page size is sane.
    pub fn parse(bytes: &'a [u8]) -> Result<Db<'a>, &'static str> {
        let header = Header::parse(bytes)?;
        if header.page_size.is_none() {
            return Err("invalid_page_size");
        }
        Ok(Db { bytes, header })
    }

    pub fn page_size(&self) -> usize {
        self.header.page_size.unwrap_or(65536)
    }

    /// Usable bytes per page (page size minus reserved space).
    pub fn usable_size(&self) -> usize {
        self.page_size().saturating_sub(self.header.reserved as usize)
    }

    /// Number of complete or partial pages present in the file.
    pub fn pages_in_file(&self) -> u32 {
        let size = self.page_size();
        self.bytes.len().div_ceil(size) as u32
    }

    /// Fetch page `number` (1-based). `None` when it lies outside the file
    /// or overflows the 32-bit page-number space.
    pub fn page(&self, number: u32) -> Option<Page<'a>> {
        if number == 0 || number > self.pages_in_file() {
            return None;
        }
        let size = self.page_size();
        let start = (number as usize - 1).checked_mul(size)?;
        let end = (start + size).min(self.bytes.len());
        Some(Page {
            number,
            data: &self.bytes[start..end],
            btree_offset: if number == 1 { 100 } else { 0 },
            usable_end: self.usable_size(),
        })
    }

    /// Collect the freelist trunk chain: `(trunk page, next trunk, leaf
    /// pointers)`. Cycle-guarded; stops and flags on invalid links.
    pub fn freelist_trunks(&self, report: &mut Report) -> (Vec<TrunkPage>, bool) {
        let mut trunks = Vec::new();
        let mut visited = HashSet::new();
        let mut broken = false;
        let mut next = self.header.first_freelist_trunk;
        while next != 0 {
            if trunks.len() >= crate::MAX_ITEMS {
                report.warn("freelist trunk chain hit the item cap");
                report.truncated = true;
                break;
            }
            if !visited.insert(next) {
                report.warn(format!("freelist trunk cycle at page {next}"));
                broken = true;
                break;
            }
            let Some(page) = self.page(next) else {
                report.warn(format!("freelist trunk page {next} out of range"));
                broken = true;
                break;
            };
            let usable = page.usable();
            if usable.len() < 8 {
                report.warn(format!("freelist trunk page {next} too short"));
                broken = true;
                break;
            }
            let following = u32_be(usable, 0);
            let leaf_count = u32_be(usable, 4) as usize;
            let capacity = usable.len().saturating_sub(8) / 4;
            if leaf_count > capacity {
                report.warn(format!(
                    "freelist trunk page {next} declares {leaf_count} leaves, capacity {capacity}"
                ));
                broken = true;
            }
            let take = leaf_count.min(capacity);
            let mut leaves = Vec::with_capacity(take.min(1024));
            for i in 0..take {
                leaves.push(u32_be(usable, 8 + i * 4));
            }
            trunks.push(TrunkPage {
                page: next,
                next: following,
                declared_leaves: leaf_count,
                leaves,
            });
            next = following;
        }
        (trunks, broken)
    }
}

pub(crate) struct TrunkPage {
    pub page: u32,
    pub next: u32,
    pub declared_leaves: usize,
    pub leaves: Vec<u32>,
}

/// B-tree page kinds.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum BtreeKind {
    InteriorIndex, // 2
    InteriorTable, // 5
    LeafIndex,     // 10
    LeafTable,     // 13
}

impl BtreeKind {
    pub fn name(self) -> &'static str {
        match self {
            BtreeKind::InteriorIndex => "interior-index",
            BtreeKind::InteriorTable => "interior-table",
            BtreeKind::LeafIndex => "leaf-index",
            BtreeKind::LeafTable => "leaf-table",
        }
    }

    pub fn is_index(self) -> bool {
        matches!(self, BtreeKind::InteriorIndex | BtreeKind::LeafIndex)
    }

    pub fn is_interior(self) -> bool {
        matches!(self, BtreeKind::InteriorIndex | BtreeKind::InteriorTable)
    }
}

/// Parsed b-tree page header.
pub(crate) struct BtreePage {
    pub kind: BtreeKind,
    /// Offset (from page start) of the first freeblock, 0 = none.
    pub first_freeblock: u16,
    pub cell_count: u16,
    /// Start of the cell content area; 0 on disk means 65536.
    pub content_start: usize,
    pub fragmented_free: u8,
    /// Right-most child pointer (interior pages only).
    pub right_pointer: u32,
    /// Header bytes: 12 interior, 8 leaf.
    pub header_len: usize,
}

impl BtreePage {
    /// Parse the b-tree header on `page`. Returns `None` when the type byte
    /// is not a b-tree kind or the page is too short.
    pub fn parse(page: &Page) -> Option<BtreePage> {
        let usable = page.usable();
        let base = page.btree_offset;
        if usable.len() < base + 8 {
            return None;
        }
        let kind = match usable[base] {
            2 => BtreeKind::InteriorIndex,
            5 => BtreeKind::InteriorTable,
            10 => BtreeKind::LeafIndex,
            13 => BtreeKind::LeafTable,
            _ => return None,
        };
        let header_len = if kind.is_interior() { 12 } else { 8 };
        if usable.len() < base + header_len {
            return None;
        }
        let raw_start = u16_be(usable, base + 5) as usize;
        let content_start = if raw_start == 0 { 65536 } else { raw_start };
        let right_pointer = if kind.is_interior() {
            u32_be(usable, base + 8)
        } else {
            0
        };
        Some(BtreePage {
            kind,
            first_freeblock: u16_be(usable, base + 1),
            cell_count: u16_be(usable, base + 3),
            content_start,
            fragmented_free: usable[base + 7],
            right_pointer,
            header_len,
        })
    }

    /// Cell content area start clamped into the usable region (a corrupt
    /// `content_start` below the pointer array is clamped so region math
    /// stays sane).
    pub fn content_start_clamped(&self, page: &Page) -> usize {
        self.content_start.min(page.usable().len())
    }

    /// Absolute page offset of cell pointer `index`; bounds-checked against
    /// the cell pointer array itself.
    pub fn cell_pointer(&self, page: &Page, index: usize, report: &mut Report) -> Option<u16> {
        if index >= self.cell_count as usize {
            return None;
        }
        let usable = page.usable();
        let at = page.btree_offset + self.header_len + index * 2;
        if at + 2 > usable.len() {
            report.warn(format!(
                "cell pointer {} at page {} lies outside the page",
                index, page.number
            ));
            return None;
        }
        Some(u16_be(usable, at))
    }
}

/// Maximum sane cell count for a page — every pointer is 2 bytes.
pub(crate) fn sane_cell_count(btree: &BtreePage, page: &Page) -> usize {
    let usable = page.usable();
    let capacity = usable
        .len()
        .saturating_sub(page.btree_offset + btree.header_len)
        / 2;
    (btree.cell_count as usize).min(capacity)
}

/// A decoded table-leaf cell: payload size, rowid, local payload bytes, and
/// the first overflow page (0 = none).
pub(crate) struct TableLeafCell<'a> {
    pub payload_size: u64,
    pub rowid: i64,
    pub local: &'a [u8],
    pub overflow_page: u32,
}

/// A decoded index cell (leaf or interior): optional child pointer, payload
/// size, local payload bytes, first overflow page.
pub(crate) struct IndexCell<'a> {
    pub child: Option<u32>,
    pub payload_size: u64,
    pub local: &'a [u8],
    pub overflow_page: u32,
}

/// Local-payload split per the file-format spec:
/// `U` usable size; table leaves use `X = U-35`, index cells use
/// `X = ((U-12)*64/255)-23`; `M = ((U-12)*32/255)-23`;
/// `K = M + (P-M) % (U-4)`; local is `P`, `K`, or `M`.
fn local_payload(payload: u64, usable: usize, index: bool) -> u64 {
    let u = usable as u64;
    if u <= 12 {
        return 0;
    }
    let min_local = ((u - 12) * 32 / 255).saturating_sub(23);
    let max_local = if index {
        ((u - 12) * 64 / 255).saturating_sub(23)
    } else {
        u.saturating_sub(35)
    };
    if payload <= max_local {
        return payload;
    }
    let spread = u.saturating_sub(4).max(1);
    let k = min_local + (payload - min_local) % spread;
    if k <= max_local {
        k
    } else {
        min_local
    }
}

/// Decode the table-leaf cell at `offset` within `page`. Bounds-checked;
/// `Err` marks the cell corrupt in the report.
pub(crate) fn table_leaf_cell<'a>(
    db: &Db<'a>,
    page: &'a Page<'a>,
    offset: usize,
) -> Result<TableLeafCell<'a>, &'static str> {
    let usable = page.usable();
    if offset >= usable.len() {
        return Err("cell_offset_out_of_range");
    }
    let (payload_size, n1) = varint(&usable[offset..]).ok_or("bad_varint")?;
    let (rowid, n2) = varint(&usable[offset + n1..]).ok_or("bad_varint")?;
    let local_len = local_payload(payload_size, db.usable_size(), false);
    let local_usize = local_len as usize;
    let rest = &usable[offset + n1 + n2..];
    let (local, overflow_page) = if payload_size <= local_len || rest.len() <= local_usize {
        // Entire payload is local (or the cell is truncated within the page).
        (&rest[..local_usize.min(rest.len())], 0)
    } else {
        if rest.len() < local_usize + 4 {
            return Err("cell_overflow_pointer_missing");
        }
        (&rest[..local_usize], u32_be(rest, local_usize))
    };
    Ok(TableLeafCell {
        payload_size,
        rowid: rowid as i64,
        local,
        overflow_page,
    })
}

/// Decode the index cell at `offset` within `page` (leaf or interior;
/// interior cells begin with a 4-byte child pointer).
pub(crate) fn index_cell<'a>(
    db: &Db<'a>,
    page: &'a Page<'a>,
    offset: usize,
    interior: bool,
) -> Result<IndexCell<'a>, &'static str> {
    let usable = page.usable();
    if offset >= usable.len() {
        return Err("cell_offset_out_of_range");
    }
    let mut cursor = offset;
    let child = if interior {
        if cursor + 4 > usable.len() {
            return Err("cell_child_pointer_missing");
        }
        let value = u32_be(usable, cursor);
        cursor += 4;
        Some(value)
    } else {
        None
    };
    let (payload_size, n) = varint(&usable[cursor..]).ok_or("bad_varint")?;
    cursor += n;
    let local_len = local_payload(payload_size, db.usable_size(), true);
    let local_usize = local_len as usize;
    let rest = &usable[cursor..];
    let (local, overflow_page) = if payload_size <= local_len || rest.len() <= local_usize {
        (&rest[..local_usize.min(rest.len())], 0)
    } else {
        if rest.len() < local_usize + 4 {
            return Err("cell_overflow_pointer_missing");
        }
        (&rest[..local_usize], u32_be(rest, local_usize))
    };
    Ok(IndexCell {
        child,
        payload_size,
        local,
        overflow_page,
    })
}

/// Follow an overflow chain and assemble the full payload. Every page is
/// bounds-checked and cycle-guarded; reports `complete`, the number of
/// overflow pages read, and flags truncation/corruption instead of failing.
pub(crate) struct Payload {
    pub bytes: Vec<u8>,
    pub overflow_pages: usize,
    /// Full declared payload was assembled.
    pub complete: bool,
    /// Assembly stopped early due to cap/cycle/bad link.
    pub truncated: bool,
}

pub(crate) fn read_payload(
    db: &Db,
    local: &[u8],
    overflow_page: u32,
    payload_size: u64,
    report: &mut Report,
) -> Result<Payload, &'static str> {
    if payload_size > crate::MAX_CELL_PAYLOAD {
        return Err("payload_too_large");
    }
    let want = payload_size as usize;
    let mut bytes = Vec::with_capacity(want.min(local.len() + 0x1_0000));
    bytes.extend_from_slice(&local[..local.len().min(want)]);
    let mut visited = HashSet::new();
    let mut next = overflow_page;
    let mut pages = 0usize;
    let mut truncated = false;
    while bytes.len() < want && next != 0 {
        if pages >= crate::MAX_OVERFLOW_PAGES {
            report.warn("overflow chain hit the page cap");
            truncated = true;
            break;
        }
        if !visited.insert(next) {
            report.warn(format!("overflow chain cycle at page {next}"));
            truncated = true;
            break;
        }
        let Some(page) = db.page(next) else {
            report.warn(format!("overflow page {next} out of range"));
            truncated = true;
            break;
        };
        let usable = page.usable();
        if usable.len() < 4 {
            report.warn(format!("overflow page {next} too short"));
            truncated = true;
            break;
        }
        next = u32_be(usable, 0);
        let take = (want - bytes.len()).min(usable.len() - 4);
        bytes.extend_from_slice(&usable[4..4 + take]);
        pages += 1;
    }
    if bytes.len() < want && !truncated {
        // Chain ended early but payload was declared larger.
        report.warn("payload incomplete: fewer bytes than the declared size");
        truncated = true;
    }
    Ok(Payload {
        complete: bytes.len() >= want,
        bytes,
        overflow_pages: pages,
        truncated,
    })
}

/// A byte range inside a page's usable area that may hold stale data.
pub(crate) struct FreeRegion {
    /// Page-relative offset (into `page.usable()`).
    pub offset: usize,
    pub len: usize,
    /// "unallocated" | "freeblock"
    pub kind: &'static str,
}

/// Enumerate a page's free regions for carving: the unallocated gap between
/// the cell pointer array and the cell content area, plus each freeblock's
/// body (its first 4 bytes are the chain header). Corrupt chains are
/// truncated and reported.
pub(crate) fn free_regions(
    page: &Page,
    btree: &BtreePage,
    report: &mut Report,
) -> Vec<FreeRegion> {
    let usable = page.usable();
    let mut regions = Vec::new();
    let pointer_end = page.btree_offset + btree.header_len + btree.cell_count as usize * 2;
    let content_start = btree.content_start_clamped(page);
    if content_start > pointer_end && pointer_end <= usable.len() {
        regions.push(FreeRegion {
            offset: pointer_end,
            len: content_start.min(usable.len()) - pointer_end,
            kind: "unallocated",
        });
    }
    // Freeblock chain: each block is [next:u16][size:u16][body..]; bodies are
    // stale cell bytes.
    let mut seen = HashSet::new();
    let mut at = btree.first_freeblock as usize;
    let mut blocks = 0usize;
    while at != 0 {
        if blocks >= 4096 {
            report.warn(format!("freeblock chain on page {} hit cap", page.number));
            break;
        }
        if at + 4 > usable.len() {
            report.warn(format!("freeblock at page {} offset {} out of range", page.number, at));
            break;
        }
        if !seen.insert(at) {
            report.warn(format!("freeblock cycle on page {} offset {}", page.number, at));
            break;
        }
        let next = u16_be(usable, at) as usize;
        let size = u16_be(usable, at + 2) as usize;
        if size < 4 || at + size > usable.len() {
            report.warn(format!(
                "freeblock at page {} offset {} has bad size {}",
                page.number, at, size
            ));
            break;
        }
        if size > 4 {
            regions.push(FreeRegion {
                offset: at + 4,
                len: size - 4,
                kind: "freeblock",
            });
        }
        blocks += 1;
        if next <= at && next != 0 {
            // Freeblocks must be strictly increasing; treat as corruption.
            report.warn(format!(
                "freeblock order violation on page {} offset {}",
                page.number, at
            ));
            break;
        }
        at = next;
    }
    regions
}

/// In-order traversal of a table b-tree (rowid order). `visit` receives each
/// leaf cell's page-relative offset; interior children and the right pointer
/// are followed in key order. Cycle-guarded via `visited`; corrupt pages and
/// cells are counted and reported, never fatal.
pub(crate) struct WalkStats {
    pub leaf_pages: usize,
    pub interior_pages: usize,
    pub leaf_cells: usize,
    pub depth: usize,
    pub corrupt_pages: Vec<u32>,
    pub cycles: Vec<u32>,
    /// Interior cells whose child pointer was out of range.
    pub broken_children: usize,
    pub min_rowid: Option<i64>,
    pub max_rowid: Option<i64>,
    /// Sum of fragmented free bytes reported by visited page headers.
    pub fragmented_free_bytes: u64,
    /// Index b-tree root (WITHOUT ROWID table) — rowids are absent.
    pub index_tree: bool,
}

/// Iterative in-order traversal. `leaf` is called with `(page, cell_offset)`
/// for every leaf cell; returning `false` stops early (row caps). Interior
/// children and the right pointer are followed in key order.
pub(crate) fn walk_table_btree<F>(
    db: &Db,
    root: u32,
    report: &mut Report,
    mut leaf: F,
) -> WalkStats
where
    F: FnMut(&Page, usize) -> bool,
{
    let mut stats = WalkStats {
        leaf_pages: 0,
        interior_pages: 0,
        leaf_cells: 0,
        depth: 0,
        corrupt_pages: Vec::new(),
        cycles: Vec::new(),
        broken_children: 0,
        min_rowid: None,
        max_rowid: None,
        fragmented_free_bytes: 0,
        index_tree: false,
    };
    // The root page's kind decides whether this is a rowid table b-tree or a
    // WITHOUT ROWID index b-tree.
    if let Some(page) = db.page(root) {
        if let Some(btree) = BtreePage::parse(&page) {
            stats.index_tree = btree.kind.is_index();
        }
    }
    let mut visited: HashSet<u32> = HashSet::new();
    // Stack of (page number, depth); root is depth 1.
    let mut stack: Vec<(u32, usize)> = vec![(root, 1)];
    let mut keep_going = true;
    while let Some((number, depth)) = stack.pop() {
        if !keep_going {
            break;
        }
        if !visited.insert(number) {
            stats.cycles.push(number);
            report.warn(format!("b-tree cycle at page {number}"));
            continue;
        }
        let Some(page) = db.page(number) else {
            report.warn(format!("b-tree page {number} out of range"));
            stats.corrupt_pages.push(number);
            stats.broken_children += 1;
            continue;
        };
        let Some(btree) = BtreePage::parse(&page) else {
            report.warn(format!("page {number} is not a b-tree page"));
            stats.corrupt_pages.push(number);
            continue;
        };
        stats.depth = stats.depth.max(depth);
        stats.fragmented_free_bytes += btree.fragmented_free as u64;
        match btree.kind {
            BtreeKind::LeafTable | BtreeKind::LeafIndex => {
                stats.leaf_pages += 1;
                let count = sane_cell_count(&btree, &page);
                if count < btree.cell_count as usize {
                    report.warn(format!(
                        "page {} declares {} cells, capacity {}",
                        number, btree.cell_count, count
                    ));
                }
                for i in 0..count {
                    let Some(offset) = btree.cell_pointer(&page, i, report) else {
                        continue;
                    };
                    stats.leaf_cells += 1;
                    if btree.kind == BtreeKind::LeafTable {
                        match table_leaf_cell(db, &page, offset as usize) {
                            Ok(cell) => {
                                stats.min_rowid =
                                    Some(stats.min_rowid.map_or(cell.rowid, |m| m.min(cell.rowid)));
                                stats.max_rowid =
                                    Some(stats.max_rowid.map_or(cell.rowid, |m| m.max(cell.rowid)));
                            }
                            Err(_) => {
                                report.warn(format!(
                                    "corrupt cell {} on page {}",
                                    i, page.number
                                ));
                            }
                        }
                    }
                    if !leaf(&page, offset as usize) {
                        keep_going = false;
                        break;
                    }
                }
            }
            BtreeKind::InteriorTable | BtreeKind::InteriorIndex => {
                stats.interior_pages += 1;
                let count = sane_cell_count(&btree, &page);
                // Children in key order: each cell's child pointer, then the
                // right-most pointer after the last cell.
                let mut children = Vec::with_capacity(count + 1);
                for i in 0..count {
                    let Some(offset) = btree.cell_pointer(&page, i, report) else {
                        continue;
                    };
                    let usable = page.usable();
                    let off = offset as usize;
                    // Interior cells start with a 4-byte child pointer for
                    // both table and index pages. For index pages we decode
                    // through index_cell (child field), falling back to the
                    // raw read so a corrupt payload tail still yields the
                    // pointer.
                    let child = if btree.kind == BtreeKind::InteriorIndex {
                        index_cell(db, &page, off, true)
                            .ok()
                            .and_then(|c| c.child)
                            .or_else(|| (off + 4 <= usable.len()).then(|| u32_be(usable, off)))
                    } else if off + 4 <= usable.len() {
                        Some(u32_be(usable, off))
                    } else {
                        None
                    };
                    match child {
                        Some(c) => children.push(c),
                        None => {
                            report.warn(format!(
                                "interior cell {} on page {} out of range",
                                i, page.number
                            ));
                            stats.broken_children += 1;
                        }
                    }
                }
                children.push(btree.right_pointer);
                // Push reversed so traversal stays in key order.
                for child in children.iter().rev() {
                    stack.push((*child, depth + 1));
                }
            }
        }
    }
    stats
}
