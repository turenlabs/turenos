//! WebP RIFF walker: VP8/VP8L/VP8X dimension extraction, ICCP/EXIF/XMP
//! chunk locations, ANIM/ANMF frame counting, and trailing bytes past the
//! declared RIFF size.

use crate::model::{push_text, ByteRange, Limits, Reader, Report, TextEncoding, Trailing};
use crate::{hex, Fail};

pub(crate) fn parse(data: &[u8], report: &mut Report, limits: &Limits) -> Result<(), Fail> {
    let riff_size = match data.get(4..8) {
        Some(bytes) => u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize,
        None => {
            report.anomaly("truncated_riff_header");
            return Ok(());
        }
    };
    // RIFF size covers everything after the 8-byte size+form header; odd
    // sizes carry a pad byte that is part of the declared size accounting?
    // Per RIFF, the size excludes the pad byte.
    let declared_end = 8usize.saturating_add(riff_size);
    let content_end = declared_end.min(data.len());
    report
        .extra
        .insert("riff_size".into(), (riff_size as u64).into());

    let mut reader = Reader::at(data, 12);
    let mut frames = 0usize;
    let mut seen_image = false;

    while reader.pos + 8 <= content_end {
        let chunk_start = reader.pos;
        let fourcc = reader.take(4).unwrap_or(&[]);
        let size = match reader.le32() {
            Some(value) => value as usize,
            None => break,
        };
        let payload_start = reader.pos;
        let padded = size + (size & 1);
        let chunk_end = match payload_start.checked_add(padded) {
            Some(end) => end,
            None => {
                report.anomaly("chunk_length_past_eof");
                break;
            }
        };
        let available = content_end.saturating_sub(payload_start);
        let name = String::from_utf8_lossy(fourcc).into_owned();
        report.region(limits, name.clone(), chunk_start, size);
        if size > available {
            if let Some(region) = report.last_region() {
                region.length = available as u64;
                region.detail = Some("truncated".into());
            }
            report.anomaly(format!("chunk_length_past_eof:{name}"));
            break;
        }
        let payload = &data[payload_start..payload_start + size];
        match fourcc {
            b"VP8 " => {
                seen_image = true;
                report.color_type = Some("ycbcr".to_string());
                report.bit_depth = Some(8);
                // Lossy frame tag: 3 bytes, then 9D 01 2A, then w/h LE14.
                if payload.len() >= 10 && &payload[3..6] == b"\x9d\x01\x2a" {
                    let w = u16::from_le_bytes([payload[6], payload[7]]) & 0x3fff;
                    let h = u16::from_le_bytes([payload[8], payload[9]]) & 0x3fff;
                    report.width = Some(w as u64);
                    report.height = Some(h as u64);
                } else {
                    report.anomaly("bad_vp8_frame_tag");
                }
                report.extra.insert("variant".into(), "lossy".into());
            }
            b"VP8L" => {
                seen_image = true;
                report.color_type = Some("rgba".to_string());
                report.bit_depth = Some(8);
                // Lossless: 0x2F signature, then 14-bit w/h minus 1 packed LE.
                if payload.len() >= 5 && payload[0] == 0x2f {
                    let packed = u32::from_le_bytes([
                        payload[1], payload[2], payload[3], payload[4],
                    ]);
                    report.width = Some(((packed & 0x3fff) + 1) as u64);
                    report.height = Some((((packed >> 14) & 0x3fff) + 1) as u64);
                } else {
                    report.anomaly("bad_vp8l_signature");
                }
                report.extra.insert("variant".into(), "lossless".into());
            }
            b"VP8X" => {
                report.extra.insert("variant".into(), "extended".into());
                if payload.len() >= 10 {
                    let flags = payload[0];
                    if flags & 0x20 != 0 {
                        report.extra.insert("icc_flag".into(), true.into());
                    }
                    if flags & 0x10 != 0 {
                        report.extra.insert("alpha".into(), true.into());
                    }
                    if flags & 0x08 != 0 {
                        report.extra.insert("exif_flag".into(), true.into());
                    }
                    if flags & 0x04 != 0 {
                        report.xmp_present = true;
                    }
                    if flags & 0x02 != 0 {
                        report.extra.insert("animated".into(), true.into());
                    }
                    let w = (payload[4] as u32)
                        | ((payload[5] as u32) << 8)
                        | ((payload[6] as u32) << 16);
                    let h = (payload[7] as u32)
                        | ((payload[8] as u32) << 8)
                        | ((payload[9] as u32) << 16);
                    report.width = Some((w + 1) as u64);
                    report.height = Some((h + 1) as u64);
                } else {
                    report.anomaly("short_vp8x");
                }
            }
            b"ICCP" => {
                report.icc = Some(ByteRange {
                    offset: payload_start as u64,
                    length: size as u64,
                });
            }
            b"EXIF" => {
                report.exif = Some(locate_tiff(payload, payload_start));
            }
            b"XMP " => {
                report.xmp_present = true;
                push_text(
                    report,
                    limits,
                    "webp:XMP",
                    Some("xmp".to_string()),
                    payload,
                    TextEncoding::Utf8OrHex,
                );
            }
            b"ANIM" => {
                report.extra.insert("animated".into(), true.into());
            }
            b"ANMF" => {
                frames += 1;
                report.extra.insert("animated".into(), true.into());
            }
            b"ALPH" => {
                report.extra.insert("alpha".into(), true.into());
            }
            _ => {
                if fourcc.first().map(|b| b.is_ascii_uppercase()).unwrap_or(false) {
                    report.anomaly(format!("unknown_chunk:{name}"));
                }
            }
        }
        reader.pos = chunk_end;
    }

    if !seen_image {
        report.warning("no VP8/VP8L image chunk found".to_string());
    }
    if frames > 0 {
        report.extra.insert("frames".into(), (frames as u64).into());
    }
    if declared_end < data.len() {
        let preview_len = (data.len() - declared_end).min(32);
        report.trailing = Some(Trailing {
            offset: declared_end as u64,
            length: (data.len() - declared_end) as u64,
            hex_preview: hex(&data[declared_end..declared_end + preview_len]),
        });
        report.anomaly("trailing_bytes_after_riff");
    } else if declared_end > data.len() {
        report.anomaly("riff_size_past_eof");
    }
    Ok(())
}

/// A WebP EXIF chunk should hold a raw TIFF block, but some encoders prepend
/// a u32 offset. If TIFF magic is not at offset 0, scan the first 16 bytes
/// for it and point the range at the real header.
fn locate_tiff(payload: &[u8], payload_start: usize) -> ByteRange {
    let mut start = 0usize;
    if !is_tiff_magic(payload) {
        for index in 1..payload.len().min(16) {
            if is_tiff_magic(&payload[index..]) {
                start = index;
                break;
            }
        }
    }
    ByteRange {
        offset: (payload_start + start) as u64,
        length: payload.len().saturating_sub(start) as u64,
    }
}

pub(crate) fn is_tiff_magic(bytes: &[u8]) -> bool {
    bytes.starts_with(b"II*\x00") || bytes.starts_with(b"MM\x00*")
}
