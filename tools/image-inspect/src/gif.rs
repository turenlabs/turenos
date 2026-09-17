//! GIF block walker: logical screen descriptor, global/local color tables,
//! image descriptors (frame count), extensions (comment text, NETSCAPE loop,
//! graphic control, plain text), trailer, and trailing bytes after it.

use crate::model::{push_text, Limits, Reader, Report, TextEncoding, Trailing};
use crate::{hex, Fail};

pub(crate) fn parse(data: &[u8], report: &mut Report, limits: &Limits) -> Result<(), Fail> {
    let mut reader = Reader::new(data);
    let header = match reader.take(6) {
        Some(value) => value,
        None => {
            report.anomaly("truncated_header");
            return Ok(());
        }
    };
    let version = match &header[3..6] {
        b"87a" => "87a",
        b"89a" => "89a",
        _ => "unknown",
    };
    report
        .extra
        .insert("gif_version".into(), version.into());
    report.region(limits, "header", 0, 6);

    // Logical Screen Descriptor
    let (width, height) = match (reader.le16(), reader.le16()) {
        (Some(w), Some(h)) => (w, h),
        _ => {
            report.anomaly("truncated_lsd");
            return Ok(());
        }
    };
    report.width = Some(width as u64);
    report.height = Some(height as u64);
    let packed = reader.u8().unwrap_or(0);
    let gct_flag = packed & 0x80 != 0;
    let gct_entries = if gct_flag { 1usize << ((packed & 0x07) + 1) } else { 0 };
    report.bit_depth = Some(((packed >> 4) & 0x07) as u32 + 1);
    report.color_type = Some("palette".to_string());
    report
        .extra
        .insert("global_color_table_entries".into(), (gct_entries as u64).into());
    let _bg = reader.u8(); // background color index
    let _aspect = reader.u8(); // pixel aspect ratio
    report.region(limits, "logical_screen_descriptor", 6, 7);

    if gct_flag {
        let gct_start = reader.pos;
        let gct_len = gct_entries * 3;
        if reader.skip(gct_len).is_none() {
            report.region(limits, "global_color_table", gct_start, gct_len);
            if let Some(region) = report.last_region() {
                region.length = reader.remaining() as u64;
                region.detail = Some("truncated".into());
            }
            report.anomaly("truncated_global_color_table");
            return Ok(());
        }
        report.region(limits, "global_color_table", gct_start, gct_len);
    }

    let mut frames = 0usize;
    let mut interlaced = false;
    let mut animated_flag = false;
    let mut terminated = false;

    loop {
        let block_start = reader.pos;
        let introducer = match reader.u8() {
            Some(value) => value,
            None => {
                report.anomaly("missing_trailer");
                break;
            }
        };
        match introducer {
            0x3b => {
                report.region(limits, "trailer", block_start, 0);
                terminated = true;
                let end = reader.pos;
                if end < data.len() {
                    let preview_len = (data.len() - end).min(32);
                    report.trailing = Some(Trailing {
                        offset: end as u64,
                        length: (data.len() - end) as u64,
                        hex_preview: hex(&data[end..end + preview_len]),
                    });
                    report.anomaly("trailing_bytes_after_trailer");
                }
                break;
            }
            0x2c => {
                // Image descriptor: 9 bytes then optional LCT, then LZW min
                // code + data sub-blocks.
                let descriptor = match reader.take(9) {
                    Some(value) => value,
                    None => {
                        report.anomaly("truncated_image_descriptor");
                        break;
                    }
                };
                let fw = u16::from_le_bytes([descriptor[4], descriptor[5]]);
                let fh = u16::from_le_bytes([descriptor[6], descriptor[7]]);
                let fpacked = descriptor[8];
                if fpacked & 0x40 != 0 {
                    interlaced = true;
                }
                if fpacked & 0x80 != 0 {
                    let lct_len = 3usize * (1usize << ((fpacked & 0x07) + 1));
                    if reader.skip(lct_len).is_none() {
                        report.anomaly("truncated_local_color_table");
                        break;
                    }
                }
                if reader.u8().is_none() {
                    report.anomaly("truncated_image_data");
                    break;
                }
                match skip_sub_blocks(&mut reader) {
                    Some(_) => {}
                    None => {
                        report.anomaly("truncated_sub_blocks");
                        break;
                    }
                }
                frames += 1;
                report.region(
                    limits,
                    "image",
                    block_start,
                    reader.pos - block_start,
                );
                if let Some(region) = report.last_region() {
                    let mut detail = format!("{fw}x{fh}");
                    if fpacked & 0x40 != 0 {
                        detail.push_str(" interlaced");
                    }
                    if fpacked & 0x80 != 0 {
                        detail.push_str(" local-palette");
                    }
                    region.detail = Some(detail);
                }
            }
            0x21 => {
                let label = match reader.u8() {
                    Some(value) => value,
                    None => {
                        report.anomaly("truncated_extension");
                        break;
                    }
                };
                let (name, detail) = match label {
                    0xf9 => {
                        // GCE: size(4) + packed + delay(2) + transparent +
                        // terminator — 6 bytes after the label.
                        match reader.take(6) {
                            Some(b) if b[0] == 4 => {
                                let delay = u16::from_le_bytes([b[2], b[3]]);
                                (
                                    "graphic_control",
                                    Some(format!("delay_cs:{delay}")),
                                )
                            }
                            _ => ("graphic_control", Some("malformed".to_string())),
                        }
                    }
                    0xfe => {
                        let mut text = Vec::new();
                        let ok = read_sub_blocks(&mut reader, &mut text, limits.max_text_bytes + 1);
                        if ok {
                            push_text(
                                report,
                                limits,
                                "gif:comment",
                                None,
                                &text,
                                TextEncoding::Utf8OrHex,
                            );
                        }
                        ("comment", if ok { None } else { Some("truncated".to_string()) })
                    }
                    0xff => {
                        // Application extension: 11-byte identifier block then
                        // data sub-blocks.
                        let id = reader.take(12); // block size (11) + identifier
                        let ident = match id {
                            Some(b) if b[0] == 11 => String::from_utf8_lossy(&b[1..12])
                                .trim_end_matches('\x00')
                                .to_string(),
                            _ => String::new(),
                        };
                        if ident.starts_with("NETSCAPE") || ident.starts_with("ANIMEXTS") {
                            animated_flag = true;
                        }
                        match skip_sub_blocks(&mut reader) {
                            Some(_) => {}
                            None => {
                                report.anomaly("truncated_sub_blocks");
                                break;
                            }
                        }
                        ("application", if ident.is_empty() { None } else { Some(ident) })
                    }
                    0x01 => {
                        // Plain text: 12-byte header then text sub-blocks.
                        if reader.skip(12).is_none() {
                            report.anomaly("truncated_plain_text");
                            break;
                        }
                        let mut text = Vec::new();
                        if read_sub_blocks(&mut reader, &mut text, limits.max_text_bytes + 1) {
                            push_text(
                                report,
                                limits,
                                "gif:plain_text",
                                None,
                                &text,
                                TextEncoding::Utf8OrHex,
                            );
                        }
                        ("plain_text", None)
                    }
                    _ => {
                        match skip_sub_blocks(&mut reader) {
                            Some(_) => {}
                            None => {
                                report.anomaly("truncated_sub_blocks");
                                break;
                            }
                        }
                        ("extension", Some(format!("label_0x{label:02x}")))
                    }
                };
                report.region(limits, name, block_start, reader.pos - block_start);
                if let (Some(region), Some(detail)) = (report.last_region(), detail) {
                    region.detail = Some(detail);
                }
            }
            other => {
                report.anomaly(format!("unknown_block_0x{other:02x}"));
                break;
            }
        }
    }

    if !terminated && report.trailing.is_none() && reader.remaining() == 0 {
        // ended cleanly at EOF without a trailer — already flagged
    }
    report.extra.insert("frames".into(), (frames as u64).into());
    if interlaced {
        report.extra.insert("interlaced".into(), true.into());
    }
    if animated_flag || frames > 1 {
        report.extra.insert("animated".into(), true.into());
    }
    Ok(())
}

/// Skip a GIF data sub-block chain (`len u8` + `len` bytes, terminated by 0).
/// Returns bytes consumed after the introducer, or `None` when the chain runs
/// past the end of input.
fn skip_sub_blocks(reader: &mut Reader) -> Option<usize> {
    let start = reader.pos;
    loop {
        let size = reader.u8()?;
        if size == 0 {
            return Some(reader.pos - start);
        }
        reader.skip(size as usize)?;
    }
}

/// Same walk but copies payload bytes into `out`, capped at `cap` bytes.
fn read_sub_blocks(reader: &mut Reader, out: &mut Vec<u8>, cap: usize) -> bool {
    loop {
        let size = match reader.u8() {
            Some(value) => value as usize,
            None => return false,
        };
        if size == 0 {
            return true;
        }
        let block = match reader.take(size) {
            Some(value) => value,
            None => return false,
        };
        let keep = cap.saturating_sub(out.len());
        out.extend_from_slice(&block[..block.len().min(keep)]);
    }
}
