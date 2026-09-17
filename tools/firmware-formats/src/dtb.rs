//! Flattened Device Tree (DTB) → DTS text decompiler.
//!
//! Implements the structure-block walk from the Devicetree Specification:
//! a 40-byte big-endian header (magic 0xd00dfeed), a memory reserve map of
//! (address, size) u64 pairs, and a structure block of FDT_BEGIN_NODE /
//! FDT_END_NODE / FDT_PROP / FDT_NOP / FDT_END tokens whose property names
//! index into the strings block. Property payloads are typed-decoded like
//! `dtc -I dtb`: printable NUL-terminated data renders as a DTS string list,
//! 4-aligned data as `<0x...>` cell arrays, anything else as `[xx ...]` bytes.
//!
//! Output is a bounded text buffer: once the serialized-size budget is
//! exhausted the walk stops and the report carries `truncated: true`.

use serde_json::{json, Value};

use crate::{err, hex, MAX_LIST_ITEMS};

const FDT_MAGIC: u32 = 0xD00D_FEED;
const FDT_BEGIN_NODE: u32 = 0x0000_0001;
const FDT_END_NODE: u32 = 0x0000_0002;
const FDT_PROP: u32 = 0x0000_0003;
const FDT_NOP: u32 = 0x0000_0004;
const FDT_END: u32 = 0x0000_0009;
const HEADER_LEN: usize = 40;
/// Node nesting cap; deeper trees truncate the output like any other cap.
const MAX_DEPTH: usize = 256;
/// Header bytes reserved for the JSON envelope around the DTS text.
const ENVELOPE_RESERVE: usize = 4096;

pub(crate) struct Options {
    /// Serialized JSON budget; the DTS text is capped so the whole report fits.
    pub max_output_bytes: usize,
    /// Maximum nodes emitted before `truncated` is set.
    pub max_nodes: usize,
}

fn be32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_be_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn be64(bytes: &[u8], offset: usize) -> Option<u64> {
    Some(u64::from_be_bytes(
        bytes.get(offset..offset + 8)?.try_into().ok()?,
    ))
}

fn align4(value: usize) -> usize {
    (value + 3) & !3
}

/// Bounded output buffer charged by *JSON-serialized* size, so escaping can
/// never push the report past the caller's `maxOutputBytes` budget.
struct Out {
    buf: String,
    /// Serialized cost already spent.
    spent: usize,
    cap: usize,
    truncated: bool,
}

impl Out {
    fn new(cap: usize) -> Self {
        Self {
            buf: String::new(),
            spent: 0,
            cap,
            truncated: false,
        }
    }

    fn push(&mut self, text: &str) -> bool {
        // serde_json escapes control bytes as \u00NN and \n \t " \ as 2 chars.
        let cost: usize = text
            .bytes()
            .map(|byte| match byte {
                b'\n' | b'\r' | b'\t' | b'"' | b'\\' => 2,
                0x00..=0x1f => 6,
                _ => 1,
            })
            .sum();
        if self.spent + cost > self.cap {
            self.truncated = true;
            return false;
        }
        self.buf.push_str(text);
        self.spent += cost;
        true
    }
}

fn sanitize_name(raw: &[u8]) -> String {
    raw.iter()
        .map(|&byte| {
            if (0x20..=0x7e).contains(&byte) {
                byte as char
            } else {
                '?'
            }
        })
        .collect()
}

fn escape_string(raw: &[u8]) -> String {
    // Only called on printable 0x20..=0x7e data; '"' and '\\' still escape.
    raw.iter()
        .map(|&byte| match byte {
            b'"' => "\\\"".to_string(),
            b'\\' => "\\\\".to_string(),
            _ => (byte as char).to_string(),
        })
        .collect()
}

/// dtc's string heuristic: every byte printable or NUL, last byte NUL.
fn is_string_list(data: &[u8]) -> bool {
    !data.is_empty()
        && data.last() == Some(&0)
        && data
            .iter()
            .all(|&byte| byte == 0 || (0x20..=0x7e).contains(&byte))
}

fn render_property(name: &str, data: &[u8]) -> String {
    if data.is_empty() {
        return format!("{name};");
    }
    if is_string_list(data) {
        let parts: Vec<String> = data[..data.len() - 1]
            .split(|&byte| byte == 0)
            .map(|slice| format!("\"{}\"", escape_string(slice)))
            .collect();
        return format!("{name} = {};", parts.join(", "));
    }
    if data.len() % 4 == 0 {
        let cells: Vec<String> = data
            .chunks_exact(4)
            .map(|chunk| {
                format!("0x{:x}", u32::from_be_bytes(chunk.try_into().unwrap_or([0; 4])))
            })
            .collect();
        return format!("{name} = <{}>;", cells.join(" "));
    }
    let bytes: Vec<String> = data.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{name} = [{}];", bytes.join(" "))
}

pub(crate) fn decompile(bytes: &[u8], options: &Options) -> Result<Value, String> {
    if bytes.len() < HEADER_LEN {
        return Err(err(
            "truncated",
            format!("DTB header needs {HEADER_LEN} bytes, got {}", bytes.len()),
        ));
    }
    let magic = be32(bytes, 0).unwrap_or(0);
    if magic != FDT_MAGIC {
        return Err(err(
            "bad_magic",
            format!("magic 0x{magic:08x} is not 0xd00dfeed"),
        ));
    }

    let total_size = be32(bytes, 4).unwrap_or(0) as usize;
    let off_struct = be32(bytes, 8).unwrap_or(0) as usize;
    let off_strings = be32(bytes, 12).unwrap_or(0) as usize;
    let off_rsvmap = be32(bytes, 16).unwrap_or(0) as usize;
    let version = be32(bytes, 20).unwrap_or(0);
    let last_comp_version = be32(bytes, 24).unwrap_or(0);
    let boot_cpuid_phys = be32(bytes, 28).unwrap_or(0);
    let size_strings = be32(bytes, 32).unwrap_or(0) as usize;
    let size_struct = be32(bytes, 36).unwrap_or(0) as usize;

    if total_size < HEADER_LEN {
        return Err(err("malformed", "totalsize smaller than the 40-byte header"));
    }
    if total_size > bytes.len() {
        return Err(err(
            "truncated",
            format!("totalsize {total_size} exceeds input {}", bytes.len()),
        ));
    }
    if off_struct as u64 + size_struct as u64 > total_size as u64 {
        return Err(err(
            "malformed",
            "structure block range exceeds totalsize",
        ));
    }
    if off_strings as u64 + size_strings as u64 > total_size as u64 {
        return Err(err("malformed", "strings block range exceeds totalsize"));
    }
    if off_rsvmap > total_size {
        return Err(err("malformed", "reserve map offset exceeds totalsize"));
    }

    let mut warnings: Vec<String> = Vec::new();
    if version > 17 {
        warnings.push(format!("unsupported_version:{version}"));
    }
    if last_comp_version > 16 {
        warnings.push(format!("unsupported_last_comp_version:{last_comp_version}"));
    }

    // Memory reserve map: (address, size) u64 pairs terminated by (0, 0).
    let mut reservations: Vec<(u64, u64)> = Vec::new();
    let mut reservations_truncated = false;
    let mut pos = off_rsvmap;
    loop {
        if pos + 16 > total_size {
            return Err(err(
                "malformed",
                "reserve map runs past totalsize without a terminator",
            ));
        }
        let address = be64(bytes, pos).unwrap_or(0);
        let size = be64(bytes, pos + 8).unwrap_or(0);
        pos += 16;
        if address == 0 && size == 0 {
            break;
        }
        if reservations.len() >= MAX_LIST_ITEMS {
            reservations_truncated = true;
            warnings.push("memory_reservations_truncated".into());
            break;
        }
        reservations.push((address, size));
    }

    let strings_base = off_strings;
    let strings_end = off_strings + size_strings;
    let struct_end = off_struct + size_struct;
    let lookup_string = |nameoff: u32| -> Result<String, String> {
        let start = strings_base + nameoff as usize;
        if nameoff as usize >= size_strings || start >= strings_end {
            return Err(err(
                "malformed",
                format!("property name offset {nameoff} outside strings block"),
            ));
        }
        let region = &bytes[start..strings_end];
        let end = region
            .iter()
            .position(|&byte| byte == 0)
            .ok_or_else(|| err("malformed", "unterminated property name"))?;
        Ok(sanitize_name(&region[..end]))
    };

    // The DTS text is charged against the serialized budget so the report
    // always fits the JSON output cap; the rest of the report is tiny.
    let text_cap = options.max_output_bytes.saturating_sub(ENVELOPE_RESERVE);
    let mut out = Out::new(text_cap);
    out.push("/dts-v1/;\n");
    for &(address, size) in &reservations {
        // dtc emits both fields zero-padded to 16 hex digits.
        let line = format!("/memreserve/ 0x{address:016x} 0x{size:016x};\n");
        if !out.push(&line) {
            break;
        }
    }
    if !reservations.is_empty() {
        out.push("\n");
    }

    let mut depth = 0usize;
    let mut node_count = 0usize;
    let mut property_count = 0usize;
    let mut ended = false;
    let mut pos = off_struct;

    while !ended && !out.truncated {
        if pos + 4 > struct_end {
            return Err(err(
                "truncated",
                "structure block ended before FDT_END token",
            ));
        }
        let token = be32(bytes, pos).unwrap_or(0);
        pos += 4;
        match token {
            FDT_BEGIN_NODE => {
                let name_start = pos;
                let region_end = struct_end.min(bytes.len());
                let name_len = bytes
                    .get(name_start..region_end)
                    .ok_or_else(|| err("malformed", "node name outside structure block"))?
                    .iter()
                    .position(|&byte| byte == 0)
                    .ok_or_else(|| err("malformed", "unterminated node name"))?;
                let name = sanitize_name(&bytes[name_start..name_start + name_len]);
                pos = off_struct + align4(name_start + name_len + 1 - off_struct);
                node_count += 1;
                if node_count > options.max_nodes {
                    out.truncated = true;
                    warnings.push("node_count_truncated".into());
                    break;
                }
                depth += 1;
                if depth > MAX_DEPTH {
                    out.truncated = true;
                    warnings.push("depth_limit_reached".into());
                    break;
                }
                let display = if name.is_empty() { "/" } else { name.as_str() };
                if !out.push(&format!("{}{display} {{\n", "\t".repeat(depth - 1))) {
                    break;
                }
            }
            FDT_END_NODE => {
                if depth == 0 {
                    return Err(err("malformed", "FDT_END_NODE without open node"));
                }
                depth -= 1;
                if !out.push(&format!("{}}};\n", "\t".repeat(depth))) {
                    break;
                }
            }
            FDT_PROP => {
                if pos + 8 > struct_end {
                    return Err(err("truncated", "property header past structure block"));
                }
                let len = be32(bytes, pos).unwrap_or(0) as usize;
                let nameoff = be32(bytes, pos + 4).unwrap_or(0);
                pos += 8;
                if pos + len > struct_end {
                    return Err(err("truncated", "property data past structure block"));
                }
                let data = bytes
                    .get(pos..pos + len)
                    .ok_or_else(|| err("truncated", "property data outside input"))?;
                pos = off_struct + align4(pos + len - off_struct);
                let name = lookup_string(nameoff)?;
                property_count += 1;
                let line = format!(
                    "{}{}\n",
                    "\t".repeat(depth),
                    render_property(&name, data)
                );
                if !out.push(&line) {
                    break;
                }
            }
            FDT_NOP => {}
            FDT_END => ended = true,
            other => {
                return Err(err(
                    "malformed",
                    format!("unknown structure token 0x{other:08x} at offset {}", pos - 4),
                ));
            }
        }
    }

    if ended && depth != 0 {
        return Err(err(
            "malformed",
            format!("FDT_END with {depth} nodes still open"),
        ));
    }

    let trailing = if ended && pos < struct_end {
        struct_end - pos
    } else {
        0
    };
    if trailing > 0 {
        warnings.push(format!("trailing_struct_bytes:{trailing}"));
    }

    Ok(json!({
        "schema_version": 1,
        "kind": "dtb",
        "input_bytes": bytes.len(),
        "total_size": total_size,
        "version": version,
        "last_comp_version": last_comp_version,
        "boot_cpuid_phys": hex(boot_cpuid_phys as u64),
        "struct_block_size": size_struct,
        "strings_block_size": size_strings,
        "memory_reservations": reservations
            .iter()
            .map(|&(address, size)| json!({ "address": hex(address), "size": hex(size) }))
            .collect::<Vec<_>>(),
        "node_count": node_count,
        "property_count": property_count,
        "dts": out.buf,
        "dts_bytes": out.buf.len(),
        "reservations_truncated": reservations_truncated,
        "truncated": out.truncated || reservations_truncated,
        "warnings": warnings,
    }))
}
