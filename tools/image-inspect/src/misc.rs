//! Smaller format walkers: BMP, TIFF, ICO/CUR, and ISO-BMFF (AVIF/HEIC).
//! All are parse-only header/record walks with bounds-checked offsets.

use crate::model::{push_text, ByteRange, Limits, Reader, Report, TextEncoding, Trailing};
use crate::{hex, Fail};

// ---------------------------------------------------------------- BMP ----

pub(crate) fn parse_bmp(data: &[u8], report: &mut Report, limits: &Limits) -> Result<(), Fail> {
    let mut reader = Reader::new(data);
    if reader.take(2).is_none() {
        report.anomaly("truncated_header");
        return Ok(());
    }
    let declared_size = reader.le32().unwrap_or(0) as usize;
    if reader.skip(4).is_none() {
        report.anomaly("truncated_header");
        return Ok(());
    }
    let data_offset = reader.le32().unwrap_or(0) as usize;
    let dib_size = reader.le32().unwrap_or(0) as usize;
    report.region(limits, "file_header", 0, 14);
    report.region(limits, "dib_header", 14, dib_size.min(data.len().saturating_sub(14)));

    match dib_size {
        12 => {
            let b = reader.take(8); // remainder of BITMAPCOREHEADER
            match b {
                Some(b) => {
                    report.width = Some(u16::from_le_bytes([b[0], b[1]]) as u64);
                    report.height = Some(u16::from_le_bytes([b[2], b[3]]) as u64);
                    let bpp = u16::from_le_bytes([b[6], b[7]]);
                    report.bit_depth = Some(bpp as u32);
                    report.color_type = Some(bmp_color_type(bpp, 0).to_string());
                    report.extra.insert("dib".into(), "core".into());
                }
                None => {
                    report.anomaly("truncated_dib");
                    return Ok(());
                }
            }
        }
        size if size >= 40 => {
            // Need w,h(8) planes,bpp(4) compression(4) — 26 bytes after size.
            let b = reader.take(26.min(size.saturating_sub(4)));
            match b {
                Some(b) if b.len() >= 16 => {
                    let w = i32::from_le_bytes([b[0], b[1], b[2], b[3]]);
                    let h = i32::from_le_bytes([b[4], b[5], b[6], b[7]]);
                    report.width = Some(w.unsigned_abs() as u64);
                    report.height = Some(h.unsigned_abs() as u64);
                    if h < 0 {
                        report.extra.insert("top_down".into(), true.into());
                    }
                    let bpp = u16::from_le_bytes([b[10], b[11]]);
                    report.bit_depth = Some(bpp as u32);
                    let compression = u32::from_le_bytes([b[12], b[13], b[14], b[15]]);
                    report.extra.insert(
                        "compression".into(),
                        bmp_compression(compression).into(),
                    );
                    report.color_type = Some(bmp_color_type(bpp, compression).to_string());
                    report.extra.insert(
                        "dib".into(),
                        match size {
                            40 => "info",
                            52 | 56 => "v2-v3",
                            108 => "v4",
                            124 => "v5",
                            _ => "extended",
                        }
                        .into(),
                    );
                }
                _ => {
                    report.anomaly("truncated_dib");
                    return Ok(());
                }
            }
        }
        _ => {
            report.anomaly(format!("unsupported_dib_size:{dib_size}"));
            return Ok(());
        }
    }

    let dib_end = 14 + dib_size;
    if data_offset > dib_end && data_offset <= data.len() {
        report.region(
            limits,
            "color_table",
            dib_end,
            data_offset - dib_end,
        );
    }
    if data_offset < data.len() {
        let pixel_len = declared_size
            .checked_sub(data_offset)
            .filter(|_| declared_size <= data.len())
            .unwrap_or(data.len() - data_offset);
        report.region(limits, "pixel_data", data_offset, pixel_len);
    }
    if declared_size > 0 && declared_size < data.len() {
        let preview_len = (data.len() - declared_size).min(32);
        report.trailing = Some(Trailing {
            offset: declared_size as u64,
            length: (data.len() - declared_size) as u64,
            hex_preview: hex(&data[declared_size..declared_size + preview_len]),
        });
        report.anomaly("trailing_bytes_after_file");
    } else if declared_size > data.len() {
        report.anomaly("file_size_past_eof");
    }
    if data_offset > data.len() {
        report.anomaly("pixel_offset_past_eof");
    }
    Ok(())
}

fn bmp_compression(value: u32) -> &'static str {
    match value {
        0 => "rgb",
        1 => "rle8",
        2 => "rle4",
        3 => "bitfields",
        4 => "jpeg",
        5 => "png",
        6 => "bitfields-alpha",
        11 => "cmyk",
        12 => "cmyk-rle8",
        13 => "cmyk-rle4",
        _ => "unknown",
    }
}

fn bmp_color_type(bpp: u16, compression: u32) -> &'static str {
    match (bpp, compression) {
        (4, 4) | (8, 4) => "jpeg",
        (4, 5) | (8, 5) => "png",
        (1, _) => "mono",
        (4, _) | (8, _) => "palette",
        (16, _) => "rgb16",
        (24, _) => "rgb",
        (32, _) => "rgba",
        _ => "unknown",
    }
}

// --------------------------------------------------------------- TIFF ----

const TIFF_TYPE_SIZE: [usize; 13] = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

const MAX_IFDS: usize = 16;

/// Tag -> report plumbing for TIFF IFD0: (tag, name, is_text).
const TIFF_TEXT_TAGS: &[(u16, &str)] = &[
    (0x010e, "ImageDescription"),
    (0x010f, "Make"),
    (0x0110, "Model"),
    (0x0131, "Software"),
    (0x0132, "DateTime"),
    (0x013b, "Artist"),
    (0x8298, "Copyright"),
];

pub(crate) fn parse_tiff(data: &[u8], report: &mut Report, limits: &Limits) -> Result<(), Fail> {
    let little = data.starts_with(b"II");
    let magic = if little {
        u16::from_le_bytes([data[2], data[3]])
    } else {
        u16::from_be_bytes([data[2], data[3]])
    };
    report
        .extra
        .insert("endian".into(), if little { "little" } else { "big" }.into());
    if magic != 42 {
        report.anomaly(if magic == 43 { "bigtiff" } else { "bad_tiff_magic" });
        return Ok(());
    }
    // A TIFF file is natively an EXIF container.
    report.exif = Some(ByteRange {
        offset: 0,
        length: data.len() as u64,
    });

    let read16 = |bytes: &[u8]| -> u16 {
        if little {
            u16::from_le_bytes([bytes[0], bytes[1]])
        } else {
            u16::from_be_bytes([bytes[0], bytes[1]])
        }
    };
    let read32 = |bytes: &[u8]| -> u32 {
        if little {
            u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
        } else {
            u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
        }
    };

    let mut ifd_offset = data
        .get(4..8)
        .map(|b| read32(b) as usize)
        .unwrap_or(0);
    let mut ifd_index = 0usize;
    while ifd_offset != 0 && ifd_index < MAX_IFDS {
        let count = match data.get(ifd_offset..ifd_offset + 2) {
            Some(b) => read16(b) as usize,
            None => {
                report.anomaly("ifd_offset_past_eof");
                break;
            }
        };
        let entries_start = ifd_offset + 2;
        let table_len = count.saturating_mul(12);
        let table_end = match entries_start.checked_add(table_len) {
            Some(end) => end,
            None => {
                report.anomaly("ifd_entries_past_eof");
                break;
            }
        };
        let declared_len = table_len + 2 + 4;
        report.region(
            limits,
            format!("IFD{ifd_index}"),
            ifd_offset,
            declared_len,
        );
        if table_end > data.len() {
            if let Some(region) = report.last_region() {
                region.length = data.len().saturating_sub(ifd_offset) as u64;
                region.detail = Some("truncated".into());
            }
            report.anomaly("ifd_entries_past_eof");
            break;
        }
        for index in 0..count {
            let entry = &data[entries_start + index * 12..entries_start + index * 12 + 12];
            let tag = read16(&entry[0..2]);
            let field_type = read16(&entry[2..4]) as usize;
            let element_count = read32(&entry[4..8]) as usize;
            let type_size = TIFF_TYPE_SIZE.get(field_type).copied().unwrap_or(1);
            let total = element_count.saturating_mul(type_size);
            let value_bytes: &[u8] = if total <= 4 {
                &entry[8..8 + total]
            } else {
                let off = read32(&entry[8..12]) as usize;
                match data.get(off..off.saturating_add(total.min(1 << 20))) {
                    Some(slice) => slice,
                    None => &[],
                }
            };
            match (ifd_index, tag) {
                (0, 256) => report.width = first_scalar(value_bytes, field_type, &read16, &read32).map(|v| v as u64),
                (0, 257) => report.height = first_scalar(value_bytes, field_type, &read16, &read32).map(|v| v as u64),
                (0, 258) => report.bit_depth = first_scalar(value_bytes, field_type, &read16, &read32).map(|v| v as u32),
                (0, 262) => {
                    report.color_type = first_scalar(value_bytes, field_type, &read16, &read32)
                        .map(|v| tiff_photometric(v).to_string())
                }
                _ => {}
            }
            if ifd_index == 0 {
                if let Some((_, name)) = TIFF_TEXT_TAGS.iter().find(|(t, _)| *t == tag) {
                    if field_type == 2 && total > 1 {
                        let raw = value_bytes
                            .split(|byte| *byte == 0)
                            .next()
                            .unwrap_or(value_bytes);
                        push_text(
                            report,
                            limits,
                            format!("tiff:IFD0/{}", name),
                            Some(name.to_string()),
                            raw,
                            TextEncoding::Utf8OrHex,
                        );
                    }
                }
                if tag == 0x8769 {
                    report.extra.insert("exif_ifd".into(), true.into());
                }
                if tag == 0x8825 {
                    report.extra.insert("gps_ifd".into(), true.into());
                }
            }
        }
        let next = data
            .get(table_end..table_end + 4)
            .map(|b| read32(b) as usize)
            .unwrap_or(0);
        if ifd_index == 0 && next != 0 {
            report.extra.insert("thumbnail_ifd".into(), true.into());
        }
        ifd_offset = next;
        ifd_index += 1;
    }
    if ifd_index >= MAX_IFDS && ifd_offset != 0 {
        report.truncated = true;
        report.warning("ifd chain truncated at 16 directories".to_string());
    }
    Ok(())
}

fn first_scalar(
    bytes: &[u8],
    field_type: usize,
    read16: &dyn Fn(&[u8]) -> u16,
    read32: &dyn Fn(&[u8]) -> u32,
) -> Option<u32> {
    match field_type {
        3 if bytes.len() >= 2 => Some(read16(bytes) as u32),
        4 if bytes.len() >= 4 => Some(read32(bytes)),
        _ => None,
    }
}

fn tiff_photometric(value: u32) -> &'static str {
    match value {
        0 => "white-is-zero",
        1 => "black-is-zero",
        2 => "rgb",
        3 => "palette",
        5 => "cmyk",
        6 => "ycbcr",
        8 => "cielab",
        _ => "other",
    }
}

// ---------------------------------------------------------------- ICO ----

pub(crate) fn parse_ico(data: &[u8], report: &mut Report, limits: &Limits) -> Result<(), Fail> {
    let kind = u16::from_le_bytes([data[2], data[3]]);
    report
        .extra
        .insert("kind".into(), if kind == 2 { "cursor" } else { "icon" }.into());
    let count = data
        .get(4..6)
        .map(|b| u16::from_le_bytes([b[0], b[1]]) as usize)
        .unwrap_or(0);
    if count == 0 {
        report.anomaly("zero_entries");
        return Ok(());
    }
    if 6usize.saturating_add(count * 16) > data.len() {
        report.anomaly("entry_table_past_eof");
    }
    report
        .extra
        .insert("directory_entries".into(), (count as u64).into());

    let mut max_end = 6 + count.min(4096) * 16;
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    let mut best = 0u32;
    for index in 0..count {
        let base = 6 + index * 16;
        let entry = match data.get(base..base + 16) {
            Some(e) => e,
            None => break,
        };
        let w = if entry[0] == 0 { 256 } else { entry[0] as u32 };
        let h = if entry[1] == 0 { 256 } else { entry[1] as u32 };
        let bpp = u16::from_le_bytes([entry[6], entry[7]]);
        let size = u32::from_le_bytes([entry[8], entry[9], entry[10], entry[11]]) as usize;
        let offset = u32::from_le_bytes([entry[12], entry[13], entry[14], entry[15]]) as usize;
        let inner = match data.get(offset..offset + size.min(8)) {
            Some(head) if head.starts_with(b"\x89PNG") => "png",
            Some(head) if head.starts_with(b"\xff\xd8") => "jpeg",
            Some(_) => "bmp-dib",
            None => "out-of-bounds",
        };
        if size == 0 {
            report.anomaly("zero_size_entry");
        }
        match offset.checked_add(size) {
            Some(end) if offset < data.len() && end <= data.len() => {
                max_end = max_end.max(end);
                ranges.push((offset, end));
            }
            _ => report.anomaly(format!("entry_past_eof:{index}")),
        }
        report.region(limits, format!("entry_{index}"), base, 16);
        if let Some(region) = report.last_region() {
            region.detail = Some(format!("{w}x{h} bpp:{bpp} {inner} @{offset}+{size}"));
        }
        if w * h >= best {
            best = w * h;
            report.width = Some(w as u64);
            report.height = Some(h as u64);
            report.bit_depth = Some(bpp as u32);
        }
    }
    report.color_type = Some("rgba".to_string());
    ranges.sort_unstable();
    for window in ranges.windows(2) {
        if window[1].0 < window[0].1 {
            report.anomaly("overlapping_entries");
            break;
        }
    }
    let max_end = max_end.min(data.len());
    if max_end < data.len() {
        let preview_len = (data.len() - max_end).min(32);
        report.trailing = Some(Trailing {
            offset: max_end as u64,
            length: (data.len() - max_end) as u64,
            hex_preview: hex(&data[max_end..max_end + preview_len]),
        });
        report.anomaly("trailing_bytes_after_entries");
    }
    Ok(())
}

// --------------------------------------------------------------- BMFF ----

/// ISO-BMFF box walk for AVIF/HEIC. Collects the top-level box table, meta
/// children, ispe/pixi properties, and resolves an `Exif` item through
/// iinf + iloc into a byte range.
pub(crate) fn parse_bmff(data: &[u8], report: &mut Report, limits: &Limits) -> Result<(), Fail> {
    let mut pos = 0usize;
    let mut last_end = 0usize;
    let mut meta_content: Option<(usize, usize)> = None; // (start, end) of meta payload
    while pos + 8 <= data.len() {
        let (size, header) = match box_header(data, pos) {
            Some(v) => v,
            None => {
                report.anomaly("invalid_box_header");
                break;
            }
        };
        let name = &data[pos + 4..pos + 8];
        let end = match size {
            0 => data.len(),
            s => pos.saturating_add(s),
        };
        let bounded_end = end.min(data.len());
        report.region(
            limits,
            String::from_utf8_lossy(name).into_owned(),
            pos,
            bounded_end.saturating_sub(pos + header),
        );
        if end > data.len() {
            report.anomaly("box_past_eof");
        }
        if name == b"ftyp" {
            parse_ftyp(data, report, pos + header, bounded_end);
        }
        if name == b"meta" {
            meta_content = Some((pos + header + 4, bounded_end)); // + fullbox header
        }
        if bounded_end <= pos {
            break;
        }
        pos = end;
        last_end = bounded_end;
        if end >= data.len() {
            break;
        }
    }
    if last_end < data.len() && last_end > 0 {
        let preview_len = (data.len() - last_end).min(32);
        report.trailing = Some(Trailing {
            offset: last_end as u64,
            length: (data.len() - last_end) as u64,
            hex_preview: hex(&data[last_end..last_end + preview_len]),
        });
        report.anomaly("trailing_bytes_after_boxes");
    }
    if let Some((start, end)) = meta_content {
        parse_meta(data, report, limits, start, end);
    }
    Ok(())
}

/// Returns `(box_size_including_header, header_bytes)`; size 0 means to EOF.
fn box_header(data: &[u8], pos: usize) -> Option<(usize, usize)> {
    let head = data.get(pos..pos + 8)?;
    let size = u32::from_be_bytes([head[0], head[1], head[2], head[3]]);
    match size {
        0 => Some((0, 8)),
        1 => {
            let large = data.get(pos + 8..pos + 16)?;
            let size64 = u64::from_be_bytes([
                large[0], large[1], large[2], large[3],
                large[4], large[5], large[6], large[7],
            ]);
            Some((size64.min(usize::MAX as u64) as usize, 16))
        }
        s if s < 8 => None,
        s => Some((s as usize, 8)),
    }
}

fn parse_ftyp(data: &[u8], report: &mut Report, start: usize, end: usize) {
    if let Some(payload) = data.get(start..end.min(data.len())) {
        if payload.len() >= 8 {
            let major = String::from_utf8_lossy(&payload[0..4]).into_owned();
            report.extra.insert("major_brand".into(), major.into());
            let mut brands = Vec::new();
            let mut index = 8;
            while index + 4 <= payload.len() && brands.len() < 32 {
                brands.push(String::from_utf8_lossy(&payload[index..index + 4]).into_owned());
                index += 4;
            }
            report.extra.insert(
                "compatible_brands".into(),
                serde_json::Value::Array(
                    brands.into_iter().map(serde_json::Value::String).collect(),
                ),
            );
            if report.extra["major_brand"] == "avis" {
                report.extra.insert("animated".into(), true.into());
            }
        }
    }
}

/// Walk the meta box's child boxes one level deep, recursing into iprp/ipco
/// for properties and reading iinf/iloc for the Exif item.
fn parse_meta(
    data: &[u8],
    report: &mut Report,
    limits: &Limits,
    start: usize,
    end: usize,
) {
    let mut pos = start;
    let mut exif_item: Option<u64> = None;
    let mut iloc_range: Option<(usize, usize)> = None;
    while pos + 8 <= end {
        let (size, header) = match box_header(data, pos) {
            Some(v) => v,
            None => break,
        };
        let name = &data[pos + 4..pos + 8];
        let content = pos + header;
        let box_end = if size == 0 { end } else { pos.saturating_add(size).min(end) };
        report.region(
            limits,
            format!("meta/{}", String::from_utf8_lossy(name)),
            pos,
            box_end.saturating_sub(content),
        );
        match name {
            b"iprp" => parse_iprp(data, report, limits, content, box_end),
            b"iinf" => exif_item = parse_iinf(data, content, box_end),
            b"iloc" => iloc_range = Some((content, box_end)),
            b"hdlr" => {
                if content + 12 <= box_end {
                    if let Some(handler) = data.get(content + 8..content + 12) {
                        report.extra.insert(
                            "handler".into(),
                            String::from_utf8_lossy(handler).into_owned().into(),
                        );
                    }
                }
            }
            _ => {}
        }
        if box_end <= pos || size == 0 {
            break;
        }
        pos = pos.saturating_add(size);
    }
    if let (Some(item), Some((s, e))) = (exif_item, iloc_range) {
        if let Some(range) = resolve_iloc(data, s, e, item) {
            // HEIF Exif items begin with a u32 offset to the TIFF header.
            if let Some(skip) = data.get(range.0..range.0 + 4) {
                let tiff_off = u32::from_be_bytes([skip[0], skip[1], skip[2], skip[3]]) as usize;
                let tiff_start = range.0 + 4 + tiff_off;
                if tiff_start <= range.0 + range.1 {
                    report.exif = Some(ByteRange {
                        offset: tiff_start as u64,
                        length: (range.0 + range.1 - tiff_start) as u64,
                    });
                }
            }
        }
    }
}

fn parse_iprp(data: &[u8], report: &mut Report, limits: &Limits, start: usize, end: usize) {
    let mut pos = start;
    while pos + 8 <= end {
        let (size, header) = match box_header(data, pos) {
            Some(v) => v,
            None => break,
        };
        if &data[pos + 4..pos + 8] == b"ipco" {
            let mut p = pos + header;
            let ipco_end = if size == 0 { end } else { pos.saturating_add(size).min(end) };
            while p + 8 <= ipco_end {
                let (psize, pheader) = match box_header(data, p) {
                    Some(v) => v,
                    None => break,
                };
                let pname = &data[p + 4..p + 8];
                let pcontent = p + pheader;
                let pend = if psize == 0 { ipco_end } else { p.saturating_add(psize).min(ipco_end) };
                match pname {
                    b"ispe" => {
                        if pcontent + 12 <= pend {
                            if let Some(b) = data.get(pcontent + 4..pcontent + 12) {
                                report.width = Some(u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as u64);
                                report.height = Some(u32::from_be_bytes([b[4], b[5], b[6], b[7]]) as u64);
                            }
                        }
                    }
                    b"pixi" => {
                        if pcontent + 6 <= pend {
                            if let Some(b) = data.get(pcontent + 4..pcontent + 6) {
                                let channels = b[0] as usize;
                                let bits = data.get(pcontent + 6..pcontent + 6 + channels).unwrap_or(&[]);
                                if let Some(first) = bits.first() {
                                    report.bit_depth = Some(*first as u32);
                                }
                                report.extra.insert("channels".into(), (channels as u64).into());
                            }
                        }
                        report.color_type = Some("yuv".to_string());
                    }
                    _ => {}
                }
                report.region(
                    limits,
                    format!("ipco/{}", String::from_utf8_lossy(pname)),
                    p,
                    pend.saturating_sub(pcontent),
                );
                if pend <= p || psize == 0 {
                    break;
                }
                p = p.saturating_add(psize);
            }
        }
        if size == 0 {
            break;
        }
        pos = pos.saturating_add(size);
    }
}

/// Scan an iinf box for `infe` v2+ entries; return the item_ID of the first
/// item whose item_type is "Exif".
fn parse_iinf(data: &[u8], start: usize, end: usize) -> Option<u64> {
    let head = data.get(start..start + 6)?;
    let version = head[0];
    let mut count = if version == 0 {
        u16::from_be_bytes([head[4], head[5]]) as usize
    } else {
        let b = data.get(start + 4..start + 8)?;
        u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize
    };
    count = count.min(256);
    let mut pos = if version == 0 { start + 6 } else { start + 8 };
    for _ in 0..count {
        if pos + 8 > end {
            return None;
        }
        let (size, header) = box_header(data, pos)?;
        let name = &data[pos + 4..pos + 8];
        let content = pos + header;
        let box_end = pos.saturating_add(size).min(end);
        if name == b"infe" && content + 8 <= box_end {
            let v = data[content];
            if v >= 2 && content + 8 <= box_end {
                let (item_id, type_off) = if v == 2 {
                    (u16::from_be_bytes([data[content + 4], data[content + 5]]) as u64, content + 8)
                } else {
                    let b = data.get(content + 4..content + 8)?;
                    (
                        u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as u64,
                        content + 10,
                    )
                };
                if let Some(t) = data.get(type_off..type_off + 4) {
                    if t == b"Exif" {
                        return Some(item_id);
                    }
                }
            }
        }
        if box_end <= pos || size == 0 {
            return None;
        }
        pos = pos.saturating_add(size);
    }
    None
}

/// Resolve an iloc extent for `item_id` into a `(offset, length)` file range
/// (construction_method 0 only). iloc layout:
/// v0/v1/v2: [offset_size<<4|length_size][base_offset_size<<4|index_size(v1+)]
/// item_count u16 (v0/1) / u32 (v2); per item: item_ID (u16 v0/1, u32 v2),
/// [v1+: u16 incl. construction_method], data_ref u16, base_offset (n bytes),
/// extent_count u16, extents {index(v1+), offset, length}.
fn resolve_iloc(
    data: &[u8],
    start: usize,
    end: usize,
    item_id: u64,
) -> Option<(usize, usize)> {
    let mut r = Reader::at(data, start);
    let version = r.u8()?;
    r.skip(3)?; // flags
    let sizes0 = r.u8()?;
    let sizes1 = r.u8()?;
    let offset_size = (sizes0 >> 4) as usize;
    let length_size = (sizes0 & 0x0f) as usize;
    let base_offset_size = (sizes1 >> 4) as usize;
    let index_size = if version >= 1 { (sizes1 & 0x0f) as usize } else { 0 };
    let item_count = if version < 2 {
        r.be16()? as usize
    } else {
        r.be32()? as usize
    };
    if item_count > 4096 {
        return None;
    }
    for _ in 0..item_count {
        if r.pos >= end {
            return None;
        }
        let id = if version < 2 { r.be16()? as u64 } else { r.be32()? as u64 };
        let construction = if version >= 1 {
            (r.be16()? & 0x000f) as usize
        } else {
            0
        };
        r.skip(2)?; // data_reference_index
        let base = r.be_uint(base_offset_size)? as usize;
        let extent_count = r.be16()? as usize;
        if extent_count > 16 {
            return None;
        }
        for extent in 0..extent_count {
            if version >= 1 && index_size > 0 {
                r.skip(index_size)?;
            }
            let extent_offset = r.be_uint(offset_size)? as usize;
            let extent_length = r.be_uint(length_size)? as usize;
            if id == item_id && extent == 0 && construction == 0 {
                let abs = base.checked_add(extent_offset)?;
                if abs.checked_add(extent_length)? <= data.len() {
                    return Some((abs, extent_length));
                }
                return None;
            }
        }
    }
    None
}
