//! Motorola S-Record (SREC/S19) parsing and image flattening.
//!
//! Each line is `S<type><count><addr><data><checksum>`: `count` covers the
//! address, data, and checksum bytes, and the checksum is the one's
//! complement of the low byte of the sum of all counted bytes. S1/S2/S3 carry
//! data at 2/3/4-byte addresses, S0 is a header comment, S5/S6 declare the
//! data record count, and S9/S8/S7 carry the execution start address.
//!
//! `parse` reports records, a merged address-range map, and the gaps between
//! ranges. `flatten` produces one contiguous image over
//! `[min_address, max_address]` with gaps filled by `fill` (default 0xFF);
//! the output base is `min_address` from the parse report.

use serde_json::{json, Value};

use crate::{error_json, hex};

pub(crate) struct ParseOptions {
    pub max_records: usize,
}

pub(crate) struct FlattenOptions {
    pub fill: u8,
    pub ignore_checksums: bool,
    pub max_output_bytes: u64,
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn invalid_record(line: usize, offset: usize, detail: &str) -> String {
    error_json(
        "invalid_record",
        json!({ "line": line, "offset": offset, "detail": detail }),
    )
}

fn trim(line: &[u8]) -> &[u8] {
    let start = line
        .iter()
        .position(|&b| !matches!(b, b' ' | b'\t' | b'\r'))
        .unwrap_or(line.len());
    let end = line
        .iter()
        .rposition(|&b| !matches!(b, b' ' | b'\t' | b'\r'))
        .map(|index| index + 1)
        .unwrap_or(start);
    &line[start..end]
}

/// Address-field length in bytes for each known record type.
fn addr_len(rtype: u8) -> Option<usize> {
    match rtype {
        0 | 1 | 5 | 9 => Some(2),
        2 | 6 | 8 => Some(3),
        3 | 7 => Some(4),
        _ => None,
    }
}

fn type_name(rtype: u8) -> &'static str {
    match rtype {
        0 => "header",
        1 => "data16",
        2 => "data24",
        3 => "data32",
        5 => "count16",
        6 => "count24",
        7 => "start32",
        8 => "start24",
        9 => "start16",
        _ => "unknown",
    }
}

#[derive(Default)]
struct Inner {
    records: Vec<Value>,
    records_truncated: bool,
    record_count: usize,
    data_ranges: Vec<(u64, u64)>,
    data_blobs: Vec<(u64, Vec<u8>)>,
    data_bytes: u64,
    data_records: usize,
    header: Option<String>,
    declared_count: Option<u64>,
    start_address: Option<u64>,
    start_kind: Option<&'static str>,
    invalid_checksums: usize,
    unknown_types: usize,
    warnings: Vec<String>,
}

fn inner(bytes: &[u8], record_cap: usize, collect_blobs: bool) -> Result<Inner, String> {
    let mut it = Inner::default();
    let mut line_no = 0usize;
    let mut pos = 0usize;

    for raw_line in bytes.split(|&byte| byte == b'\n') {
        line_no += 1;
        let line_start = pos;
        pos += raw_line.len() + 1;
        let line = trim(raw_line);
        if line.is_empty() {
            continue;
        }
        if line[0] != b'S' || line.len() < 2 || !line[1].is_ascii_digit() {
            return Err(invalid_record(
                line_no,
                line_start,
                "record does not start with 'S' plus a digit",
            ));
        }
        let rtype = line[1] - b'0';
        let hexpart = &line[2..];
        if hexpart.len() < 4 || hexpart.len() % 2 != 0 {
            return Err(invalid_record(
                line_no,
                line_start,
                "record has odd or too-short hex payload",
            ));
        }
        let mut record = Vec::with_capacity(hexpart.len() / 2);
        for pair in hexpart.chunks_exact(2) {
            match (hex_value(pair[0]), hex_value(pair[1])) {
                (Some(hi), Some(lo)) => record.push((hi << 4) | lo),
                _ => {
                    return Err(invalid_record(
                        line_no,
                        line_start,
                        "non-hexadecimal character in record",
                    ))
                }
            }
        }
        let count = record[0] as usize;
        if record.len() != count + 1 {
            return Err(invalid_record(
                line_no,
                line_start,
                "count does not match record length",
            ));
        }
        // The checksum is the one's complement of the low byte of the sum of
        // the count, address, and data bytes; a valid record sums to 0xFF.
        let sum: u32 = record.iter().map(|&b| b as u32).sum();
        let checksum_valid = sum & 0xff == 0xff;
        if !checksum_valid {
            it.invalid_checksums += 1;
        }

        let Some(alen) = addr_len(rtype) else {
            it.unknown_types += 1;
            it.record_count += 1;
            if it.records.len() < record_cap {
                it.records.push(json!({
                    "index": it.record_count - 1,
                    "offset": line_start,
                    "line": line_no,
                    "type": "unknown",
                    "record_type": rtype,
                    "address": Value::Null,
                    "byte_count": count,
                    "checksum_valid": checksum_valid,
                }));
            } else {
                it.records_truncated = true;
            }
            continue;
        };

        if count < alen + 1 {
            return Err(invalid_record(
                line_no,
                line_start,
                "count too small for the record's address field",
            ));
        }
        let data_len = count - alen - 1;
        let mut address = 0u64;
        for &byte in &record[1..1 + alen] {
            address = (address << 8) | byte as u64;
        }
        let data = &record[1 + alen..1 + alen + data_len];

        let mut address_json = json!(hex(address));
        match rtype {
            0 => {
                if it.header.is_none() && data_len > 0 {
                    let text: String = data
                        .iter()
                        .take(512)
                        .map(|&b| if (0x20..=0x7e).contains(&b) { b as char } else { '?' })
                        .collect();
                    it.header = Some(text);
                }
            }
            1 | 2 | 3 => {
                if data_len > 0 {
                    it.data_ranges
                        .push((address, address + data_len as u64));
                    it.data_records += 1;
                    it.data_bytes += data_len as u64;
                    if collect_blobs {
                        it.data_blobs.push((address, data.to_vec()));
                    }
                }
            }
            5 | 6 => {
                if it.declared_count.is_none() {
                    it.declared_count = Some(address);
                }
                address_json = json!(hex(address));
            }
            7 | 8 | 9 => {
                it.start_address = Some(address);
                it.start_kind = Some(match rtype {
                    7 => "s7",
                    8 => "s8",
                    _ => "s9",
                });
            }
            // addr_len() already returned early for any other type.
            _ => {}
        }

        it.record_count += 1;
        if it.records.len() < record_cap {
            it.records.push(json!({
                "index": it.record_count - 1,
                "offset": line_start,
                "line": line_no,
                "type": type_name(rtype),
                "record_type": rtype,
                "address": address_json,
                "byte_count": data_len,
                "checksum_valid": checksum_valid,
            }));
        } else {
            it.records_truncated = true;
        }
    }

    if let Some(declared) = it.declared_count {
        if declared != it.data_records as u64 {
            it.warnings.push(format!(
                "count_mismatch: declared {declared}, parsed {}",
                it.data_records
            ));
        }
    }
    if it.unknown_types > 0 {
        it.warnings
            .push(format!("unknown_record_types:{}", it.unknown_types));
    }
    Ok(it)
}

/// Merge sorted ranges (overlapping or adjacent coalesce), then derive gaps.
fn merged_ranges(ranges: &mut Vec<(u64, u64)>) -> (Vec<(u64, u64)>, Vec<(u64, u64)>) {
    ranges.sort_unstable();
    let mut merged: Vec<(u64, u64)> = Vec::with_capacity(ranges.len());
    for &(start, end) in ranges.iter() {
        if let Some(last) = merged.last_mut() {
            if start <= last.1 {
                last.1 = last.1.max(end);
                continue;
            }
        }
        merged.push((start, end));
    }
    let mut gaps = Vec::new();
    for pair in merged.windows(2) {
        gaps.push((pair[0].1, pair[1].0));
    }
    (merged, gaps)
}

pub(crate) fn parse(bytes: &[u8], options: &ParseOptions) -> Result<Value, String> {
    let mut it = inner(bytes, options.max_records, false)?;

    let (merged, gaps) = merged_ranges(&mut it.data_ranges);
    let range_values: Vec<Value> = merged
        .iter()
        .take(crate::MAX_LIST_ITEMS)
        .map(|&(start, end)| {
            json!({ "start": hex(start), "end": hex(end), "size": end - start })
        })
        .collect();
    let gap_values: Vec<Value> = gaps
        .iter()
        .take(crate::MAX_LIST_ITEMS)
        .map(|&(start, end)| {
            json!({ "start": hex(start), "end": hex(end), "size": end - start })
        })
        .collect();
    let ranges_truncated = merged.len() > range_values.len() || gaps.len() > gap_values.len();
    if ranges_truncated {
        it.warnings.push("range_list_truncated".into());
    }
    if it.records_truncated {
        it.warnings.push("record_list_truncated".into());
    }

    let min_address = merged.first().map(|range| range.0);
    let max_address = merged.last().map(|range| range.1);
    let image_bytes: u64 = merged.iter().map(|range| range.1 - range.0).sum();

    let count_check = it.declared_count.map(|declared| {
        json!({
            "declared": declared,
            "actual": it.data_records,
            "valid": declared == it.data_records as u64,
        })
    });

    Ok(json!({
        "schema_version": 1,
        "kind": "srec",
        "input_bytes": bytes.len(),
        "record_count": it.record_count,
        "data_record_count": it.data_records,
        "data_bytes": it.data_bytes,
        "header": it.header,
        "records": it.records,
        "ranges": range_values,
        "range_count": merged.len(),
        "gaps": gap_values,
        "gap_count": gaps.len(),
        "min_address": min_address.map(hex),
        "max_address": max_address.map(hex),
        "image_bytes": image_bytes,
        "start_address": it.start_address.map(hex),
        "start_address_kind": it.start_kind,
        "count_check": count_check,
        "invalid_checksums": it.invalid_checksums,
        "unknown_record_types": it.unknown_types,
        "truncated": it.records_truncated || ranges_truncated,
        "warnings": it.warnings,
    }))
}

pub(crate) fn flatten(bytes: &[u8], options: &FlattenOptions) -> Result<Vec<u8>, String> {
    let it = inner(bytes, 0, true)?;
    if it.invalid_checksums > 0 && !options.ignore_checksums {
        return Err(error_json(
            "checksum_mismatch",
            json!({ "invalid_checksums": it.invalid_checksums }),
        ));
    }
    if it.data_blobs.is_empty() {
        return Ok(Vec::new());
    }
    let min = it
        .data_blobs
        .iter()
        .map(|blob| blob.0)
        .min()
        .unwrap_or(0);
    let max = it
        .data_blobs
        .iter()
        .map(|blob| blob.0 + blob.1.len() as u64)
        .max()
        .unwrap_or(0);
    let size = max - min;
    if size > options.max_output_bytes {
        return Err(error_json(
            "output_too_large",
            json!({ "size": size, "limit": options.max_output_bytes }),
        ));
    }
    let mut out = vec![options.fill; size as usize];
    for (address, blob) in &it.data_blobs {
        let start = (address - min) as usize;
        out[start..start + blob.len()].copy_from_slice(blob);
    }
    Ok(out)
}
