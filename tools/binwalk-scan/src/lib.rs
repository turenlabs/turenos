use std::fmt::Write;

const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
const DEFAULT_FINDINGS: usize = 256;
const MAX_FINDINGS: usize = 4096;
const MAX_CANDIDATES: usize = 1_000_000;
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

struct Report {
    schema_version: u32,
    input_bytes: usize,
    findings: Vec<Finding>,
    warnings: Vec<&'static str>,
    truncated: bool,
}

struct Finding {
    signature: &'static str,
    offset: usize,
    size: Option<usize>,
    size_source: &'static str,
    confidence: &'static str,
    description: &'static str,
    validation: &'static str,
}

struct Detection {
    signature: &'static str,
    size: Option<usize>,
    confidence: &'static str,
    description: &'static str,
    validation: &'static str,
}

pub fn binwalk_scan(bytes: &[u8], options_json: &str) -> String {
    if bytes.len() > MAX_INPUT_BYTES {
        return error("input_too_large");
    }

    let max_findings = parse_max_findings(options_json).unwrap_or(DEFAULT_FINDINGS);
    let mut report = Report {
        schema_version: 1,
        input_bytes: bytes.len(),
        findings: Vec::new(),
        warnings: Vec::new(),
        truncated: false,
    };
    let mut candidates = 0;

    for offset in 0..bytes.len() {
        if !could_start(bytes[offset]) {
            continue;
        }
        candidates += 1;
        if candidates > MAX_CANDIDATES {
            report.warnings.push("candidate_limit_reached");
            report.truncated = true;
            break;
        }
        let Some(detection) = detect(bytes, offset) else {
            continue;
        };
        if report.findings.len() >= max_findings {
            report.truncated = true;
            break;
        }
        report.findings.push(Finding {
            signature: detection.signature,
            offset,
            size: detection.size,
            size_source: if detection.size.is_some() {
                "header"
            } else {
                "unknown"
            },
            confidence: detection.confidence,
            description: detection.description,
            validation: detection.validation,
        });
    }

    serialize(report)
}

fn could_start(byte: u8) -> bool {
    matches!(
        byte,
        b'-' | b'0'
            | b'A'
            | b'B'
            | b'H'
            | b'U'
            | b'h'
            | b's'
            | 0x04
            | 0x19
            | 0x1f
            | 0x27
            | 0x28
            | 0x45
            | 0x85
            | 0xd0
            | 0xfd
    )
}

fn detect(bytes: &[u8], offset: usize) -> Option<Detection> {
    detect_squashfs(bytes, offset)
        .or_else(|| detect_jffs2(bytes, offset))
        .or_else(|| detect_ubi(bytes, offset))
        .or_else(|| detect_cramfs(bytes, offset))
        .or_else(|| detect_uimage(bytes, offset))
        .or_else(|| detect_dtb(bytes, offset))
        .or_else(|| detect_android_boot(bytes, offset))
        .or_else(|| detect_trx(bytes, offset))
        .or_else(|| detect_gzip(bytes, offset))
        .or_else(|| detect_xz(bytes, offset))
        .or_else(|| detect_zstd(bytes, offset))
        .or_else(|| detect_bzip2(bytes, offset))
        .or_else(|| detect_lz4(bytes, offset))
        .or_else(|| detect_romfs(bytes, offset))
        .or_else(|| detect_cpio(bytes, offset))
}

fn detect_squashfs(bytes: &[u8], offset: usize) -> Option<Detection> {
    let little = has(bytes, offset, b"hsqs");
    let big = has(bytes, offset, b"sqsh");
    if !little && !big || remaining(bytes, offset) < 96 {
        return None;
    }
    let major = read_u16(bytes, offset + 28, little)?;
    let bytes_used = read_u64(bytes, offset + 40, little)?;
    if major == 0 || !(96..=remaining(bytes, offset) as u64).contains(&bytes_used) {
        return None;
    }
    Some(Detection {
        signature: "squashfs",
        size: usize::try_from(bytes_used).ok(),
        confidence: "high",
        description: "SquashFS filesystem",
        validation: "superblock_version_and_bytes_used",
    })
}

fn detect_jffs2(bytes: &[u8], offset: usize) -> Option<Detection> {
    let little = has(bytes, offset, &[0x85, 0x19]);
    let big = has(bytes, offset, &[0x19, 0x85]);
    if !little && !big || remaining(bytes, offset) < 12 {
        return None;
    }
    let node_type = read_u16(bytes, offset + 2, little)?;
    let total = read_u32(bytes, offset + 4, little)? as usize;
    if node_type == 0 || !(12..=remaining(bytes, offset)).contains(&total) {
        return None;
    }
    Some(Detection {
        signature: "jffs2-node",
        size: Some(total),
        confidence: "high",
        description: "JFFS2 filesystem node",
        validation: "node_type_and_total_length",
    })
}

fn detect_ubi(bytes: &[u8], offset: usize) -> Option<Detection> {
    if !has(bytes, offset, b"UBI#") || remaining(bytes, offset) < 64 {
        return None;
    }
    let version = bytes[offset + 4];
    let vid_offset = read_u32(bytes, offset + 16, false)? as usize;
    let data_offset = read_u32(bytes, offset + 20, false)? as usize;
    if version == 0 || version > 2 || vid_offset < 64 || data_offset <= vid_offset {
        return None;
    }
    Some(Detection {
        signature: "ubi-ec-header",
        size: None,
        confidence: "high",
        description: "UBI erase-counter header",
        validation: "version_and_header_offsets",
    })
}

fn detect_cramfs(bytes: &[u8], offset: usize) -> Option<Detection> {
    let little = has(bytes, offset, &[0x45, 0x3d, 0xcd, 0x28]);
    let big = has(bytes, offset, &[0x28, 0xcd, 0x3d, 0x45]);
    if !little && !big || remaining(bytes, offset) < 64 {
        return None;
    }
    let size = read_u32(bytes, offset + 4, little)? as usize;
    if !(64..=remaining(bytes, offset)).contains(&size) {
        return None;
    }
    Some(Detection {
        signature: "cramfs",
        size: Some(size),
        confidence: "high",
        description: "CramFS filesystem",
        validation: "superblock_size_bounds",
    })
}

fn detect_uimage(bytes: &[u8], offset: usize) -> Option<Detection> {
    if !has(bytes, offset, &[0x27, 0x05, 0x19, 0x56]) || remaining(bytes, offset) < 64 {
        return None;
    }
    let payload = read_u32(bytes, offset + 12, false)? as usize;
    let size = payload.checked_add(64)?;
    if size > remaining(bytes, offset) {
        return None;
    }
    Some(Detection {
        signature: "uboot-uimage",
        size: Some(size),
        confidence: "high",
        description: "legacy U-Boot uImage",
        validation: "header_and_payload_bounds",
    })
}

fn detect_dtb(bytes: &[u8], offset: usize) -> Option<Detection> {
    if !has(bytes, offset, &[0xd0, 0x0d, 0xfe, 0xed]) || remaining(bytes, offset) < 40 {
        return None;
    }
    let size = read_u32(bytes, offset + 4, false)? as usize;
    let struct_offset = read_u32(bytes, offset + 8, false)? as usize;
    let strings_offset = read_u32(bytes, offset + 12, false)? as usize;
    let version = read_u32(bytes, offset + 20, false)?;
    if !(40..=remaining(bytes, offset)).contains(&size)
        || !(40..size).contains(&struct_offset)
        || !(40..size).contains(&strings_offset)
        || version < 16
    {
        return None;
    }
    Some(Detection {
        signature: "devicetree-blob",
        size: Some(size),
        confidence: "high",
        description: "flattened device tree blob",
        validation: "header_offsets_version_and_total_size",
    })
}

fn detect_android_boot(bytes: &[u8], offset: usize) -> Option<Detection> {
    if !has(bytes, offset, b"ANDROID!") || remaining(bytes, offset) < 48 {
        return None;
    }
    let page_size = read_u32(bytes, offset + 36, true)? as usize;
    if !page_size.is_power_of_two() || !(512..=65_536).contains(&page_size) {
        return None;
    }
    Some(Detection {
        signature: "android-boot-image",
        size: None,
        confidence: "medium",
        description: "Android boot image",
        validation: "legacy_header_page_size",
    })
}

fn detect_trx(bytes: &[u8], offset: usize) -> Option<Detection> {
    if !has(bytes, offset, b"HDR0") || remaining(bytes, offset) < 28 {
        return None;
    }
    let size = read_u32(bytes, offset + 4, true)? as usize;
    if !(28..=remaining(bytes, offset)).contains(&size) {
        return None;
    }
    Some(Detection {
        signature: "broadcom-trx",
        size: Some(size),
        confidence: "high",
        description: "Broadcom TRX firmware container",
        validation: "header_length_bounds",
    })
}

fn detect_gzip(bytes: &[u8], offset: usize) -> Option<Detection> {
    if !has(bytes, offset, &[0x1f, 0x8b, 0x08])
        || remaining(bytes, offset) < 10
        || bytes[offset + 3] & 0xe0 != 0
    {
        return None;
    }
    Some(stream(
        "gzip",
        "gzip compressed stream",
        "method_and_reserved_flags",
    ))
}

fn detect_xz(bytes: &[u8], offset: usize) -> Option<Detection> {
    has(bytes, offset, &[0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])
        .then(|| stream("xz", "XZ compressed stream", "complete_stream_header_magic"))
}

fn detect_zstd(bytes: &[u8], offset: usize) -> Option<Detection> {
    has(bytes, offset, &[0x28, 0xb5, 0x2f, 0xfd])
        .then(|| stream("zstd", "Zstandard compressed frame", "frame_magic"))
}

fn detect_bzip2(bytes: &[u8], offset: usize) -> Option<Detection> {
    if !has(bytes, offset, b"BZh") || remaining(bytes, offset) < 10 {
        return None;
    }
    if !(b'1'..=b'9').contains(&bytes[offset + 3]) || !has(bytes, offset + 4, b"1AY&SY") {
        return None;
    }
    Some(stream(
        "bzip2",
        "bzip2 compressed stream",
        "block_size_and_block_magic",
    ))
}

fn detect_lz4(bytes: &[u8], offset: usize) -> Option<Detection> {
    if !has(bytes, offset, &[0x04, 0x22, 0x4d, 0x18]) || remaining(bytes, offset) < 7 {
        return None;
    }
    let block_code = bytes[offset + 5] >> 4;
    if bytes[offset + 4] >> 6 != 1 || !(4..=7).contains(&block_code) {
        return None;
    }
    Some(stream(
        "lz4-frame",
        "LZ4 frame",
        "frame_version_and_block_size_code",
    ))
}

fn detect_romfs(bytes: &[u8], offset: usize) -> Option<Detection> {
    if !has(bytes, offset, b"-rom1fs-") || remaining(bytes, offset) < 17 {
        return None;
    }
    let size = read_u32(bytes, offset + 8, false)? as usize;
    if !(17..=remaining(bytes, offset)).contains(&size)
        || !bytes[offset + 16..offset + size.min(144)].contains(&0)
    {
        return None;
    }
    Some(Detection {
        signature: "romfs",
        size: Some(size),
        confidence: "high",
        description: "ROMFS filesystem",
        validation: "full_size_and_volume_name",
    })
}

fn detect_cpio(bytes: &[u8], offset: usize) -> Option<Detection> {
    if !(has(bytes, offset, b"070701") || has(bytes, offset, b"070702"))
        || remaining(bytes, offset) < 110
    {
        return None;
    }
    let file_size = read_hex(bytes, offset + 54, 8)?;
    let name_size = read_hex(bytes, offset + 94, 8)?;
    if name_size == 0 {
        return None;
    }
    let name_end = 110usize.checked_add(name_size)?;
    let data_start = align4(name_end)?;
    let total = align4(data_start.checked_add(file_size)?)?;
    if total > remaining(bytes, offset) || bytes.get(offset + name_end - 1) != Some(&0) {
        return None;
    }
    Some(Detection {
        signature: "cpio-newc-entry",
        size: Some(total),
        confidence: "high",
        description: "CPIO newc archive entry",
        validation: "hex_header_name_and_payload_bounds",
    })
}

fn stream(
    signature: &'static str,
    description: &'static str,
    validation: &'static str,
) -> Detection {
    Detection {
        signature,
        size: None,
        confidence: "medium",
        description,
        validation,
    }
}

fn has(bytes: &[u8], offset: usize, magic: &[u8]) -> bool {
    bytes.get(offset..offset.saturating_add(magic.len())) == Some(magic)
}

fn remaining(bytes: &[u8], offset: usize) -> usize {
    bytes.len().saturating_sub(offset)
}

fn read_u16(bytes: &[u8], offset: usize, little: bool) -> Option<u16> {
    let value: [u8; 2] = bytes.get(offset..offset + 2)?.try_into().ok()?;
    Some(if little {
        u16::from_le_bytes(value)
    } else {
        u16::from_be_bytes(value)
    })
}

fn read_u32(bytes: &[u8], offset: usize, little: bool) -> Option<u32> {
    let value: [u8; 4] = bytes.get(offset..offset + 4)?.try_into().ok()?;
    Some(if little {
        u32::from_le_bytes(value)
    } else {
        u32::from_be_bytes(value)
    })
}

fn read_u64(bytes: &[u8], offset: usize, little: bool) -> Option<u64> {
    let value: [u8; 8] = bytes.get(offset..offset + 8)?.try_into().ok()?;
    Some(if little {
        u64::from_le_bytes(value)
    } else {
        u64::from_be_bytes(value)
    })
}

fn read_hex(bytes: &[u8], offset: usize, length: usize) -> Option<usize> {
    bytes
        .get(offset..offset + length)?
        .iter()
        .try_fold(0usize, |value, byte| {
            let digit = match byte {
                b'0'..=b'9' => (byte - b'0') as usize,
                b'a'..=b'f' => (byte - b'a' + 10) as usize,
                b'A'..=b'F' => (byte - b'A' + 10) as usize,
                _ => return None,
            };
            value.checked_mul(16)?.checked_add(digit)
        })
}

fn align4(value: usize) -> Option<usize> {
    value.checked_add(3).map(|value| value & !3)
}

fn error(code: &str) -> String {
    format!(r#"{{"schema_version":1,"error":"{code}"}}"#)
}

fn serialize(report: Report) -> String {
    let mut output = format!(
        r#"{{"schema_version":{},"input_bytes":{},"findings":["#,
        report.schema_version, report.input_bytes
    );
    for (index, finding) in report.findings.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        let size = finding
            .size
            .map(|value| value.to_string())
            .unwrap_or_else(|| "null".to_string());
        let _ = write!(
            output,
            r#"{{"signature":"{}","offset":{},"size":{},"size_source":"{}","confidence":"{}","description":"{}","validation":"{}"}}"#,
            finding.signature,
            finding.offset,
            size,
            finding.size_source,
            finding.confidence,
            finding.description,
            finding.validation,
        );
        if output.len() > MAX_OUTPUT_BYTES {
            return format!(
                r#"{{"schema_version":1,"input_bytes":{},"findings":[],"warnings":["output_too_large"],"truncated":true}}"#,
                report.input_bytes
            );
        }
    }
    output.push_str(r#"],"warnings":["#);
    for (index, warning) in report.warnings.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        let _ = write!(output, r#""{warning}""#);
    }
    let _ = write!(output, r#"],"truncated":{}}}"#, report.truncated);
    output
}

fn parse_max_findings(options: &str) -> Option<usize> {
    let key = options.find("\"maxFindings\"")?;
    let value = key + 13 + options[key + 13..].find(':')? + 1;
    let digits = options[value..]
        .trim_start()
        .bytes()
        .take_while(u8::is_ascii_digit)
        .collect::<Vec<_>>();
    let parsed = std::str::from_utf8(&digits).ok()?.parse::<usize>().ok()?;
    Some(parsed.clamp(1, MAX_FINDINGS))
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn bw_alloc(length: usize) -> *mut u8 {
    let bytes = vec![0u8; length].into_boxed_slice();
    let pointer = Box::into_raw(bytes) as *mut u8;
    pointer
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub unsafe extern "C" fn bw_free(pointer: *mut u8, length: usize) {
    drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
        pointer, length,
    )));
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub unsafe extern "C" fn bw_scan(
    input_pointer: *const u8,
    input_length: usize,
    options_pointer: *const u8,
    options_length: usize,
) -> u64 {
    let input = std::slice::from_raw_parts(input_pointer, input_length);
    let options = std::str::from_utf8(std::slice::from_raw_parts(options_pointer, options_length))
        .unwrap_or("{}");
    let output = binwalk_scan(input, options).into_bytes().into_boxed_slice();
    let length = output.len() as u64;
    let pointer = Box::into_raw(output) as *mut u8 as u64;
    (length << 32) | pointer
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub unsafe extern "C" fn bw_free_result(pointer: *mut u8, length: usize) {
    drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
        pointer, length,
    )));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_bounded_firmware_headers() {
        let mut input = vec![0; 256];
        input[16..24].copy_from_slice(b"-rom1fs-");
        input[24..28].copy_from_slice(&64u32.to_be_bytes());
        input[32..37].copy_from_slice(b"root\0");
        input[128..132].copy_from_slice(b"HDR0");
        input[132..136].copy_from_slice(&28u32.to_le_bytes());
        let report = binwalk_scan(&input, "{}");
        assert!(report.contains(r#""signature":"romfs""#));
        assert!(report.contains(r#""signature":"broadcom-trx""#));
    }

    #[test]
    fn rejects_marker_only_decoys() {
        assert!(
            binwalk_scan(b"text UBI# ANDROID! HDR0 hsqs BZh", "{}").contains(r#""findings":[]"#)
        );
    }

    #[test]
    fn truncates_deterministically() {
        let mut input = Vec::new();
        for _ in 0..4 {
            input.extend_from_slice(&[0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0]);
        }
        let report = binwalk_scan(&input, r#"{"maxFindings":2}"#);
        assert_eq!(report.matches(r#""signature":"gzip""#).count(), 2);
        assert!(report.contains(r#""truncated":true"#));
    }
}
