//! PNG chunk walker: IHDR fields, the full chunk table with CRC validation,
//! tEXt/zTXt/iTXt text decode, eXIf/iCCP location, APNG detection, trailing
//! bytes after IEND, and structural anomaly flags. Parse-only — IDAT payloads
//! are measured, never inflated.

use crate::model::{
    inflate_bounded, push_text, split_keyword, ByteRange, Limits, Reader, Report, TextEncoding,
    Trailing,
};
use crate::{hex, Fail};

/// Non-IDAT chunk payloads above this size are flagged `oversized_metadata`.
const MAX_METADATA_CHUNK: usize = 1024 * 1024;

const KNOWN_CRITICAL: &[&[u8; 4]] = &[b"IHDR", b"PLTE", b"IDAT", b"IEND"];

pub(crate) fn parse(data: &[u8], report: &mut Report, limits: &Limits) -> Result<(), Fail> {
    let mut reader = Reader::at(data, 8);
    let mut first_chunk = true;
    let mut seen_ihdr = false;
    let mut seen_iend = false;
    // 0 = before IDAT run, 1 = inside a consecutive IDAT run, 2 = run ended.
    let mut idat_phase = 0u8;
    let mut idat_chunks = 0usize;
    let mut idat_bytes = 0u64;
    let mut after_iend = 0usize;

    loop {
        let chunk_start = reader.pos;
        if reader.remaining() == 0 {
            if !seen_iend {
                report.anomaly("missing_iend");
            }
            break;
        }
        if reader.remaining() < 8 {
            if seen_iend {
                set_trailing(report, data, chunk_start);
            } else {
                report.anomaly("truncated_chunk_header");
            }
            break;
        }

        let length = match reader.be32() {
            Some(value) => value as usize,
            None => {
                report.anomaly("truncated_chunk_header");
                break;
            }
        };
        let type_start = reader.pos;
        let type_bytes = reader.take(4).unwrap_or(&[]);
        let name = String::from_utf8_lossy(type_bytes).into_owned();

        // Chunk types are defined as ASCII letters; anything else signals a
        // damaged or non-PNG stream.
        if !type_bytes.iter().all(|byte| byte.is_ascii_alphabetic()) {
            report.anomaly(format!("invalid_chunk_type:{}", hex(type_bytes)));
        }
        let critical = type_bytes
            .first()
            .map(|byte| byte.is_ascii_uppercase())
            .unwrap_or(false);
        if seen_iend {
            after_iend += 1;
        }

        let payload_len = length;
        let payload_available = reader.remaining().saturating_sub(4); // minus CRC
        let stored = payload_len <= payload_available;

        report.region(limits, name.clone(), chunk_start, payload_len);
        if let Some(region) = report.last_region() {
            region.critical = Some(critical);
            if !stored {
                region.length = payload_available as u64;
                region.detail = Some("truncated: declared length exceeds remaining input".into());
            }
        }

        if !stored {
            report.anomaly(format!("chunk_length_past_eof:{name}"));
            break;
        }
        let payload = reader.take(payload_len).unwrap_or(&[]);
        let stored_crc = match reader.be32() {
            Some(value) => value,
            None => {
                report.anomaly("truncated_chunk_crc");
                break;
            }
        };
        let computed = crc32fast::hash(&data[type_start..type_start + 4 + payload_len]);
        if let Some(region) = report.last_region() {
            region.crc_valid = Some(computed == stored_crc);
        }
        if computed != stored_crc {
            report.anomaly(format!("crc_mismatch:{name}"));
        }

        if first_chunk && type_bytes != b"IHDR" {
            report.anomaly("first_chunk_not_ihdr");
        }
        match type_bytes {
            b"IHDR" => {
                if seen_ihdr {
                    report.anomaly("duplicate_ihdr");
                }
                seen_ihdr = true;
                if payload.len() >= 13 {
                    report.width = Some(u32::from_be_bytes([
                        payload[0], payload[1], payload[2], payload[3],
                    ]) as u64);
                    report.height = Some(u32::from_be_bytes([
                        payload[4], payload[5], payload[6], payload[7],
                    ]) as u64);
                    report.bit_depth = Some(payload[8] as u32);
                    report.color_type =
                        Some(png_color_type(payload[9]).to_string());
                    if payload[12] != 0 {
                        report
                            .extra
                            .insert("interlaced".into(), (payload[12] == 1).into());
                        if payload[12] > 1 {
                            report.anomaly("invalid_interlace_method");
                        }
                    }
                    if report.width == Some(0) || report.height == Some(0) {
                        report.anomaly("zero_dimension");
                    }
                } else {
                    report.anomaly("short_ihdr");
                }
            }
            b"PLTE" => {
                report.extra.insert("palette".into(), true.into());
            }
            b"IDAT" => {
                if idat_phase == 2 {
                    report.anomaly("non_consecutive_idat");
                }
                idat_phase = 1;
                idat_chunks += 1;
                idat_bytes += payload_len as u64;
            }
            b"IEND" => {
                seen_iend = true;
                if payload_len != 0 {
                    report.anomaly("nonempty_iend");
                }
            }
            b"tEXt" => {
                let (keyword, value) = split_keyword(payload);
                push_text(
                    report,
                    limits,
                    "png:tEXt",
                    keyword,
                    value,
                    TextEncoding::Latin1,
                );
            }
            b"zTXt" => {
                let (keyword, rest) = split_keyword(payload);
                match rest.split_first() {
                    Some((0, compressed)) => {
                        match inflate_bounded(compressed, limits.max_inflate_bytes) {
                            Some(text) => push_text(
                                report,
                                limits,
                                "png:zTXt",
                                keyword,
                                &text,
                                TextEncoding::Latin1,
                            ),
                            None => {
                                report.warning(format!(
                                    "zTXt inflate failed or exceeded limit (keyword {})",
                                    keyword.clone().unwrap_or_default()
                                ));
                                report.texts_total += 1;
                            }
                        }
                    }
                    _ => report.anomaly("ztxt_bad_compression_method"),
                }
            }
            b"iTXt" => parse_itxt(report, limits, payload),
            b"eXIf" => {
                report.exif = Some(ByteRange {
                    offset: (chunk_start + 8) as u64,
                    length: payload_len as u64,
                });
            }
            b"iCCP" => {
                report.icc = Some(ByteRange {
                    offset: (chunk_start + 8) as u64,
                    length: payload_len as u64,
                });
            }
            b"acTL" => {
                report.extra.insert("animated".into(), true.into());
            }
            b"tIME" => {
                if payload.len() >= 7 {
                    let year = u16::from_be_bytes([payload[0], payload[1]]);
                    report.extra.insert(
                        "modified".into(),
                        format!(
                            "{:04}-{:02}-{:02} {:02}:{:02}:{:02}Z",
                            year, payload[2], payload[3], payload[4], payload[5], payload[6]
                        )
                        .into(),
                    );
                }
            }
            _ => {
                if critical
                    && !KNOWN_CRITICAL.iter().any(|known| known.as_slice() == type_bytes)
                {
                    report.anomaly(format!("unknown_critical_chunk:{name}"));
                }
            }
        }

        if type_bytes != b"IDAT" && idat_phase == 1 {
            idat_phase = 2;
        }
        if type_bytes != b"IDAT" && payload_len > MAX_METADATA_CHUNK {
            report.anomaly(format!("oversized_metadata:{name}"));
        }
        first_chunk = false;
    }

    if !seen_ihdr {
        report.anomaly("missing_ihdr");
    }
    if after_iend > 0 {
        report.anomaly(format!("chunks_after_iend:{after_iend}"));
    }
    if seen_iend && report.trailing.is_none() {
        set_trailing(report, data, reader.pos);
    }
    if idat_chunks > 0 {
        report
            .extra
            .insert("idat_chunks".into(), idat_chunks.into());
        report
            .extra
            .insert("idat_bytes".into(), idat_bytes.into());
    }
    Ok(())
}

/// iTXt payload: `keyword\0 comp_flag comp_method language\0 translated\0 text`.
fn parse_itxt(report: &mut Report, limits: &Limits, payload: &[u8]) {
    let (keyword, rest) = split_keyword(payload);
    if rest.len() < 2 {
        report.anomaly("short_itxt");
        return;
    }
    let compressed = rest[0] == 1;
    if rest[0] > 1 || rest[1] != 0 {
        report.anomaly("itxt_bad_compression_field");
    }
    let after_flags = &rest[2..];
    let language_len = after_flags
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(after_flags.len());
    let after_language = match after_flags.get(language_len + 1..) {
        Some(slice) => slice,
        None => {
            report.anomaly("short_itxt");
            return;
        }
    };
    let translated_len = after_language
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(after_language.len());
    let text_bytes = after_language
        .get(translated_len + 1..)
        .unwrap_or(&[]);
    let decoded = if compressed {
        match inflate_bounded(text_bytes, limits.max_inflate_bytes) {
            Some(value) => value,
            None => {
                report.warning(format!(
                    "iTXt inflate failed or exceeded limit (keyword {})",
                    keyword.clone().unwrap_or_default()
                ));
                report.texts_total += 1;
                return;
            }
        }
    } else {
        text_bytes.to_vec()
    };
    push_text(
        report,
        limits,
        "png:iTXt",
        keyword,
        &decoded,
        TextEncoding::Utf8OrHex,
    );
}

fn set_trailing(report: &mut Report, data: &[u8], from: usize) {
    let from = from.min(data.len());
    if from < data.len() {
        let preview_len = (data.len() - from).min(32);
        report.trailing = Some(Trailing {
            offset: from as u64,
            length: (data.len() - from) as u64,
            hex_preview: hex(&data[from..from + preview_len]),
        });
        report.anomaly("trailing_bytes_after_iend");
    }
}

fn png_color_type(value: u8) -> &'static str {
    match value {
        0 => "grayscale",
        2 => "rgb",
        3 => "palette",
        4 => "grayscale-alpha",
        6 => "rgba",
        _ => "invalid",
    }
}

