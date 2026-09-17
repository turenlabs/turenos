//! PE Authenticode inspection: extract the attribute certificate table
//! (WIN_CERTIFICATE entries), then parse the enclosed PKCS#7 SignedData and
//! the SpcIndirectData eContent. The PE image is never executed and the
//! Authenticode digest is never verified.

use serde_json::{json, Value};

use crate::{sha256_hex, Report, MAX_ITEMS};

/// One WIN_CERTIFICATE entry from the attribute certificate table.
struct WinCertificate<'a> {
    length: u32,
    revision: u16,
    certificate_type: u16,
    certificate: &'a [u8],
}

pub(crate) fn inspect(bytes: &[u8], report: &mut Report) -> Result<Value, &'static str> {
    // Permissive mode keeps a malformed certificate table from hiding the
    // rest of the PE report.
    let options = goblin::pe::options::ParseOptions::default()
        .with_parse_mode(goblin::options::ParseMode::Permissive);
    let pe =
        goblin::pe::PE::parse_with_opts(bytes, &options).map_err(|_| "pe_parse_error")?;
    // The security data directory uses a file offset, not an RVA.
    let table = pe
        .header
        .optional_header
        .as_ref()
        .and_then(|header| header.data_directories.get_certificate_table())
        .map(|directory| (directory.virtual_address as usize, directory.size as usize));

    // Enumerate WIN_CERTIFICATE entries directly: each is an 8-byte header
    // (length, revision, type) followed by the certificate bytes, with the
    // next entry at the next 8-byte boundary.
    let mut entries: Vec<WinCertificate> = Vec::new();
    if let Some((offset, size)) = table {
        let declared_end = offset.saturating_add(size);
        if declared_end > bytes.len() {
            report
                .warnings
                .push("certificate table extends past end of input".to_string());
        }
        let end = declared_end.min(bytes.len());
        let mut cursor = offset;
        while cursor + 8 <= end {
            if entries.len() >= report.limit.min(MAX_ITEMS) {
                report.truncated = true;
                report
                    .warnings
                    .push("certificate table entries truncated".to_string());
                break;
            }
            let length =
                u32::from_le_bytes(bytes[cursor..cursor + 4].try_into().unwrap()) as usize;
            let revision = u16::from_le_bytes(bytes[cursor + 4..cursor + 6].try_into().unwrap());
            let certificate_type =
                u16::from_le_bytes(bytes[cursor + 6..cursor + 8].try_into().unwrap());
            if length < 8 {
                report
                    .warnings
                    .push(format!("certificate entry {} has invalid length", entries.len()));
                break;
            }
            let entry_end = cursor.saturating_add(length).min(end);
            if cursor + length > end {
                report.warnings.push(format!(
                    "certificate entry {} declared length exceeds table",
                    entries.len()
                ));
            }
            entries.push(WinCertificate {
                length: length as u32,
                revision,
                certificate_type,
                certificate: &bytes[cursor + 8..entry_end],
            });
            // Entries are 8-byte aligned within the table.
            let next = (cursor + length + 7) & !7;
            if next <= cursor {
                break;
            }
            cursor = next;
        }
    }
    let entries: &[WinCertificate] = &entries;

    let certificates: Vec<Value> = entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            json!({
                "index": index,
                "revision": format!("0x{:04x}", entry.revision),
                "certificate_type": entry.certificate_type,
                "certificate_type_name": certificate_type_name(entry.certificate_type),
                "length": entry.length,
                "sha256": sha256_hex(entry.certificate),
            })
        })
        .collect();

    // The PKCS#7 SignedData blob lives inside WIN_CERT_TYPE_PKCS_SIGNED_DATA
    // entries; report the first one in full and count the rest.
    let mut pkcs7 = Value::Null;
    let mut spc_indirect = Value::Null;
    let mut page_hashes_present = false;
    let mut nested_signatures = 0usize;
    let mut signed_count = 0usize;
    for entry in entries {
        if entry.certificate_type != 0x0002 {
            continue;
        }
        match crate::pkcs7::inspect_der(entry.certificate, report) {
            Ok(parsed) => {
                signed_count += 1;
                if pkcs7.is_null() {
                    pkcs7 = parsed.report.clone();
                }
                if !parsed.page_hash_oids.is_empty() {
                    page_hashes_present = true;
                }
                nested_signatures += parsed.nested_signatures;
                if parsed.econtent_type.as_deref() == Some(crate::pkcs7::OID_SPC_INDIRECT_DATA)
                    && spc_indirect.is_null()
                {
                    if let Some(content) = &parsed.econtent {
                        spc_indirect = crate::spc::indirect_data_report(content);
                    }
                }
            }
            Err(code) => {
                if pkcs7.is_null() {
                    pkcs7 = json!({ "schema_version": 1, "error": code });
                }
                report
                    .warnings
                    .push(format!("pkcs7 parse failed: {code}"));
            }
        }
    }

    let table_report = table.map(|(offset, size)| {
        json!({
            "offset": format!("0x{offset:x}"),
            "size": size,
            "entries": entries.len(),
        })
    });

    Ok(json!({
        "schema_version": 1,
        "operation": "pe_authenticode",
        "pe": {
            "machine": machine_name(pe.header.coff_header.machine),
            "bits": if pe.is_64 { 64 } else { 32 },
            "is_dll": pe.is_lib,
        },
        "certificate_table": table_report,
        "win_certificates": certificates,
        "signed": signed_count > 0,
        "signed_blobs": signed_count,
        "pkcs7": pkcs7,
        "spc_indirect_data": spc_indirect,
        "page_hashes_present": page_hashes_present,
        "nested_signatures": nested_signatures,
        "truncated": report.truncated,
        "warnings": report.warnings,
    }))
}

fn certificate_type_name(value: u16) -> &'static str {
    match value {
        0x0001 => "x509",
        0x0002 => "pkcs_signed_data",
        0x0003 => "reserved_1",
        0x0004 => "ts_stack_signed",
        _ => "unknown",
    }
}

fn machine_name(machine: u16) -> &'static str {
    match machine {
        0x014c => "x86",
        0x01c0 | 0x01c4 => "arm",
        0x0200 => "ia64",
        0x8664 => "x86_64",
        0xaa64 => "aarch64",
        0x5032 | 0x5064 | 0x5128 => "riscv",
        _ => "unknown",
    }
}
