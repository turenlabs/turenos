//! Bounded Android binary XML (AXML) decoder.
//!
//! Decodes a `ResXMLTree` document (AndroidManifest.xml or any compiled
//! `res/` XML inside an APK) to plain XML text plus a string-pool summary.
//! Hand-rolled and fully bounds-checked: every chunk is walked by its own
//! declared size, every string/attribute index is validated against the
//! decoded pool, and output stops at the XML byte cap. Nothing here can
//! panic or execute analyzed content.

use crate::util::{cap_str, escape_xml_attr, escape_xml_text, utf16_to_string, Reader};

// Chunk types (AOSP ResChunk_header / ResXMLTree).
const RES_STRING_POOL: u16 = 0x0001;
const RES_XML: u16 = 0x0003;
const RES_XML_START_NAMESPACE: u16 = 0x0100;
const RES_XML_END_NAMESPACE: u16 = 0x0101;
const RES_XML_START_ELEMENT: u16 = 0x0102;
const RES_XML_END_ELEMENT: u16 = 0x0103;
const RES_XML_CDATA: u16 = 0x0104;
const RES_XML_LAST: u16 = 0x017f;
const RES_XML_RESOURCE_MAP: u16 = 0x0180;

const NO_INDEX: u32 = 0xffff_ffff;
const POOL_UTF8: u32 = 1 << 8;
const POOL_SORTED: u32 = 1;

pub(crate) const MAX_POOL_STRINGS: usize = 1 << 20;
pub(crate) const MAX_POOL_STRING_CHARS: usize = 32 * 1024;
pub(crate) const MAX_ELEMENTS: usize = 65_536;
pub(crate) const MAX_ATTRIBUTES: usize = 131_072;
pub(crate) const MAX_ATTRS_PER_ELEMENT: usize = 1024;
pub(crate) const MAX_DEPTH: usize = 256;
pub(crate) const MAX_WARNINGS: usize = 64;

/// Typed-value data types (AOSP Res_value / ResXMLTree_attribute).
mod dtype {
    pub const NULL: u8 = 0x00;
    pub const REFERENCE: u8 = 0x01;
    pub const ATTRIBUTE: u8 = 0x02;
    pub const STRING: u8 = 0x03;
    pub const FLOAT: u8 = 0x04;
    pub const DIMENSION: u8 = 0x05;
    pub const FRACTION: u8 = 0x06;
    pub const DYN_REFERENCE: u8 = 0x07;
    pub const DYN_ATTRIBUTE: u8 = 0x08;
    pub const INT_DEC: u8 = 0x10;
    pub const INT_HEX: u8 = 0x11;
    pub const INT_BOOLEAN: u8 = 0x12;
    pub const INT_COLOR_ARGB8: u8 = 0x1c;
    pub const INT_COLOR_RGB8: u8 = 0x1d;
    pub const INT_COLOR_ARGB4: u8 = 0x1e;
    pub const INT_COLOR_RGB4: u8 = 0x1f;
}

pub(crate) struct AxmlReport {
    pub xml: String,
    pub xml_truncated: bool,
    pub elements: usize,
    pub attributes: usize,
    pub max_depth: usize,
    /// (prefix, uri) pairs in first-seen order.
    pub namespaces: Vec<(String, String)>,
    pub pool: Option<PoolInfo>,
    pub warnings: Vec<String>,
}

pub(crate) struct PoolInfo {
    pub count: usize,
    pub utf8: bool,
    pub sorted: bool,
    pub styles: usize,
}

/// Output builder that stops appending past `cap` bytes.
struct Builder {
    out: String,
    cap: usize,
    truncated: bool,
}

impl Builder {
    fn emit(&mut self, text: &str) {
        if self.truncated {
            return;
        }
        if self.out.len() + text.len() > self.cap {
            self.truncated = true;
            return;
        }
        self.out.push_str(text);
    }

    fn indent(&mut self, depth: usize) {
        self.emit(&"  ".repeat(depth.min(64)));
    }
}

fn warn(warnings: &mut Vec<String>, message: &str) {
    if warnings.len() < MAX_WARNINGS && !warnings.iter().any(|w| w == message) {
        warnings.push(message.to_string());
    }
}

fn pool_string<'a>(pool: &'a [String], index: u32) -> Option<&'a str> {
    if index == NO_INDEX {
        return None;
    }
    pool.get(index as usize).map(String::as_str)
}

/// Decode one pool string at absolute offset `abs` inside `[0, end)`.
fn decode_pool_string(data: &[u8], abs: usize, end: usize, utf8: bool) -> Option<String> {
    let end = end.min(data.len());
    if abs >= end {
        return None;
    }
    let mut r = Reader::at(data, abs);
    if utf8 {
        // u16 char count (1-2 bytes), then UTF-8 byte length (1-2 bytes).
        let mut first = r.u8()? as u32;
        if first & 0x80 != 0 {
            first = ((first & 0x7f) << 8) | r.u8()? as u32;
        }
        let _char_count = first;
        let mut byte_len = r.u8()? as usize;
        if byte_len & 0x80 != 0 {
            byte_len = ((byte_len & 0x7f) << 8) | r.u8()? as usize;
        }
        let byte_len = byte_len.min(end.saturating_sub(r.pos));
        let raw = r.bytes(byte_len)?;
        Some(cap_str(&String::from_utf8_lossy(raw), MAX_POOL_STRING_CHARS))
    } else {
        let mut first = r.u16()? as u32;
        if first & 0x8000 != 0 {
            first = ((first & 0x7fff) << 16) | r.u16()? as u32;
        }
        let char_count = first as usize;
        let max_units = end.saturating_sub(r.pos) / 2;
        let units = char_count.min(max_units).min(MAX_POOL_STRING_CHARS);
        let mut buf = Vec::with_capacity(units);
        for _ in 0..units {
            buf.push(r.u16()?);
        }
        Some(cap_str(&utf16_to_string(&buf), MAX_POOL_STRING_CHARS))
    }
}

/// Parse a ResStringPool chunk occupying `[pos, chunk_end)`.
fn parse_string_pool(
    data: &[u8],
    pos: usize,
    chunk_end: usize,
    warnings: &mut Vec<String>,
) -> Result<(Vec<String>, PoolInfo), String> {
    let mut r = Reader::at(data, pos);
    let _ctype = r.u16();
    let header_size = r.u16().unwrap_or(0) as usize;
    let _size = r.u32();
    if header_size < 28 || pos + header_size > chunk_end {
        return Err("malformed_string_pool".into());
    }
    let string_count = r.u32().unwrap_or(0) as usize;
    let style_count = r.u32().unwrap_or(0) as usize;
    let flags = r.u32().unwrap_or(0);
    let strings_start = r.u32().unwrap_or(0) as usize;
    let _styles_start = r.u32().unwrap_or(0) as usize;

    // Bound the offset tables against the chunk before reading anything.
    let table = pos + header_size;
    let max_strings = chunk_end.saturating_sub(table) / 4;
    let count = string_count.min(max_strings).min(MAX_POOL_STRINGS);
    if string_count > count {
        warn(warnings, "string_pool_count_clamped");
    }
    let style_table = table.saturating_add(count.saturating_mul(4));
    let styles = style_count.min(chunk_end.saturating_sub(style_table) / 4);

    let data_base = pos.saturating_add(strings_start);
    let utf8 = flags & POOL_UTF8 != 0;
    let mut strings = Vec::with_capacity(count.min(65_536));
    let mut offsets = Reader::at(data, table);
    for _ in 0..count {
        let rel = offsets.u32().unwrap_or(u32::MAX) as usize;
        let abs = data_base.saturating_add(rel);
        match decode_pool_string(data, abs, chunk_end, utf8) {
            Some(value) => strings.push(value),
            None => {
                warn(warnings, "string_offset_out_of_range");
                strings.push(String::new());
            }
        }
    }

    Ok((
        strings,
        PoolInfo {
            count: string_count,
            utf8,
            sorted: flags & POOL_SORTED != 0,
            styles,
        },
    ))
}

/// AOSP Res_value complex value: sign-extended 24-bit mantissa at bits 31..8,
/// radix selector at bits 7..4, unit index at bits 3..0.
fn complex_value(data: u32) -> (f32, u32) {
    const RADIX: [f32; 4] = [
        1.0 / 8388608.0, // 1.0 / (1 << 23)
        1.0 / 32768.0,   // 1.0 / (1 << 15)
        1.0 / 128.0,     // 1.0 / (1 << 7)
        1.0,
    ];
    let mantissa = ((data >> 8) & 0x00ff_ffff) as i32;
    let mantissa = if mantissa & 0x0080_0000 != 0 {
        mantissa - 0x0100_0000
    } else {
        mantissa
    };
    let radix = ((data >> 4) & 0x3) as usize;
    (mantissa as f32 * RADIX[radix.min(3)], data & 0x0f)
}

fn trim_float(value: f32) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        let text = format!("{value:.6}");
        text.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

/// Format a Res_value typed attribute value.
fn typed_value(pool: &[String], data_type: u8, data: u32) -> String {
    match data_type {
        dtype::STRING => pool_string(pool, data).unwrap_or("").to_string(),
        dtype::REFERENCE | dtype::DYN_REFERENCE => format!("@0x{data:08x}"),
        dtype::ATTRIBUTE | dtype::DYN_ATTRIBUTE => format!("?0x{data:08x}"),
        dtype::FLOAT => trim_float(f32::from_bits(data)),
        dtype::DIMENSION => {
            let units = ["px", "dip", "sp", "pt", "in", "mm"];
            let (value, unit) = complex_value(data);
            format!(
                "{}{}",
                trim_float(value),
                units.get(unit as usize).copied().unwrap_or("?")
            )
        }
        dtype::FRACTION => {
            let units = ["%", "%p"];
            let (value, unit) = complex_value(data);
            format!(
                "{}{}",
                trim_float(value * 100.0),
                units.get(unit as usize).copied().unwrap_or("?")
            )
        }
        dtype::INT_DEC => format!("{}", data as i32),
        dtype::INT_HEX => format!("0x{data:08x}"),
        dtype::INT_BOOLEAN => {
            if data == 0 {
                "false".into()
            } else {
                "true".into()
            }
        }
        dtype::INT_COLOR_ARGB8 | dtype::INT_COLOR_RGB8 => format!("#{data:08x}"),
        dtype::INT_COLOR_ARGB4 | dtype::INT_COLOR_RGB4 => format!("#{data:04x}"),
        dtype::NULL => String::new(),
        _ => format!("(type 0x{data_type:02x}) 0x{data:08x}"),
    }
}

/// Qualified name for an element or attribute: optional namespace prefix
/// resolved through the live URI→prefix map, then the local name.
fn qualify(
    ns_index: u32,
    name_index: u32,
    pool: &[String],
    uri_to_prefix: &[(String, String)],
    warnings: &mut Vec<String>,
) -> String {
    let local = match pool_string(pool, name_index) {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => {
            warn(warnings, "missing_name_string");
            format!("e_{name_index}")
        }
    };
    if ns_index == NO_INDEX {
        return local;
    }
    match pool_string(pool, ns_index) {
        Some(uri) => match uri_to_prefix.iter().rev().find(|(u, _)| u == uri) {
            Some((_, prefix)) if !prefix.is_empty() => format!("{prefix}:{local}"),
            _ => local,
        },
        None => local,
    }
}

/// Decode a binary XML document. `max_xml` caps emitted XML bytes.
///
/// Returns `Err(code)` for inputs that cannot be an AXML document at all
/// (bad magic, truncated root header); recoverable damage degrades to
/// warnings instead.
pub(crate) fn decode_axml(data: &[u8], max_xml: usize) -> Result<AxmlReport, String> {
    let mut head = Reader::new(data);
    let first = head.u16().ok_or_else(|| "too_small".to_string())?;

    let (mut pos, doc_end) = if first == RES_XML {
        let header_size = head.u16().unwrap_or(0) as usize;
        let size = head.u32().ok_or_else(|| "truncated".to_string())? as usize;
        if header_size < 8 {
            return Err("malformed_header".into());
        }
        (header_size, size.min(data.len()))
    } else if first == RES_STRING_POOL {
        // Tolerate documents missing the outer ResXMLTree wrapper.
        (0, data.len())
    } else {
        return Err("bad_magic".into());
    };

    let mut report = AxmlReport {
        xml: String::new(),
        xml_truncated: false,
        elements: 0,
        attributes: 0,
        max_depth: 0,
        namespaces: Vec::new(),
        pool: None,
        warnings: Vec::new(),
    };
    if first != RES_XML {
        warn(&mut report.warnings, "missing_xml_root_chunk");
    }

    let mut pool: Vec<String> = Vec::new();
    let mut res_ids: Vec<u32> = Vec::new();
    let mut uri_to_prefix: Vec<(String, String)> = Vec::new();
    let mut pending_ns: Vec<(String, String)> = Vec::new();
    let mut stack: Vec<String> = Vec::new();
    let mut builder = Builder {
        out: String::from("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n"),
        cap: max_xml,
        truncated: false,
    };

    while pos + 8 <= doc_end {
        let chunk_start = pos;
        let mut hdr = Reader::at(data, pos);
        let ctype = match hdr.u16() {
            Some(value) => value,
            None => break,
        };
        let header_size = hdr.u16().unwrap_or(0) as usize;
        let size = hdr.u32().unwrap_or(0) as usize;
        if size < header_size || header_size < 8 {
            warn(&mut report.warnings, "malformed_chunk_header");
            break;
        }
        let chunk_end = match chunk_start.checked_add(size) {
            Some(end) if end <= doc_end => end,
            _ => {
                warn(&mut report.warnings, "chunk_overruns_document");
                break;
            }
        };
        pos = chunk_end; // chunk-size-driven walk; never trusts sub-reads

        match ctype {
            RES_STRING_POOL => {
                match parse_string_pool(data, chunk_start, chunk_end, &mut report.warnings) {
                    Ok((strings, info)) => {
                        report.pool = Some(info);
                        pool = strings;
                    }
                    Err(code) => warn(&mut report.warnings, &code),
                }
            }
            RES_XML_RESOURCE_MAP => {
                let count = (chunk_end.saturating_sub(chunk_start + header_size)) / 4;
                let mut map = Reader::at(data, chunk_start + header_size);
                res_ids = Vec::with_capacity(count.min(65_536));
                for _ in 0..count.min(65_536) {
                    res_ids.push(map.u32().unwrap_or(0));
                }
            }
            RES_XML_START_NAMESPACE => {
                let mut node = Reader::at(data, chunk_start + 16);
                let prefix_idx = node.u32().unwrap_or(NO_INDEX);
                let uri_idx = node.u32().unwrap_or(NO_INDEX);
                let prefix = pool_string(&pool, prefix_idx).unwrap_or("").to_string();
                let uri = pool_string(&pool, uri_idx).unwrap_or("").to_string();
                if !uri.is_empty() {
                    uri_to_prefix.push((uri.clone(), prefix.clone()));
                    pending_ns.push((prefix.clone(), uri.clone()));
                    if !report.namespaces.contains(&(prefix.clone(), uri.clone())) {
                        report.namespaces.push((prefix, uri));
                    }
                }
            }
            RES_XML_END_NAMESPACE => {
                let mut node = Reader::at(data, chunk_start + 16);
                let _prefix = node.u32();
                let uri_idx = node.u32().unwrap_or(NO_INDEX);
                if let Some(uri) = pool_string(&pool, uri_idx) {
                    if let Some(at) = uri_to_prefix.iter().rposition(|(u, _)| u == uri) {
                        uri_to_prefix.remove(at);
                    }
                }
            }
            RES_XML_START_ELEMENT => {
                if chunk_start + 36 > chunk_end {
                    warn(&mut report.warnings, "short_start_element");
                    continue;
                }
                let mut node = Reader::at(data, chunk_start + 16);
                let ns_idx = node.u32().unwrap_or(NO_INDEX);
                let name_idx = node.u32().unwrap_or(NO_INDEX);
                let attr_start = node.u16().unwrap_or(0) as usize;
                let attr_size = node.u16().unwrap_or(0) as usize;
                let attr_count = node.u16().unwrap_or(0) as usize;
                let _id = node.u16();
                let _class = node.u16();
                let _style = node.u16();

                let qname = qualify(
                    ns_idx,
                    name_idx,
                    &pool,
                    &uri_to_prefix,
                    &mut report.warnings,
                );
                report.elements += 1;
                if report.elements > MAX_ELEMENTS {
                    warn(&mut report.warnings, "element_limit_reached");
                    builder.truncated = true;
                    break;
                }
                let depth = stack.len();
                if depth >= MAX_DEPTH {
                    warn(&mut report.warnings, "max_depth_exceeded");
                    continue;
                }
                report.max_depth = report.max_depth.max(depth + 1);

                builder.indent(depth);
                builder.emit(&format!("<{qname}"));
                for (prefix, uri) in pending_ns.drain(..) {
                    if prefix.is_empty() {
                        builder.emit(&format!(" xmlns=\"{}\"", escape_xml_attr(&uri)));
                    } else {
                        builder.emit(&format!(" xmlns:{prefix}=\"{}\"", escape_xml_attr(&uri)));
                    }
                }

                // Attribute array starts `attr_start` bytes after the
                // ResXMLTree_attrExt header (which begins at +16).
                let attr_base = chunk_start + 16 + attr_start;
                if attr_size >= 20 && attr_base <= chunk_end {
                    let avail = (chunk_end - attr_base) / attr_size;
                    let take = attr_count.min(avail).min(MAX_ATTRS_PER_ELEMENT);
                    if attr_count > take {
                        warn(&mut report.warnings, "attribute_count_clamped");
                    }
                    for i in 0..take {
                        let mut a = Reader::at(data, attr_base + i * attr_size);
                        let a_ns = a.u32().unwrap_or(NO_INDEX);
                        let a_name = a.u32().unwrap_or(NO_INDEX);
                        let a_raw = a.u32().unwrap_or(NO_INDEX);
                        let _vsize = a.u16();
                        let _res0 = a.u8();
                        let a_type = a.u8().unwrap_or(0);
                        let a_data = a.u32().unwrap_or(0);

                        let mut key = qualify(
                            a_ns,
                            a_name,
                            &pool,
                            &uri_to_prefix,
                            &mut report.warnings,
                        );
                        if key.starts_with("e_") {
                            // Fall back to the resource-map ID when the name
                            // string itself is unusable.
                            let res_id = res_ids.get(a_name as usize).copied().unwrap_or(0);
                            if res_id != 0 {
                                key = format!("attr_0x{res_id:08x}");
                            }
                        }
                        let value = if a_raw != NO_INDEX {
                            pool_string(&pool, a_raw).unwrap_or("").to_string()
                        } else {
                            typed_value(&pool, a_type, a_data)
                        };
                        report.attributes += 1;
                        if report.attributes > MAX_ATTRIBUTES {
                            warn(&mut report.warnings, "attribute_limit_reached");
                            builder.truncated = true;
                            break;
                        }
                        builder.emit(&format!(" {key}=\"{}\"", escape_xml_attr(&value)));
                    }
                } else if attr_count > 0 {
                    warn(&mut report.warnings, "malformed_attribute_array");
                }
                builder.emit(">\n");
                stack.push(qname);
            }
            RES_XML_END_ELEMENT => {
                let mut node = Reader::at(data, chunk_start + 16);
                let _ns = node.u32();
                let name_idx = node.u32().unwrap_or(NO_INDEX);
                let local = pool_string(&pool, name_idx).unwrap_or("").to_string();
                match stack.pop() {
                    Some(open) => {
                        let depth = stack.len();
                        let open_local = open.rsplit(':').next().unwrap_or(&open);
                        if !local.is_empty() && open_local != local {
                            warn(&mut report.warnings, "unbalanced_end_element");
                        }
                        builder.indent(depth);
                        builder.emit(&format!("</{open}>\n"));
                    }
                    None => warn(&mut report.warnings, "stray_end_element"),
                }
            }
            RES_XML_CDATA => {
                let mut node = Reader::at(data, chunk_start + 16);
                let data_idx = node.u32().unwrap_or(NO_INDEX);
                let text = pool_string(&pool, data_idx).unwrap_or("");
                builder.indent(stack.len());
                builder.emit(&escape_xml_text(text));
                builder.emit("\n");
            }
            RES_XML_LAST => break,
            _ => warn(&mut report.warnings, "unknown_chunk_skipped"),
        }
        if builder.truncated {
            break;
        }
    }

    if builder.truncated {
        report.xml_truncated = true;
        warn(&mut report.warnings, "xml_output_capped");
    }
    // Close any still-open elements so truncated output stays well formed.
    while let Some(open) = stack.pop() {
        if builder.out.len() >= builder.cap {
            break;
        }
        let depth = stack.len();
        builder.out.push_str(&"  ".repeat(depth.min(64)));
        builder.out.push_str(&format!("</{open}>\n"));
    }
    if report.elements == 0 {
        warn(&mut report.warnings, "no_elements");
    }
    report.xml = builder.out;
    Ok(report)
}
