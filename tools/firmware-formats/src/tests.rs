//! Unit tests. Every fixture is fabricated in test code — the formats are
//! small and fully documented, so no binary test files are needed.

use super::*;

fn json(result: Result<String, String>) -> Value {
    let text = result.unwrap_or_else(|error| panic!("unexpected error: {error}"));
    serde_json::from_str(&text).expect("result is JSON")
}

fn err_code(result: Result<String, String>) -> String {
    let doc: Value = serde_json::from_str(&result.expect_err("expected an error"))
        .expect("error is JSON");
    assert_eq!(doc["schema_version"], 1);
    doc["error"].as_str().unwrap_or("").to_string()
}

fn warnings(report: &Value) -> Vec<String> {
    report["warnings"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|w| w.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn err_code_bytes(result: Result<Vec<u8>, String>) -> String {
    let doc: Value = serde_json::from_str(&result.expect_err("expected an error"))
        .expect("error is JSON");
    assert_eq!(doc["schema_version"], 1);
    doc["error"].as_str().unwrap_or("").to_string()
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

fn crc(data: &[u8]) -> u32 {
    crc32::crc32(data)
}

fn build_dtb() -> Vec<u8> {
    // strings block: "compatible\0reg\0flag\0status\0"
    const S_COMPATIBLE: u32 = 0;
    const S_REG: u32 = 11;
    const S_FLAG: u32 = 15;
    const S_STATUS: u32 = 20;
    let strings: &[u8] = b"compatible\0reg\0flag\0status\0";

    let mut stru = Vec::new();
    let begin_node = |s: &mut Vec<u8>, name: &str| {
        s.extend_from_slice(&1u32.to_be_bytes());
        s.extend_from_slice(name.as_bytes());
        s.push(0);
        while s.len() % 4 != 0 {
            s.push(0);
        }
    };
    let prop = |s: &mut Vec<u8>, nameoff: u32, data: &[u8]| {
        s.extend_from_slice(&3u32.to_be_bytes());
        s.extend_from_slice(&(data.len() as u32).to_be_bytes());
        s.extend_from_slice(&nameoff.to_be_bytes());
        s.extend_from_slice(data);
        while s.len() % 4 != 0 {
            s.push(0);
        }
    };

    begin_node(&mut stru, "");
    prop(&mut stru, S_COMPATIBLE, b"turen,fixture\0turen,dummy\0");
    prop(&mut stru, S_REG, &[0x40, 0, 0, 0, 0, 0, 0x10, 0]);
    prop(&mut stru, S_FLAG, &[]);
    begin_node(&mut stru, "child@0");
    prop(&mut stru, S_STATUS, b"okay\0");
    stru.extend_from_slice(&2u32.to_be_bytes()); // END_NODE child
    stru.extend_from_slice(&2u32.to_be_bytes()); // END_NODE root
    stru.extend_from_slice(&9u32.to_be_bytes()); // FDT_END

    let rsvmap_off = 40usize;
    let struct_off = rsvmap_off + 32; // one entry + terminator pair
    let strings_off = struct_off + stru.len();
    let total = strings_off + strings.len();

    let mut out = Vec::new();
    out.extend_from_slice(&0xd00dfeedu32.to_be_bytes());
    out.extend_from_slice(&(total as u32).to_be_bytes());
    out.extend_from_slice(&(struct_off as u32).to_be_bytes());
    out.extend_from_slice(&(strings_off as u32).to_be_bytes());
    out.extend_from_slice(&(rsvmap_off as u32).to_be_bytes());
    out.extend_from_slice(&17u32.to_be_bytes()); // version
    out.extend_from_slice(&16u32.to_be_bytes()); // last_comp_version
    out.extend_from_slice(&0u32.to_be_bytes()); // boot_cpuid_phys
    out.extend_from_slice(&(strings.len() as u32).to_be_bytes());
    out.extend_from_slice(&(stru.len() as u32).to_be_bytes());
    out.extend_from_slice(&0x8000_0000u64.to_be_bytes()); // reserve address
    out.extend_from_slice(&0x1000u64.to_be_bytes()); // reserve size
    out.extend_from_slice(&0u64.to_be_bytes()); // terminator
    out.extend_from_slice(&0u64.to_be_bytes());
    out.extend_from_slice(&stru);
    out.extend_from_slice(strings);
    out
}

fn build_uimage(data: &[u8]) -> Vec<u8> {
    let mut header = [0u8; 64];
    header[0..4].copy_from_slice(&0x27051956u32.to_be_bytes());
    header[8..12].copy_from_slice(&0x6600_0100u32.to_be_bytes()); // timestamp
    header[12..16].copy_from_slice(&(data.len() as u32).to_be_bytes());
    header[16..20].copy_from_slice(&0x8000_8000u32.to_be_bytes()); // load
    header[20..24].copy_from_slice(&0x8000_8000u32.to_be_bytes()); // entry
    header[24..28].copy_from_slice(&crc(data).to_be_bytes()); // data crc
    header[28] = 5; // os linux
    header[29] = 2; // arch arm
    header[30] = 2; // type kernel
    header[31] = 1; // comp gzip
    header[32..32 + 9].copy_from_slice(b"Linux-6.1");
    let header_crc = {
        let mut zeroed = header;
        zeroed[4..8].fill(0);
        crc(&zeroed)
    };
    header[4..8].copy_from_slice(&header_crc.to_be_bytes());
    let mut out = header.to_vec();
    out.extend_from_slice(data);
    out
}

fn build_env(entries: &[(&str, &str)], redundant: bool) -> Vec<u8> {
    let mut data = Vec::new();
    for (key, value) in entries {
        data.extend_from_slice(key.as_bytes());
        data.push(b'=');
        data.extend_from_slice(value.as_bytes());
        data.push(0);
    }
    data.push(0); // double-NUL terminator
    let checksum = crc(&data);
    let mut out = checksum.to_le_bytes().to_vec();
    if redundant {
        out.push(1); // active flag
    }
    out.extend_from_slice(&data);
    out
}

fn ihex_line(count: u8, address: u16, rtype: u8, data: &[u8]) -> String {
    let mut bytes = vec![count, (address >> 8) as u8, address as u8, rtype];
    bytes.extend_from_slice(data);
    let sum: u32 = bytes.iter().map(|&b| b as u32).sum();
    let checksum = 0u8.wrapping_sub(sum as u8);
    let mut line = format!(":{count:02X}{address:04X}{rtype:02X}");
    for byte in data {
        line.push_str(&format!("{byte:02X}"));
    }
    line.push_str(&format!("{checksum:02X}"));
    line
}

fn srec_line(rtype: u8, address: u64, data: &[u8]) -> String {
    let alen = match rtype {
        0 | 1 | 5 | 9 => 2,
        2 | 6 | 8 => 3,
        3 | 7 => 4,
        _ => 2,
    };
    let count = (alen + data.len() + 1) as u8;
    let mut bytes = vec![count];
    for shift in (0..alen).rev() {
        bytes.push((address >> (shift * 8)) as u8);
    }
    bytes.extend_from_slice(data);
    let sum: u32 = bytes.iter().map(|&b| b as u32).sum();
    let checksum = !(sum as u8);
    let mut line = format!("S{rtype}{count:02X}");
    for byte in &bytes[1..] {
        line.push_str(&format!("{byte:02X}"));
    }
    line.push_str(&format!("{checksum:02X}"));
    line
}

/// Sparse image built from chunk specs: ("raw", blocks, payload) etc.
fn build_sparse(chunks: Vec<(u16, u32, Vec<u8>)>, block_size: u32) -> Vec<u8> {
    let total_blocks: u32 = chunks
        .iter()
        .map(|&(kind, blocks, _)| if kind == 0xCAC4 { 0 } else { blocks })
        .sum();
    let mut out = Vec::new();
    out.extend_from_slice(&0xED26_FF3Au32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // major
    out.extend_from_slice(&0u16.to_le_bytes()); // minor
    out.extend_from_slice(&28u16.to_le_bytes()); // file hdr
    out.extend_from_slice(&12u16.to_le_bytes()); // chunk hdr
    out.extend_from_slice(&block_size.to_le_bytes());
    out.extend_from_slice(&total_blocks.to_le_bytes());
    out.extend_from_slice(&(chunks.len() as u32).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes()); // image checksum unused
    for (kind, blocks, payload) in &chunks {
        out.extend_from_slice(&kind.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // reserved
        out.extend_from_slice(&blocks.to_le_bytes());
        out.extend_from_slice(&(12 + payload.len() as u32).to_le_bytes());
        out.extend_from_slice(payload);
    }
    out
}

// ---------------------------------------------------------------------------
// CRC32
// ---------------------------------------------------------------------------

#[test]
fn crc32_known_vector() {
    // Standard CRC-32 check value.
    assert_eq!(crc(b"123456789"), 0xCBF4_3926);
    assert_eq!(crc(b""), 0);
}

// ---------------------------------------------------------------------------
// DTB
// ---------------------------------------------------------------------------

#[test]
fn dtb_decompiles_fixture() {
    let report = json(dtb_decompile_impl(&build_dtb(), "{}"));
    assert_eq!(report["kind"], "dtb");
    assert_eq!(report["version"], 17);
    assert_eq!(report["node_count"], 2);
    assert_eq!(report["property_count"], 4);
    assert_eq!(report["truncated"], false);
    assert_eq!(report["memory_reservations"][0]["address"], "0x80000000");
    assert_eq!(report["memory_reservations"][0]["size"], "0x1000");
    let dts = report["dts"].as_str().unwrap_or("");
    assert!(dts.starts_with("/dts-v1/;"));
    assert!(dts.contains("/memreserve/ 0x0000000080000000 0x0000000000001000;"));
    assert!(dts.contains("/ {"));
    assert!(dts.contains("compatible = \"turen,fixture\", \"turen,dummy\";"));
    assert!(dts.contains("reg = <0x40000000 0x1000>;"));
    assert!(dts.contains("flag;"));
    assert!(dts.contains("child@0 {"));
    assert!(dts.contains("status = \"okay\";"));
    assert!(dts.ends_with("};\n"));
}

#[test]
fn dtb_rejects_bad_magic() {
    let mut dtb = build_dtb();
    dtb[0] = 0;
    assert_eq!(err_code(dtb_decompile_impl(&dtb, "{}")), "bad_magic");
    assert_eq!(err_code(dtb_decompile_impl(b"nope", "{}")), "truncated");
}

#[test]
fn dtb_rejects_broken_layout() {
    let mut dtb = build_dtb();
    // totalsize larger than input
    dtb[4..8].copy_from_slice(&(10_000_000u32).to_be_bytes());
    assert_eq!(err_code(dtb_decompile_impl(&dtb, "{}")), "truncated");

    let mut dtb = build_dtb();
    // structure block offset beyond totalsize
    dtb[8..12].copy_from_slice(&(9_000_000u32).to_be_bytes());
    assert_eq!(err_code(dtb_decompile_impl(&dtb, "{}")), "malformed");

    let mut dtb = build_dtb();
    // property name offset beyond strings block: patch first PROP nameoff
    let struct_off = u32::from_be_bytes(dtb[8..12].try_into().unwrap_or([0; 4])) as usize;
    // first BEGIN_NODE("") occupies 8 bytes (token + NUL padded); PROP follows
    let prop = struct_off + 8;
    dtb[prop + 8..prop + 12].copy_from_slice(&0x00ff_ffffu32.to_be_bytes());
    assert_eq!(err_code(dtb_decompile_impl(&dtb, "{}")), "malformed");
}

#[test]
fn dtb_output_cap_truncates() {
    let report = json(dtb_decompile_impl(
        &build_dtb(),
        r#"{"maxOutputBytes":1024}"#,
    ));
    assert_eq!(report["truncated"], true);
    assert!(report["dts"].as_str().unwrap_or("").len() <= 1024);
}

#[test]
fn dtb_deterministic() {
    let dtb = build_dtb();
    assert_eq!(dtb_decompile_impl(&dtb, "{}").ok(), dtb_decompile_impl(&dtb, "{}").ok());
}

// ---------------------------------------------------------------------------
// uImage
// ---------------------------------------------------------------------------

#[test]
fn uimage_inspects_fixture() {
    let payload = b"fake kernel bytes".to_vec();
    let image = build_uimage(&payload);
    let report = json(uimage_inspect_impl(&image, "{}"));
    assert_eq!(report["kind"], "uimage");
    assert_eq!(report["name"], "Linux-6.1");
    assert_eq!(report["timestamp"], 0x6600_0100);
    assert_eq!(report["load_address"], "0x80008000");
    assert_eq!(report["entry_point"], "0x80008000");
    assert_eq!(report["data_size"], payload.len());
    assert_eq!(report["os_name"], "linux");
    assert_eq!(report["arch_name"], "arm");
    assert_eq!(report["type_name"], "kernel");
    assert_eq!(report["compression_name"], "gzip");
    assert_eq!(report["header_crc"]["valid"], true);
    assert_eq!(report["data_crc"]["valid"], true);
    assert_eq!(report["data_present"], true);
    assert_eq!(report["trailing_bytes"], 0);
}

#[test]
fn uimage_detects_crc_failures() {
    let payload = b"payload".to_vec();
    let mut image = build_uimage(&payload);
    image[40] ^= 1; // corrupt a name byte → header CRC fails
    let report = json(uimage_inspect_impl(&image, "{}"));
    assert_eq!(report["header_crc"]["valid"], false);
    assert_eq!(report["data_crc"]["valid"], true);

    let mut image = build_uimage(&payload);
    let last = image.len() - 1;
    image[last] ^= 1; // corrupt payload → data CRC fails
    let report = json(uimage_inspect_impl(&image, "{}"));
    assert_eq!(report["header_crc"]["valid"], true);
    assert_eq!(report["data_crc"]["valid"], false);
}

#[test]
fn uimage_handles_truncated_data() {
    let payload = vec![0u8; 100];
    let image = build_uimage(&payload);
    let report = json(uimage_inspect_impl(&image[..80], "{}"));
    assert_eq!(report["data_present"], false);
    assert_eq!(report["data_crc"]["valid"], Value::Null);
    assert!(report["warnings"][0].as_str().unwrap_or("").contains("data_truncated"));
}

#[test]
fn uimage_rejects_bad_input() {
    assert_eq!(err_code(uimage_inspect_impl(b"short", "{}")), "truncated");
    let mut image = build_uimage(b"data");
    image[0] = 0;
    assert_eq!(err_code(uimage_inspect_impl(&image, "{}")), "bad_magic");
}

#[test]
fn uimage_reports_unknown_enums() {
    let mut image = build_uimage(b"data");
    image[28] = 0xf0; // os
    image[29] = 0xf1; // arch
    image[30] = 0xf2; // type
    image[31] = 0xf3; // comp
    // fix the header CRC after edits
    let mut zeroed = [0u8; 64];
    zeroed.copy_from_slice(&image[..64]);
    zeroed[4..8].fill(0);
    image[4..8].copy_from_slice(&crc(&zeroed).to_be_bytes());
    let report = json(uimage_inspect_impl(&image, "{}"));
    assert_eq!(report["os_name"], "unknown");
    assert_eq!(report["arch_name"], "unknown");
    assert_eq!(report["type_name"], "unknown");
    assert_eq!(report["compression_name"], "unknown");
}

// ---------------------------------------------------------------------------
// U-Boot environment
// ---------------------------------------------------------------------------

#[test]
fn env_parses_plain_blob() {
    let blob = build_env(&[("bootcmd", "run distro_bootcmd"), ("baudrate", "115200")], false);
    let report = json(uboot_env_parse_impl(&blob, "{}"));
    assert_eq!(report["kind"], "uboot-env");
    assert_eq!(report["redundancy"], "none");
    assert_eq!(report["crc"]["valid"], true);
    assert_eq!(report["crc"]["endianness"], "little");
    assert_eq!(report["entry_count"], 2);
    assert_eq!(report["entries"][0]["key"], "bootcmd");
    assert_eq!(report["entries"][0]["value"], "run distro_bootcmd");
    assert_eq!(report["terminated"], true);
}

#[test]
fn env_detects_redundant_layout() {
    let blob = build_env(&[("a", "b")], true);
    let report = json(uboot_env_parse_impl(&blob, "{}"));
    assert_eq!(report["redundancy"], "redundant");
    assert_eq!(report["flag"], 1);
    assert_eq!(report["data_offset"], 5);
    assert_eq!(report["crc"]["valid"], true);
    assert_eq!(report["entries"][0]["key"], "a");

    // forced wrong interpretation fails the CRC
    let forced = json(uboot_env_parse_impl(&blob, r#"{"redundant":false}"#));
    assert_eq!(forced["crc"]["valid"], false);
}

#[test]
fn env_reports_bad_crc() {
    let mut blob = build_env(&[("a", "b")], false);
    blob[6] ^= 0xFF; // corrupt env data
    let report = json(uboot_env_parse_impl(&blob, "{}"));
    assert_eq!(report["crc"]["valid"], false);
    assert_eq!(report["crc"]["endianness"], Value::Null);
    // still parses the entries
    assert_eq!(report["entry_count"], 1);
}

#[test]
fn env_warns_on_missing_terminator() {
    let mut data = b"key=value\0".to_vec();
    let checksum = crc(&data);
    let mut blob = checksum.to_le_bytes().to_vec();
    blob.append(&mut data);
    let report = json(uboot_env_parse_impl(&blob, "{}"));
    assert_eq!(report["terminated"], false);
    assert!(report["warnings"][0].as_str().unwrap_or("").contains("no_terminator"));
}

#[test]
fn env_caps_entries() {
    let entries: Vec<(String, String)> = (0..20)
        .map(|i| (format!("k{i}"), format!("v{i}")))
        .collect();
    let refs: Vec<(&str, &str)> = entries.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let blob = build_env(&refs, false);
    let report = json(uboot_env_parse_impl(&blob, r#"{"maxEntries":5}"#));
    assert_eq!(report["entry_count"], 5);
    assert_eq!(report["truncated"], true);
}

#[test]
fn env_handles_valueless_and_short() {
    let mut data = b"lonekey\0ok=1\0".to_vec();
    data.push(0);
    let checksum = crc(&data);
    let mut blob = checksum.to_le_bytes().to_vec();
    blob.extend_from_slice(&data);
    let report = json(uboot_env_parse_impl(&blob, "{}"));
    assert_eq!(report["entries"][0]["value"], Value::Null);
    assert!(warnings(&report)
            .iter()
            .any(|w| w.contains("entries_without_value")));

    assert_eq!(err_code(uboot_env_parse_impl(b"\0\0", "{}")), "truncated");
}

// ---------------------------------------------------------------------------
// Intel HEX
// ---------------------------------------------------------------------------

fn ihex_fixture() -> String {
    let mut text = String::new();
    text.push_str(&ihex_line(2, 0, 4, &[0x08, 0x00])); // ext linear 0x08000000
    text.push('\n');
    text.push_str(&ihex_line(4, 0x0100, 0, &[0xDE, 0xAD, 0xBE, 0xEF])); // @0x08000100
    text.push('\n');
    text.push_str(&ihex_line(4, 0x0200, 0, &[1, 2, 3, 4])); // @0x08000200 (gap)
    text.push('\n');
    text.push_str(&ihex_line(4, 0, 5, &[0x08, 0x00, 0x01, 0x00])); // start linear
    text.push('\n');
    text.push_str(&ihex_line(0, 0, 1, &[])); // eof
    text.push('\n');
    text
}

#[test]
fn ihex_parses_records_ranges_gaps() {
    let report = json(ihex_parse_impl(ihex_fixture().as_bytes(), "{}"));
    assert_eq!(report["kind"], "ihex");
    assert_eq!(report["record_count"], 5);
    assert_eq!(report["data_record_count"], 2);
    assert_eq!(report["data_bytes"], 8);
    assert_eq!(report["eof"], true);
    assert_eq!(report["invalid_checksums"], 0);
    assert_eq!(report["start_address"], "0x8000100");
    assert_eq!(report["start_address_kind"], "linear");
    assert_eq!(report["min_address"], "0x8000100");
    assert_eq!(report["max_address"], "0x8000204");
    assert_eq!(report["range_count"], 2);
    assert_eq!(report["gap_count"], 1);
    assert_eq!(report["gaps"][0]["start"], "0x8000104");
    assert_eq!(report["gaps"][0]["end"], "0x8000200");
    assert_eq!(report["gaps"][0]["size"], 0xfc);
    let types: Vec<&str> = report["records"]
        .as_array()
        .map(|a| a.iter().filter_map(|r| r["type"].as_str()).collect())
        .unwrap_or_default();
    assert_eq!(types, ["extended_linear", "data", "data", "start_linear", "eof"]);
}

#[test]
fn ihex_flags_bad_checksum_but_lists() {
    let mut text = ihex_fixture();
    text = text.replacen("EF", "EE", 1); // corrupt a data byte, checksum now wrong
    let report = json(ihex_parse_impl(text.as_bytes(), "{}"));
    assert_eq!(report["invalid_checksums"], 1);
    assert_eq!(
        report["records"].as_array().unwrap_or(&vec![])[1]["checksum_valid"],
        false
    );
}

#[test]
fn ihex_rejects_malformed_lines() {
    assert_eq!(
        err_code(ihex_parse_impl(b"no colon here\n", "{}")),
        "invalid_record"
    );
    assert_eq!(
        err_code(ihex_parse_impl(b":0Z0100000000\n", "{}")),
        "invalid_record"
    );
    assert_eq!(
        err_code(ihex_parse_impl(b":10010000214601\n", "{}")),
        "invalid_record"
    ); // length mismatch
    assert_eq!(
        err_code(ihex_parse_impl(b":0400000201\n", "{}")),
        "invalid_record"
    ); // odd hex
}

#[test]
fn ihex_flatten_round_trip_and_fill() {
    let image = ihex_flatten_impl(ihex_fixture().as_bytes(), "{}").unwrap_or_default();
    // min 0x08000100 → max 0x08000204, size 0x104
    assert_eq!(image.len(), 0x104);
    assert_eq!(&image[..4], &[0xDE, 0xAD, 0xBE, 0xEF]);
    assert_eq!(&image[0x100..0x104], &[1, 2, 3, 4]);
    assert!(image[4..0x100].iter().all(|&b| b == 0xFF)); // gap fill

    let zeroed = ihex_flatten_impl(ihex_fixture().as_bytes(), r#"{"fill":0}"#).unwrap_or_default();
    assert!(zeroed[4..0x100].iter().all(|&b| b == 0));
}

#[test]
fn ihex_flatten_strict_and_lenient_checksums() {
    let bad = ihex_fixture().replacen("EF", "EE", 1);
    assert_eq!(
        err_code_bytes(ihex_flatten_impl(bad.as_bytes(), "{}")),
        "checksum_mismatch"
    );
    let image = ihex_flatten_impl(bad.as_bytes(), r#"{"ignoreChecksums":true}"#).unwrap_or_default();
    assert_eq!(image.len(), 0x104);
}

#[test]
fn ihex_flatten_enforces_output_cap() {
    // data at 0x00000000 and at 0xFFFFFFFF via extended linear → ~4 GiB span
    let mut text = String::new();
    text.push_str(&ihex_line(1, 0, 0, &[0xAA]));
    text.push('\n');
    text.push_str(&ihex_line(2, 0, 4, &[0xFF, 0xFF])); // base 0xFFFF0000
    text.push('\n');
    text.push_str(&ihex_line(1, 0xFFFF, 0, &[0xBB])); // at 0xFFFFFFFF
    text.push('\n');
    assert_eq!(
        err_code_bytes(ihex_flatten_impl(text.as_bytes(), "{}")),
        "output_too_large"
    );
    // a smaller explicit cap hits the same path
    let small = format!("{}{}", ihex_line(4, 0, 0, &[1, 2, 3, 4]), "\n");
    assert_eq!(
        err_code_bytes(ihex_flatten_impl(small.as_bytes(), r#"{"maxOutputBytes":2}"#)),
        "output_too_large"
    );
}

#[test]
fn ihex_empty_data_is_empty_image() {
    let only_eof = format!("{}\n", ihex_line(0, 0, 1, &[]));
    let image = ihex_flatten_impl(only_eof.as_bytes(), "{}").unwrap_or_default();
    assert_eq!(image.len(), 0);
}

// ---------------------------------------------------------------------------
// Motorola S-Record
// ---------------------------------------------------------------------------

fn srec_fixture() -> String {
    let mut text = String::new();
    text.push_str(&srec_line(0, 0, b"HDR")); // header
    text.push('\n');
    text.push_str(&srec_line(1, 0x0100, &[0xDE, 0xAD, 0xBE, 0xEF]));
    text.push('\n');
    text.push_str(&srec_line(1, 0x0200, &[1, 2, 3, 4])); // gap
    text.push('\n');
    text.push_str(&srec_line(5, 2, &[])); // count = 2 data records
    text.push('\n');
    text.push_str(&srec_line(9, 0x0100, &[])); // start address
    text.push('\n');
    text
}

#[test]
fn srec_parses_records_ranges_gaps() {
    let report = json(srec_parse_impl(srec_fixture().as_bytes(), "{}"));
    assert_eq!(report["kind"], "srec");
    assert_eq!(report["record_count"], 5);
    assert_eq!(report["data_record_count"], 2);
    assert_eq!(report["header"], "HDR");
    assert_eq!(report["start_address"], "0x100");
    assert_eq!(report["start_address_kind"], "s9");
    assert_eq!(report["count_check"]["declared"], 2);
    assert_eq!(report["count_check"]["actual"], 2);
    assert_eq!(report["count_check"]["valid"], true);
    assert_eq!(report["gap_count"], 1);
    assert_eq!(report["gaps"][0]["size"], 0xfc);
    assert_eq!(report["min_address"], "0x100");
    assert_eq!(report["max_address"], "0x204");
}

#[test]
fn srec_detects_count_mismatch() {
    // declared 5 data records (with a corrected checksum) vs 2 actual
    let text = srec_fixture().replacen(&srec_line(5, 2, &[]), &srec_line(5, 5, &[]), 1);
    let report = json(srec_parse_impl(text.as_bytes(), "{}"));
    assert_eq!(report["count_check"]["declared"], 5);
    assert_eq!(report["count_check"]["actual"], 2);
    assert_eq!(report["count_check"]["valid"], false);
    assert_eq!(report["invalid_checksums"], 0);
    assert!(warnings(&report)
            .iter()
            .any(|w| w.contains("count_mismatch")));
}

#[test]
fn srec_rejects_malformed() {
    assert_eq!(err_code(srec_parse_impl(b"X1130000\n", "{}")), "invalid_record");
    assert_eq!(err_code(srec_parse_impl(b"S100000\n", "{}")), "invalid_record"); // odd
    assert_eq!(err_code(srec_parse_impl(b"SZ04000000\n", "{}")), "invalid_record");
}

#[test]
fn srec_flatten_round_trip() {
    let image = srec_flatten_impl(srec_fixture().as_bytes(), "{}").unwrap_or_default();
    assert_eq!(image.len(), 0x104);
    assert_eq!(&image[..4], &[0xDE, 0xAD, 0xBE, 0xEF]);
    assert_eq!(&image[0x100..], &[1, 2, 3, 4]);
    assert!(image[4..0x100].iter().all(|&b| b == 0xFF));
}

#[test]
fn srec_flatten_checksum_mismatch() {
    let bad = srec_fixture().replacen("DEAD", "DFAD", 1);
    assert_eq!(
        err_code_bytes(srec_flatten_impl(bad.as_bytes(), "{}")),
        "checksum_mismatch"
    );
}

#[test]
fn srec_32bit_addresses() {
    let mut text = String::new();
    text.push_str(&srec_line(3, 0x1234_5678, &[0xAA]));
    text.push('\n');
    let report = json(srec_parse_impl(text.as_bytes(), "{}"));
    assert_eq!(report["min_address"], "0x12345678");
    let image = srec_flatten_impl(text.as_bytes(), "{}").unwrap_or_default();
    assert_eq!(image, vec![0xAA]);
}

// ---------------------------------------------------------------------------
// Android sparse
// ---------------------------------------------------------------------------

fn sparse_fixture() -> Vec<u8> {
    // raw 1 block (4096 of 0x41), fill 2 blocks (0x11223344), dont_care 1 block,
    // then a crc32 chunk over the expanded image computed by hand below.
    let mut chunks = vec![
        (0xCAC1u16, 1u32, vec![0x41u8; 4096]),
        (0xCAC2, 2, 0x44332211u32.to_le_bytes().to_vec()),
        (0xCAC3, 1, Vec::new()),
    ];
    let expanded: Vec<u8> = {
        let mut e = vec![0x41u8; 4096];
        e.extend(std::iter::repeat(0x44332211u32.to_le_bytes()).take(2048).flatten());
        e.extend(std::iter::repeat(0u8).take(4096));
        e
    };
    let image_crc = crc(&expanded);
    chunks.push((0xCAC4, 0, image_crc.to_le_bytes().to_vec()));
    build_sparse(chunks, 4096)
}

#[test]
fn sparse_parses_chunk_table() {
    let report = json(android_sparse_parse_impl(&sparse_fixture(), "{}"));
    assert_eq!(report["kind"], "android-sparse");
    assert_eq!(report["version"]["major"], 1);
    assert_eq!(report["block_size"], 4096);
    assert_eq!(report["total_blocks"], 4);
    assert_eq!(report["chunk_count"], 4);
    assert_eq!(report["expanded_bytes"], "16384");
    let types: Vec<&str> = report["chunks"]
        .as_array()
        .map(|a| a.iter().filter_map(|c| c["type"].as_str()).collect())
        .unwrap_or_default();
    assert_eq!(types, ["raw", "fill", "dont_care", "crc32"]);
    assert_eq!(report["crc"]["valid"], true);
}

#[test]
fn sparse_expand_round_trip() {
    let out = android_sparse_expand_impl(&sparse_fixture(), "{}").unwrap_or_default();
    assert_eq!(out.len(), 16384);
    assert!(out[..4096].iter().all(|&b| b == 0x41));
    assert!(out[4096..12288].chunks_exact(4).all(|c| c == [0x11, 0x22, 0x33, 0x44]));
    assert!(out[12288..].iter().all(|&b| b == 0));
}

#[test]
fn sparse_expand_detects_crc_mismatch() {
    let mut image = sparse_fixture();
    let last = image.len() - 1;
    image[last] ^= 0xFF; // corrupt stored crc
    assert_eq!(
        err_code_bytes(android_sparse_expand_impl(&image, "{}")),
        "crc_mismatch"
    );
    // parse still reports, with crc.valid false
    let report = json(android_sparse_parse_impl(&image, "{}"));
    assert_eq!(report["crc"]["valid"], false);
}

#[test]
fn sparse_rejects_bad_input() {
    assert_eq!(err_code(android_sparse_parse_impl(b"short", "{}")), "truncated");
    let mut image = sparse_fixture();
    image[0] = 0;
    assert_eq!(err_code(android_sparse_parse_impl(&image, "{}")), "bad_magic");

    // truncated chunk payload
    let image = sparse_fixture();
    let cut = image.len() - 10;
    assert_eq!(
        err_code(android_sparse_parse_impl(&image[..cut], "{}")),
        "truncated"
    );

    // unknown chunk type
    let mut image = sparse_fixture();
    image[28] = 0x99;
    image[29] = 0x99;
    assert_eq!(
        err_code(android_sparse_parse_impl(&image, "{}")),
        "unknown_chunk"
    );

    // raw chunk payload smaller than declared output
    let bad = build_sparse(vec![(0xCAC1u16, 2u32, vec![0u8; 4096])], 4096);
    assert_eq!(err_code(android_sparse_parse_impl(&bad, "{}")), "malformed");
}

#[test]
fn sparse_expand_output_cap() {
    // declare huge output without huge input: fill chunk of many blocks
    let mut chunks = vec![(0xCAC2u16, 40_000u32, 0xA5A5A5A5u32.to_le_bytes().to_vec())];
    let image = build_sparse(std::mem::take(&mut chunks), 4096);
    // 40000 * 4096 = 163,840,000 > 128 MiB
    assert_eq!(
        err_code_bytes(android_sparse_expand_impl(&image, "{}")),
        "output_too_large"
    );
    // but parse reports the size without allocating
    let report = json(android_sparse_parse_impl(&image, "{}"));
    assert_eq!(report["expanded_bytes"], "163840000");
}

#[test]
fn sparse_block_count_mismatch_warns() {
    let mut image = build_sparse(vec![(0xCAC1u16, 1u32, vec![7u8; 4096])], 4096);
    image[16..20].copy_from_slice(&99u32.to_le_bytes()); // total_blks = 99
    let report = json(android_sparse_parse_impl(&image, "{}"));
    assert!(warnings(&report)
            .iter()
            .any(|w| w.contains("block_count_mismatch")));
}

// ---------------------------------------------------------------------------
// Shared limits
// ---------------------------------------------------------------------------

#[test]
fn rejects_oversized_input() {
    let big = vec![0u8; MAX_INPUT_BYTES + 1];
    for result in [
        dtb_decompile_impl(&big, "{}"),
        uimage_inspect_impl(&big, "{}"),
        uboot_env_parse_impl(&big, "{}"),
        ihex_parse_impl(&big, "{}"),
        srec_parse_impl(&big, "{}"),
        android_sparse_parse_impl(&big, "{}"),
    ] {
        assert_eq!(err_code(result), "input_too_large");
    }
    assert_eq!(
        err_code_bytes(ihex_flatten_impl(&big, "{}")),
        "input_too_large"
    );
    assert_eq!(
        err_code_bytes(android_sparse_expand_impl(&big, "{}")),
        "input_too_large"
    );
}

#[test]
fn rejects_oversized_options() {
    let big_options = format!(r#"{{"pad":"{}"}}"#, " ".repeat(5000));
    let dtb = build_dtb();
    assert_eq!(
        err_code(dtb_decompile_impl(&dtb, &big_options)),
        "options_too_large"
    );
    assert_eq!(
        err_code(uimage_inspect_impl(&build_uimage(b"x"), &big_options)),
        "options_too_large"
    );
}

#[test]
fn rejects_invalid_options() {
    let dtb = build_dtb();
    for bad in ["{", "not json", "[1,2]", "null", "42"] {
        assert_eq!(err_code(dtb_decompile_impl(&dtb, bad)), "invalid_options");
    }
    // unknown keys are ignored for forward compatibility
    assert!(dtb_decompile_impl(&dtb, r#"{"futureOption":123}"#).is_ok());
    assert!(dtb_decompile_impl(&dtb, "").is_ok());
    assert!(dtb_decompile_impl(&dtb, "   ").is_ok());
}

#[test]
fn all_ops_deterministic() {
    let dtb = build_dtb();
    let uimg = build_uimage(b"data");
    let env = build_env(&[("a", "b")], false);
    let hex_text = ihex_fixture();
    let srec_text = srec_fixture();
    let sparse = sparse_fixture();
    assert_eq!(dtb_decompile_impl(&dtb, "{}").ok(), dtb_decompile_impl(&dtb, "{}").ok());
    assert_eq!(uimage_inspect_impl(&uimg, "{}").ok(), uimage_inspect_impl(&uimg, "{}").ok());
    assert_eq!(uboot_env_parse_impl(&env, "{}").ok(), uboot_env_parse_impl(&env, "{}").ok());
    assert_eq!(ihex_parse_impl(hex_text.as_bytes(), "{}").ok(), ihex_parse_impl(hex_text.as_bytes(), "{}").ok());
    assert_eq!(srec_parse_impl(srec_text.as_bytes(), "{}").ok(), srec_parse_impl(srec_text.as_bytes(), "{}").ok());
    assert_eq!(
        android_sparse_parse_impl(&sparse, "{}").ok(),
        android_sparse_parse_impl(&sparse, "{}").ok()
    );
    assert_eq!(
        ihex_flatten_impl(hex_text.as_bytes(), "{}").ok(),
        ihex_flatten_impl(hex_text.as_bytes(), "{}").ok()
    );
    assert_eq!(
        android_sparse_expand_impl(&sparse, "{}").ok(),
        android_sparse_expand_impl(&sparse, "{}").ok()
    );
}
