//! Legacy U-Boot uImage header inspection and U-Boot environment parsing.
//!
//! uImage is the classic 64-byte big-endian header (magic 0x27051956) with a
//! header CRC32 (computed over the header with the CRC field zeroed) and a
//! data CRC32 over the payload that follows the header. The OS/arch/type/
//! compression enum tables mirror U-Boot's `include/image.h`.
//!
//! The environment blob is a stored CRC32 followed by NUL-separated
//! `key=value` strings terminated by an empty string. In the redundant
//! layout a flag byte sits between the CRC and the data; the CRC covers only
//! the data region, not the flag.

use serde_json::{json, Value};

use crate::{crc32::crc32, err, hex};

const UIMAGE_MAGIC: u32 = 0x2705_1956;
const HEADER_LEN: usize = 64;
const MAX_KEY_CHARS: usize = 256;
const MAX_VALUE_CHARS: usize = 1024;
/// Total rendered key+value budget so 4096 maximal entries can never
/// approach the 4 MiB serialized output cap.
const ENTRY_CHAR_BUDGET: usize = 3 * 1024 * 1024;

fn be32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_be_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn os_name(value: u8) -> &'static str {
    match value {
        0 => "invalid",
        1 => "openbsd",
        2 => "netbsd",
        3 => "freebsd",
        4 => "4_4bsd",
        5 => "linux",
        6 => "svr4",
        7 => "esix",
        8 => "solaris",
        9 => "irix",
        10 => "sco",
        11 => "dell",
        12 => "ncr",
        13 => "lynxos",
        14 => "vxworks",
        15 => "psos",
        16 => "qnx",
        17 => "u-boot",
        18 => "rtems",
        19 => "artos",
        20 => "unity",
        21 => "integrity",
        22 => "ose",
        23 => "plan9",
        24 => "openrtos",
        25 => "arm-trusted-firmware",
        26 => "tee",
        27 => "opensbi",
        28 => "efi",
        29 => "elf",
        30 => "cygnos",
        _ => "unknown",
    }
}

fn arch_name(value: u8) -> &'static str {
    match value {
        0 => "invalid",
        1 => "alpha",
        2 => "arm",
        3 => "i386",
        4 => "ia64",
        5 => "mips",
        6 => "mips64",
        7 => "ppc",
        8 => "s390",
        9 => "sh",
        10 => "sparc",
        11 => "sparc64",
        12 => "m68k",
        13 => "nios",
        14 => "microblaze",
        15 => "nios2",
        16 => "blackfin",
        17 => "avr32",
        18 => "st200",
        19 => "sandbox",
        20 => "nds32",
        21 => "openrisc",
        22 => "arm64",
        23 => "arc",
        24 => "x86_64",
        25 => "xtensa",
        26 => "riscv",
        _ => "unknown",
    }
}

fn type_name(value: u8) -> &'static str {
    match value {
        0 => "invalid",
        1 => "standalone",
        2 => "kernel",
        3 => "ramdisk",
        4 => "multi",
        5 => "firmware",
        6 => "script",
        7 => "filesystem",
        8 => "flatdt",
        9 => "kwbimage",
        10 => "imximage",
        11 => "ublimage",
        12 => "omapimage",
        13 => "aisimage",
        14 => "kernel_noload",
        15 => "pbimage",
        16 => "mmcimage",
        17 => "gpimage",
        18 => "fpimage",
        19 => "bootable",
        20 => "efi",
        _ => "unknown",
    }
}

fn compression_name(value: u8) -> &'static str {
    match value {
        0 => "none",
        1 => "gzip",
        2 => "bzip2",
        3 => "lzma",
        4 => "lzo",
        5 => "lz4",
        6 => "zstd",
        _ => "unknown",
    }
}

/// Inspect a legacy U-Boot uImage header.
pub(crate) fn inspect(bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() < HEADER_LEN {
        return Err(err(
            "truncated",
            format!("uImage header needs {HEADER_LEN} bytes, got {}", bytes.len()),
        ));
    }
    let magic = be32(bytes, 0).unwrap_or(0);
    if magic != UIMAGE_MAGIC {
        return Err(err(
            "bad_magic",
            format!("magic 0x{magic:08x} is not 0x27051956"),
        ));
    }

    let header_crc_stored = be32(bytes, 4).unwrap_or(0);
    let timestamp = be32(bytes, 8).unwrap_or(0);
    let data_size = be32(bytes, 12).unwrap_or(0) as usize;
    let load = be32(bytes, 16).unwrap_or(0);
    let entry = be32(bytes, 20).unwrap_or(0);
    let data_crc_stored = be32(bytes, 24).unwrap_or(0);
    let os = bytes[28];
    let arch = bytes[29];
    let image_type = bytes[30];
    let compression = bytes[31];
    let name_len = bytes[32..64]
        .iter()
        .position(|&byte| byte == 0)
        .unwrap_or(32);
    let name: String = bytes[32..32 + name_len]
        .iter()
        .map(|&byte| {
            if (0x20..=0x7e).contains(&byte) {
                byte as char
            } else {
                '?'
            }
        })
        .collect();

    // Header CRC covers the whole header with the CRC field itself zeroed.
    let mut header = [0u8; HEADER_LEN];
    header.copy_from_slice(&bytes[..HEADER_LEN]);
    header[4..8].fill(0);
    let header_crc_computed = crc32(&header);
    let header_crc_valid = header_crc_computed == header_crc_stored;

    let available = bytes.len() - HEADER_LEN;
    let data_present = data_size <= available;
    let (data_crc_computed, data_crc_valid) = if data_present {
        let computed = crc32(&bytes[HEADER_LEN..HEADER_LEN + data_size]);
        (Some(computed), Some(computed == data_crc_stored))
    } else {
        (None, None)
    };
    let trailing_bytes = available.saturating_sub(data_size);

    let mut warnings: Vec<String> = Vec::new();
    if !data_present {
        warnings.push(format!(
            "data_truncated: declared {data_size} bytes, {available} present"
        ));
    }
    if trailing_bytes > 0 && data_present {
        warnings.push(format!("trailing_bytes:{trailing_bytes}"));
    }

    Ok(json!({
        "schema_version": 1,
        "kind": "uimage",
        "input_bytes": bytes.len(),
        "name": name,
        "timestamp": timestamp,
        "load_address": hex(load as u64),
        "entry_point": hex(entry as u64),
        "data_size": data_size,
        "os": os,
        "os_name": os_name(os),
        "arch": arch,
        "arch_name": arch_name(arch),
        "image_type": image_type,
        "type_name": type_name(image_type),
        "compression": compression,
        "compression_name": compression_name(compression),
        "header_crc": {
            "stored": hex(header_crc_stored as u64),
            "computed": hex(header_crc_computed as u64),
            "valid": header_crc_valid,
        },
        "data_crc": {
            "stored": hex(data_crc_stored as u64),
            "computed": data_crc_computed.map(|value| hex(value as u64)),
            "valid": data_crc_valid,
        },
        "data_offset": HEADER_LEN,
        "data_present": data_present,
        "trailing_bytes": trailing_bytes,
        "warnings": warnings,
    }))
}

// ---------------------------------------------------------------------------
// U-Boot environment
// ---------------------------------------------------------------------------

pub(crate) struct EnvOptions {
    /// `Some(true)` forces the redundant layout (flag byte at offset 4),
    /// `Some(false)` the plain layout, `None` auto-detects via the CRC.
    pub redundant: Option<bool>,
    pub max_entries: usize,
}

/// Does the region look like env data: nonempty printable token containing
/// '=' before the first NUL?
fn plausible_env(data: &[u8]) -> bool {
    let token_len = data.iter().position(|&b| b == 0).unwrap_or(data.len());
    if token_len == 0 {
        return false;
    }
    let token = &data[..token_len];
    token.iter().all(|&b| (0x20..=0x7e).contains(&b)) && token.contains(&b'=')
}

fn cap_str(text: &str, max: usize) -> (String, bool) {
    let mut out = String::new();
    let mut truncated = false;
    for (used, ch) in text.chars().enumerate() {
        if used >= max {
            truncated = true;
            break;
        }
        out.push(ch);
    }
    (out, truncated)
}

pub(crate) fn parse_env(bytes: &[u8], options: &EnvOptions) -> Result<Value, String> {
    if bytes.len() < 5 {
        return Err(err(
            "truncated",
            format!("environment blob needs at least 5 bytes, got {}", bytes.len()),
        ));
    }
    let stored_le = u32::from_le_bytes(bytes[0..4].try_into().unwrap_or([0; 4]));
    let stored_be = u32::from_be_bytes(bytes[0..4].try_into().unwrap_or([0; 4]));
    let crc_plain = crc32(&bytes[4..]);
    let crc_redundant = crc32(&bytes[5..]);
    let flag = bytes[4];

    let plain_ok = crc_plain == stored_le || crc_plain == stored_be;
    let redundant_ok = crc_redundant == stored_le || crc_redundant == stored_be;

    let redundant = match options.redundant {
        Some(value) => value,
        None => {
            if plain_ok {
                false
            } else if redundant_ok {
                true
            } else if plausible_env(&bytes[4..]) {
                false
            } else {
                plausible_env(&bytes[5..])
            }
        }
    };
    let data_offset = if redundant { 5 } else { 4 };
    let computed = if redundant { crc_redundant } else { crc_plain };
    let crc_valid = computed == stored_le || computed == stored_be;
    let crc_endianness = if computed == stored_le {
        Some("little")
    } else if computed == stored_be {
        Some("big")
    } else {
        None
    };

    let data = &bytes[data_offset..];
    let mut entries: Vec<Value> = Vec::new();
    let mut pos = 0usize;
    let mut terminated = false;
    let mut truncated = false;
    let mut nonstandard = 0usize;
    let mut string_budget = ENTRY_CHAR_BUDGET;
    let mut truncated_strings = 0usize;

    while pos < data.len() {
        let rest = &data[pos..];
        let rel = rest.iter().position(|&byte| byte == 0);
        let (token, next) = match rel {
            Some(len) => (&rest[..len], pos + len + 1),
            None => (&rest[..], data.len()),
        };
        if token.is_empty() {
            // An empty string is the terminator only when a real NUL ended it.
            terminated = rel == Some(0);
            break;
        }
        if entries.len() >= options.max_entries || string_budget == 0 {
            truncated = true;
            break;
        }
        let text = String::from_utf8_lossy(token);
        let entry = if let Some((key, value)) = text.split_once('=') {
            let (key, key_cut) = cap_str(key, MAX_KEY_CHARS);
            let (value, value_cut) = cap_str(value, MAX_VALUE_CHARS);
            if key_cut || value_cut {
                truncated_strings += 1;
            }
            json!({ "key": key, "value": value })
        } else {
            nonstandard += 1;
            let (key, key_cut) = cap_str(&text, MAX_KEY_CHARS);
            if key_cut {
                truncated_strings += 1;
            }
            json!({ "key": key, "value": null })
        };
        let spent = entry["key"].as_str().map_or(0, str::len)
            + entry["value"].as_str().map_or(0, str::len)
            + 16;
        string_budget = string_budget.saturating_sub(spent);
        entries.push(entry);
        pos = next;
    }

    let mut warnings: Vec<String> = Vec::new();
    if !terminated {
        warnings.push("no_terminator".into());
    }
    if nonstandard > 0 {
        warnings.push(format!("entries_without_value:{nonstandard}"));
    }
    if truncated_strings > 0 {
        warnings.push(format!("truncated_strings:{truncated_strings}"));
    }

    Ok(json!({
        "schema_version": 1,
        "kind": "uboot-env",
        "input_bytes": bytes.len(),
        "redundancy": if redundant { "redundant" } else { "none" },
        "flag": if redundant { Some(flag) } else { None },
        "data_offset": data_offset,
        "crc": {
            "stored_le": hex(stored_le as u64),
            "stored_be": hex(stored_be as u64),
            "computed": hex(computed as u64),
            "valid": crc_valid,
            "endianness": crc_endianness,
        },
        "entry_count": entries.len(),
        "entries": entries,
        "terminated": terminated,
        "truncated": truncated,
        "warnings": warnings,
    }))
}
