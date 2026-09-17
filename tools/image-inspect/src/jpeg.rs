//! JPEG marker-segment walker: lists SOI/APPn/COM/DQT/DHT/SOF/SOS/DNL/EOI
//! with offsets and declared lengths, extracts the APP1 EXIF/XMP and APP2 ICC
//! locations, records COM as text, and flags structural anomalies. Entropy
//! coded data is located but never decoded.

use crate::model::{
    push_text, ByteRange, Limits, Reader, Report, TextEncoding, Trailing,
};
use crate::{hex, Fail};

/// Combined APPn/COM payload above this size is flagged `oversized_metadata`.
const MAX_METADATA_TOTAL: usize = 1024 * 1024;
/// APPn segments beyond this count are flagged `many_app_segments`.
const MAX_APP_SEGMENTS: usize = 64;

const XMP_PREFIX: &[u8] = b"http://ns.adobe.com/xap/1.0/\x00";
const XMP_EXT_PREFIX: &[u8] = b"http://ns.adobe.com/xmp/extension/\x00";
const EXIF_PREFIX: &[u8] = b"Exif\x00\x00";
const ICC_PREFIX: &[u8] = b"ICC_PROFILE\x00";

pub(crate) fn parse(data: &[u8], report: &mut Report, limits: &Limits) -> Result<(), Fail> {
    report.region(limits, "SOI", 0, 0);
    let mut reader = Reader::at(data, 2);
    let mut app_segments = 0usize;
    let mut metadata_bytes = 0usize;

    loop {
        if reader.remaining() == 0 {
            report.anomaly("missing_eoi");
            break;
        }
        // Expect a marker introducer. Tolerate garbage by scanning forward to
        // the next 0xFF, but flag it: bytes between segments are anomalous.
        if data[reader.pos] != 0xff {
            let mut scan = reader.pos;
            while scan < data.len() && data[scan] != 0xff {
                scan += 1;
            }
            let span = scan - reader.pos;
            report.anomaly(format!(
                "garbage_data:{}+{}",
                hex(&data[reader.pos..reader.pos + span.min(16)]),
                span
            ));
            if scan == data.len() {
                break;
            }
            reader.pos = scan;
        }
        // Collapse 0xFF fill bytes before the real marker.
        while reader.remaining() >= 2
            && data[reader.pos] == 0xff
            && data[reader.pos + 1] == 0xff
        {
            reader.pos += 1;
        }
        if reader.remaining() < 2 {
            report.anomaly("truncated_marker");
            break;
        }
        let marker_offset = reader.pos;
        let marker = data[marker_offset + 1];
        reader.pos += 2;

        match marker {
            0xd8 => report.anomaly("duplicate_soi"),
            0x00 => report.anomaly("stuffed_ff_outside_scan"),
            0xd9 => {
                report.region(limits, "EOI", marker_offset, 0);
                let end = reader.pos;
                if end < data.len() {
                    let preview_len = (data.len() - end).min(32);
                    report.trailing = Some(Trailing {
                        offset: end as u64,
                        length: (data.len() - end) as u64,
                        hex_preview: hex(&data[end..end + preview_len]),
                    });
                    report.anomaly("trailing_bytes_after_eoi");
                }
                break;
            }
            // Standalone markers carry no length field.
            0x01 => report.region(limits, "TEM", marker_offset, 0),
            0xd0..=0xd7 => report.region(
                limits,
                format!("RST{}", marker - 0xd0),
                marker_offset,
                0,
            ),
            _ => {
                let declared = match reader.be16() {
                    Some(value) => value as usize,
                    None => {
                        report.anomaly("truncated_segment_length");
                        break;
                    }
                };
                if declared < 2 {
                    report.anomaly(format!("invalid_segment_length:{declared}"));
                    break;
                }
                let payload_len = declared - 2;
                let payload_start = reader.pos;
                let segment_end = match payload_start.checked_add(payload_len) {
                    Some(end) => end,
                    None => {
                        report.anomaly("segment_past_eof");
                        break;
                    }
                };
                let name = marker_name(marker);
                if segment_end > data.len() {
                    report.region(limits, name, marker_offset, payload_len);
                    if let Some(region) = report.last_region() {
                        region.length = (data.len() - payload_start) as u64;
                        region.detail =
                            Some("truncated: declared length exceeds remaining input".into());
                    }
                    report.anomaly("segment_past_eof");
                    break;
                }
                let payload = &data[payload_start..segment_end];
                report.region(limits, name, marker_offset, declared);
                if (0xe0..=0xef).contains(&marker) || marker == 0xfe {
                    metadata_bytes += payload_len;
                    if (0xe0..=0xef).contains(&marker) {
                        app_segments += 1;
                    }
                }
                // SOS owns the entropy-coded bytes after its header; the
                // handler returns the offset of the next real marker.
                match handle_segment(data, report, limits, marker, payload, payload_start) {
                    Some(next) => reader.pos = next,
                    None => reader.pos = segment_end,
                }
            }
        }
        if metadata_bytes > MAX_METADATA_TOTAL {
            report.anomaly("oversized_metadata");
            metadata_bytes = usize::MAX; // flag once
        }
        if app_segments > MAX_APP_SEGMENTS {
            report.anomaly("many_app_segments");
            app_segments = usize::MAX;
        }
    }

    Ok(())
}

/// Per-marker payload handling: dimensions from SOFn, EXIF/XMP/ICC locations
/// from APPn, COM to text entries, SOS header + entropy-scan boundary.
/// Returns `Some(next_marker_offset)` when the segment owns bytes beyond its
/// declared length (SOS entropy data), else `None` to continue at the
/// declared segment end.
fn handle_segment(
    data: &[u8],
    report: &mut Report,
    limits: &Limits,
    marker: u8,
    payload: &[u8],
    payload_start: usize,
) -> Option<usize> {
    match marker {
        0xe0 => {
            if payload.starts_with(b"JFIF\x00") && payload.len() >= 7 {
                report.extra.insert(
                    "jfif_version".into(),
                    format!("{}.{}", payload[5], payload[6]).into(),
                );
            }
        }
        0xe1 => {
            if payload.starts_with(EXIF_PREFIX) {
                report.exif = Some(ByteRange {
                    offset: (payload_start + EXIF_PREFIX.len()) as u64,
                    length: (payload.len() - EXIF_PREFIX.len()) as u64,
                });
            } else if payload.starts_with(XMP_PREFIX) {
                report.xmp_present = true;
                push_text(
                    report,
                    limits,
                    "jpeg:APP1/XMP",
                    Some("xmp".to_string()),
                    &payload[XMP_PREFIX.len()..],
                    TextEncoding::Utf8OrHex,
                );
            } else if payload.starts_with(XMP_EXT_PREFIX) {
                report.xmp_present = true;
                push_text(
                    report,
                    limits,
                    "jpeg:APP1/XMP-ext",
                    Some("xmp-ext".to_string()),
                    &payload[XMP_EXT_PREFIX.len()..],
                    TextEncoding::Utf8OrHex,
                );
            }
        }
        0xe2 => {
            if payload.starts_with(ICC_PREFIX) && payload.len() > ICC_PREFIX.len() + 2 {
                report.icc = Some(ByteRange {
                    offset: (payload_start + ICC_PREFIX.len()) as u64,
                    length: (payload.len() - ICC_PREFIX.len()) as u64,
                });
            }
        }
        0xed => {
            if payload.starts_with(b"Photoshop 3.0\x00") {
                report.extra.insert("photoshop_irb".into(), true.into());
            }
        }
        0xee => {
            if payload.starts_with(b"Adobe") {
                report.extra.insert("adobe".into(), true.into());
            }
        }
        0xfe => {
            push_text(report, limits, "jpeg:COM", None, payload, TextEncoding::Utf8OrHex);
        }
        // SOF0..SOF15 excluding DHT(0xC4), JPG(0xC8) and DAC(0xCC).
        0xc0..=0xcf if !matches!(marker, 0xc4 | 0xc8 | 0xcc) => {
            if payload.len() >= 6 {
                report.bit_depth = Some(payload[0] as u32);
                report.height = Some(u16::from_be_bytes([payload[1], payload[2]]) as u64);
                report.width = Some(u16::from_be_bytes([payload[3], payload[4]]) as u64);
                let components = payload[5];
                report.color_type = Some(
                    match components {
                        1 => "grayscale",
                        3 => "ycbcr",
                        4 => "cmyk",
                        _ => "unknown",
                    }
                    .to_string(),
                );
                report
                    .extra
                    .insert("components".into(), (components as u64).into());
                if report.width == Some(0) || report.height == Some(0) {
                    report.anomaly("zero_dimension");
                }
            } else {
                report.anomaly("short_sof");
            }
            if matches!(marker, 0xc1 | 0xc2 | 0xc5 | 0xc6 | 0xc9 | 0xca | 0xcd | 0xce) {
                report.extra.insert("progressive".into(), true.into());
            }
        }
        0xda => {
            // SOS header: component count, per-component selectors, then
            // Ss/Se/AhAl. Entropy data follows the header.
            let header_len = if payload.is_empty() {
                0
            } else {
                let count = payload[0] as usize;
                (1 + count * 2 + 3).min(payload.len())
            };
            let scan_start = payload_start + header_len;
            let scan_end = scan_data_end(data, scan_start);
            report.region(limits, "scan_data", scan_start, scan_end - scan_start);
            return Some(scan_end);
        }
        _ => {}
    }
    None
}

/// Entropy-coded data ends at the first 0xFF not followed by a stuffed 0x00,
/// a restart marker (RST0-7), or another fill 0xFF. Returns the offset of the
/// terminating marker introducer (or EOF on a malformed stream).
fn scan_data_end(data: &[u8], start: usize) -> usize {
    let mut pos = start;
    while pos + 1 < data.len() {
        if data[pos] == 0xff {
            let next = data[pos + 1];
            if next == 0x00 || (0xd0..=0xd7).contains(&next) {
                pos += 2;
                continue;
            }
            if next == 0xff {
                pos += 1;
                continue;
            }
            return pos;
        }
        pos += 1;
    }
    data.len()
}

fn marker_name(marker: u8) -> String {
    match marker {
        0xc0..=0xcf if !matches!(marker, 0xc4 | 0xc8 | 0xcc) => {
            format!("SOF{}", marker - 0xc0)
        }
        0xc4 => "DHT".to_string(),
        0xc8 => "JPG".to_string(),
        0xcc => "DAC".to_string(),
        0xdb => "DQT".to_string(),
        0xdc => "DNL".to_string(),
        0xdd => "DRI".to_string(),
        0xde => "DHP".to_string(),
        0xdf => "EXP".to_string(),
        0xe0..=0xef => format!("APP{}", marker - 0xe0),
        0xfe => "COM".to_string(),
        0xda => "SOS".to_string(),
        _ => format!("0x{marker:02x}"),
    }
}
