//! Mach-O code-signing inspection: locate LC_CODE_SIGNATURE, parse the
//! SuperBlob, CodeDirectory, requirements, entitlements, and the CMS signature
//! blob. Parse-only — requirements are never evaluated and CMS signatures are
//! never verified.

use goblin::mach::load_command::CommandVariant;
use goblin::mach::{Mach, SingleArch};
use serde_json::{json, Value};

use crate::{bounded_text, sha256_hex, Report, MAX_BLOB_INDEX, MAX_XML_BYTES};

const CSMAGIC_REQUIREMENTS: u32 = 0xfade0c01;
const CSMAGIC_CODEDIRECTORY: u32 = 0xfade0c02;
const CSMAGIC_BLOBWRAPPER: u32 = 0xfade0b01;
const CSMAGIC_EMBEDDED_SIGNATURE: u32 = 0xfade0cc0;
const CSMAGIC_DETACHED_SIGNATURE: u32 = 0xfade0cc1;
const CSMAGIC_ENTITLEMENT: u32 = 0xfade7171;
const CSMAGIC_DER_ENTITLEMENT: u32 = 0xfade7172;

const CSSLOT_CODEDIRECTORY: u32 = 0;
const CSSLOT_SIGNATURE: u32 = 0x10000;
const MAX_ALTERNATE_CDS: usize = 16;

pub(crate) fn inspect(bytes: &[u8], report: &mut Report) -> Result<Value, &'static str> {
    let mach = Mach::parse(bytes).map_err(|_| "macho_parse_error")?;
    let is_fat = matches!(mach, Mach::Fat(_));
    let mut arches = Vec::new();
    match mach {
        Mach::Binary(macho) => {
            arches.push(analyze_macho(&macho, bytes, None, report));
        }
        Mach::Fat(fat) => {
            let count = fat.narches;
            let offsets: Vec<usize> = fat
                .arches()
                .map(|arches| arches.iter().map(|arch| arch.offset as usize).collect())
                .unwrap_or_default();
            for index in 0..count.min(report.limit) {
                match fat.get(index) {
                    Ok(SingleArch::MachO(macho)) => arches.push(analyze_macho(
                        &macho,
                        bytes,
                        offsets.get(index).copied(),
                        report,
                    )),
                    Ok(SingleArch::Archive(_)) => arches.push(json!({
                        "index": index,
                        "arch": "archive",
                        "code_signature": null,
                    })),
                    Err(_) => report
                        .warnings
                        .push(format!("fat arch {index} failed to parse")),
                }
            }
            if count > report.limit {
                report.truncated = true;
                report.warnings.push(format!(
                    "fat arches truncated from {count} to {}",
                    report.limit
                ));
            }
        }
    }
    let signed = arches.iter().any(|arch| !arch["code_signature"].is_null());
    Ok(json!({
        "schema_version": 1,
        "operation": "macho_codesign",
        "format": if is_fat { "mach-o-fat" } else { "mach-o" },
        "arches": arches,
        "signed": signed,
        "truncated": report.truncated,
        "warnings": report.warnings,
    }))
}

fn analyze_macho(
    macho: &goblin::mach::MachO,
    file_bytes: &[u8],
    arch_offset: Option<usize>,
    report: &mut Report,
) -> Value {
    let arch = json!({
        "arch": mach_arch(macho.header.cputype),
        "bits": if macho.is_64 { 64 } else { 32 },
        "arch_offset": arch_offset,
    });
    let command = macho.load_commands.iter().find_map(|command| {
        if let CommandVariant::CodeSignature(data) = command.command {
            Some(data)
        } else {
            None
        }
    });
    let Some(command) = command else {
        return json!({
            "arch": arch["arch"],
            "bits": arch["bits"],
            "arch_offset": arch_offset,
            "code_signature": null,
        });
    };
    let data_offset = command.dataoff as usize;
    let data_size = command.datasize as usize;

    // In fat binaries code-signature offsets are file-absolute; fall back to
    // arch-relative when the file-absolute slice misses.
    let (blob, offset_base) = if let Some(slice) =
        file_bytes.get(data_offset..data_offset.saturating_add(data_size))
    {
        (slice, "file")
    } else if let Some(slice) = arch_offset.and_then(|base| {
        file_bytes
            .get(base.saturating_add(data_offset)..base.saturating_add(data_offset).saturating_add(data_size))
    }) {
        (slice, "arch")
    } else {
        return json!({
            "arch": arch["arch"],
            "bits": arch["bits"],
            "arch_offset": arch_offset,
            "code_signature": {
                "data_offset": data_offset,
                "data_size": data_size,
                "error": "code_signature_out_of_bounds",
            },
        });
    };

    let mut out = json!({
        "arch": arch["arch"],
        "bits": arch["bits"],
        "arch_offset": arch_offset,
    });
    out["code_signature"] = superblob_report(blob, data_offset, data_size, offset_base, report);
    out
}

fn superblob_report(
    blob: &[u8],
    data_offset: usize,
    data_size: usize,
    offset_base: &str,
    report: &mut Report,
) -> Value {
    let magic = be32(blob, 0);
    let length = be32(blob, 4);
    let count = be32(blob, 8).unwrap_or(0) as usize;
    if magic != Some(CSMAGIC_EMBEDDED_SIGNATURE) && magic != Some(CSMAGIC_DETACHED_SIGNATURE) {
        return json!({
            "data_offset": data_offset,
            "data_size": data_size,
            "offset_base": offset_base,
            "magic": magic.map(|m| format!("0x{m:08x}")),
            "error": "unexpected_superblob_magic",
        });
    }
    let index_bytes = count.saturating_mul(8).saturating_add(12);
    if index_bytes > blob.len() {
        return json!({
            "data_offset": data_offset,
            "data_size": data_size,
            "offset_base": offset_base,
            "magic": magic.map(|m| format!("0x{m:08x}")),
            "error": "superblob_index_out_of_bounds",
        });
    }
    if length.map(|value| value as usize > blob.len()).unwrap_or(true) {
        report
            .warnings
            .push("superblob declared length exceeds signature region".to_string());
    }

    let index_limit = count.min(MAX_BLOB_INDEX).min(report.limit);
    let mut slots = Vec::new();
    let mut code_directory = Value::Null;
    let mut alternate_code_directories = Vec::new();
    let mut requirements = Value::Null;
    let mut entitlements = Value::Null;
    let mut der_entitlements = Value::Null;
    let mut cms = Value::Null;

    for index in 0..index_limit {
        let base = 12 + index * 8;
        let slot_type = be32(blob, base).unwrap_or(0);
        let offset = be32(blob, base + 4).unwrap_or(0) as usize;
        let blob_magic = be32(blob, offset);
        let blob_length = be32(blob, offset + 4);
        let end = offset.saturating_add(blob_length.unwrap_or(0) as usize);
        let valid = blob_length.is_some() && end <= blob.len() && end >= offset;
        slots.push(json!({
            "index": index,
            "slot_type": format!("0x{slot_type:x}"),
            "slot_name": slot_name(slot_type),
            "offset": offset,
            "length": blob_length,
            "magic": blob_magic.map(|m| format!("0x{m:08x}")),
            "magic_name": blob_magic_name(blob_magic),
            "valid": valid,
        }));
        if !valid {
            report.warnings.push(format!("blob index {index} out of bounds"));
            continue;
        }
        let content = &blob[offset..end];
        let body = &blob[(offset + 8).min(end)..end];
        match (slot_type, blob_magic.unwrap_or(0)) {
            (CSSLOT_CODEDIRECTORY, CSMAGIC_CODEDIRECTORY) => {
                code_directory = code_directory_report(content, report);
            }
            (_, CSMAGIC_CODEDIRECTORY) => {
                if alternate_code_directories.len() < MAX_ALTERNATE_CDS {
                    alternate_code_directories.push(json!({
                        "slot_type": format!("0x{slot_type:x}"),
                        "code_directory": code_directory_report(content, report),
                    }));
                } else {
                    report.truncated = true;
                }
            }
            (CSSLOT_SIGNATURE, _) | (_, CSMAGIC_BLOBWRAPPER) => {
                cms = match crate::pkcs7::inspect_der(body, report) {
                    Ok(parsed) => parsed.report,
                    Err(code) => json!({ "schema_version": 1, "error": code }),
                };
            }
            (_, CSMAGIC_REQUIREMENTS) => {
                requirements = json!({
                    "present": true,
                    "bytes": body.len(),
                    "sha256": sha256_hex(body),
                });
            }
            (_, CSMAGIC_ENTITLEMENT) => {
                entitlements = json!({
                    "present": true,
                    "bytes": body.len(),
                    "sha256": sha256_hex(body),
                    "xml": if report.include_xml {
                        json!(bounded_text(
                            &String::from_utf8_lossy(body),
                            MAX_XML_BYTES,
                            report,
                        ))
                    } else {
                        Value::Null
                    },
                });
            }
            (_, CSMAGIC_DER_ENTITLEMENT) => {
                der_entitlements = json!({
                    "present": true,
                    "bytes": body.len(),
                    "sha256": sha256_hex(body),
                });
            }
            _ => {}
        }
    }
    if count > index_limit {
        report.truncated = true;
        report.warnings.push(format!(
            "superblob indices truncated from {count} to {index_limit}"
        ));
    }
    json!({
        "data_offset": data_offset,
        "data_size": data_size,
        "offset_base": offset_base,
        "superblob": {
            "magic": format!("0x{:08x}", magic.unwrap_or(0)),
            "declared_length": length,
            "index_count": count,
        },
        "slots": slots,
        "code_directory": code_directory,
        "alternate_code_directories": alternate_code_directories,
        "requirements": requirements,
        "entitlements": entitlements,
        "der_entitlements": der_entitlements,
        "cms": cms,
    })
}

/// Parse a CodeDirectory blob. All fields are big-endian; optional fields are
/// gated on the declared version and bounded by the blob length.
fn code_directory_report(blob: &[u8], report: &mut Report) -> Value {
    let field = |offset: usize| be32(blob, offset);
    if blob.len() < 44 {
        return json!({ "error": "code_directory_too_small" });
    }
    let version = field(8).unwrap_or(0);
    let flags = field(12).unwrap_or(0);
    let hash_offset = field(16).unwrap_or(0) as usize;
    let ident_offset = field(20).unwrap_or(0) as usize;
    let n_special = field(24).unwrap_or(0);
    let n_code = field(28).unwrap_or(0);
    let hash_size = byte(blob, 36);
    let hash_type = byte(blob, 37);
    let platform = byte(blob, 38);
    let page_size_exp = byte(blob, 39);
    let scatter_offset = (version >= 0x20100).then(|| field(44).unwrap_or(0));
    let team_offset = (version >= 0x20200).then(|| field(48).unwrap_or(0) as usize);
    let code_limit64 = (version >= 0x20300).then(|| be64(blob, 56).unwrap_or(0));
    let exec_seg = (version >= 0x20400 && blob.len() >= 88).then(|| {
        json!({
            "base": be64(blob, 64).unwrap_or(0),
            "limit": be64(blob, 72).unwrap_or(0),
            "flags": be64(blob, 80).unwrap_or(0),
        })
    });
    let runtime_version =
        (version >= 0x20500 && blob.len() >= 96).then(|| field(88).unwrap_or(0));
    let pre_encrypt_offset =
        (version >= 0x20500 && blob.len() >= 96).then(|| field(92).unwrap_or(0));

    let ident = (ident_offset > 0 && ident_offset < blob.len())
        .then(|| cstr_at(blob, ident_offset, report))
        .flatten();
    let team_id = team_offset
        .filter(|offset| *offset > 0 && *offset < blob.len())
        .and_then(|offset| cstr_at(blob, offset, report));

    json!({
        "version": format!("0x{version:08x}"),
        "flags": format!("0x{flags:08x}"),
        "flag_names": code_directory_flags(flags),
        "hash_type": hash_type,
        "hash_type_name": hash_type_name(hash_type),
        "hash_size": hash_size,
        "platform": platform,
        "page_size_exponent": page_size_exp,
        "page_size": 1u64.checked_shl(page_size_exp as u32).unwrap_or(0),
        "n_special_slots": n_special,
        "n_code_slots": n_code,
        "code_limit": field(32).unwrap_or(0),
        "code_limit_64": code_limit64,
        "hash_offset": hash_offset,
        "ident_offset": ident_offset,
        "ident": ident,
        "scatter_offset": scatter_offset,
        "team_offset": team_offset,
        "team_id": team_id,
        "exec_seg": exec_seg,
        "runtime_version": runtime_version,
        "pre_encrypt_offset": pre_encrypt_offset,
    })
}

fn cstr_at(blob: &[u8], offset: usize, report: &mut Report) -> Option<String> {
    let tail = blob.get(offset..)?;
    let end = tail.iter().position(|b| *b == 0).unwrap_or(tail.len());
    let value = std::str::from_utf8(&tail[..end.min(crate::MAX_STRING_BYTES)]).ok()?;
    Some(bounded_text(value, crate::MAX_STRING_BYTES, report))
}

fn code_directory_flags(flags: u32) -> Vec<&'static str> {
    [
        (0x0001, "valid"),
        (0x0002, "adhoc"),
        (0x0004, "get_task_allow"),
        (0x0008, "installer"),
        (0x0010, "forced_lv"),
        (0x0020, "invalid_allowed"),
        (0x0040, "hard"),
        (0x0080, "kill"),
        (0x0100, "check_expiration"),
        (0x0200, "restrict"),
        (0x0400, "enforcement"),
        (0x0800, "require_lv"),
        (0x1000, "entitlements_validated"),
        (0x2000, "nvram_unrestricted"),
        (0x4000, "runtime"),
        (0x8000, "linker_signed"),
    ]
    .iter()
    .filter_map(|(bit, name)| (flags & bit != 0).then_some(*name))
    .collect()
}

fn hash_type_name(hash_type: u8) -> &'static str {
    match hash_type {
        1 => "sha1",
        2 => "sha256",
        3 => "sha256-truncated",
        4 => "sha384",
        5 => "sha512",
        _ => "unknown",
    }
}

fn slot_name(slot_type: u32) -> &'static str {
    match slot_type {
        0 => "code_directory",
        1 => "info_plist",
        2 => "requirements",
        3 => "resource_dir",
        4 => "application_specific",
        5 => "entitlements",
        7 => "der_entitlements",
        0x10000 => "cms_signature",
        0x10001 => "identification",
        0x10002 => "ticket",
        _ if (0x1000..0x2000).contains(&slot_type) => "alternate_code_directory",
        _ => "unknown",
    }
}

fn blob_magic_name(magic: Option<u32>) -> &'static str {
    match magic {
        Some(CSMAGIC_REQUIREMENTS) => "requirements",
        Some(CSMAGIC_CODEDIRECTORY) => "code_directory",
        Some(CSMAGIC_BLOBWRAPPER) => "cms_blob_wrapper",
        Some(CSMAGIC_ENTITLEMENT) => "entitlements_xml",
        Some(CSMAGIC_DER_ENTITLEMENT) => "entitlements_der",
        _ => "unknown",
    }
}

fn mach_arch(cputype: u32) -> &'static str {
    match cputype {
        7 => "x86",
        0x0100_0007 => "x86_64",
        12 => "arm",
        0x0100_000c => "aarch64",
        18 => "powerpc",
        0x0100_0012 => "powerpc64",
        _ => "unknown",
    }
}

fn be32(bytes: &[u8], offset: usize) -> Option<u32> {
    let slice = bytes.get(offset..offset + 4)?;
    Some(u32::from_be_bytes(slice.try_into().ok()?))
}

fn be64(bytes: &[u8], offset: usize) -> Option<u64> {
    let slice = bytes.get(offset..offset + 8)?;
    Some(u64::from_be_bytes(slice.try_into().ok()?))
}

fn byte(bytes: &[u8], offset: usize) -> u8 {
    bytes.get(offset).copied().unwrap_or(0)
}
