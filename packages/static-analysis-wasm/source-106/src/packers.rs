use serde_json::{json, Value};

// Reviewed equality-only subset of DIE's MIT-licensed generic PE heuristics.
// ASPack requires both names; the ambiguous Themida .loadcon name is omitted.
const SOURCE: &str = "https://github.com/horsicq/Detect-It-Easy";
const REVISION: &str = "875f45de6dc3bb73406038c76dfab30ff205e96e";
const RULES: [(&str, &[&str], bool); 8] = [
    ("Themida", &[".themida", ".winlice"], false),
    ("UPX", &["UPX0", "UPX1", "UPX2", "UPX3"], false),
    ("VMProtect", &[".vmp0", ".vmp1", ".vmp2", ".vmp3"], false),
    ("ASPack", &[".aspack", ".adata"], true),
    ("Enigma", &[".enigma1", ".enigma2"], false),
    (
        "NsPack",
        &[
            "nsp0", "nsp1", ".nsp0", ".nsp1", "PEP0", "PEP1", "PEp0", "PEp1", ".Packer!",
        ],
        false,
    ),
    ("PECompact", &["PEC2", "PEC2MO", "pec", "pec1"], false),
    ("Petite", &["petite", ".petite"], false),
];

pub fn detect(bytes: &[u8]) -> Value {
    let mut matches = Vec::new();
    let mut warnings = Vec::new();
    if bytes.len() > 32 * 1024 * 1024 {
        warnings.push("input exceeds 32 MiB; no detection performed");
    } else {
        match pe_sections(bytes) {
            Ok(sections) => {
                for (name, names, require_all) in RULES {
                    if require_all
                        && !names
                            .iter()
                            .all(|name| sections.iter().any(|section| section.0 == *name))
                    {
                        continue;
                    }
                    let evidence = sections.iter().filter(|section| names.contains(&section.0.as_str()))
                        .map(|section| json!({"kind":"pe_section_name", "name":section.0, "headerOffset":section.1}))
                        .collect::<Vec<_>>();
                    if evidence.is_empty() {
                        continue;
                    }
                    matches.push(
                        json!({"name":name, "confidence":"heuristic", "evidence":evidence,
                        "rule":"db/PE/__GenericHeuristicAnalysis_By_DosX.7.sg", "source":SOURCE}),
                    );
                }
            }
            Err(warning) => warnings.push(warning),
        }
        // Legacy raw markers are not DIE rules, and do not establish a PE or packer.
        // Return only the first occurrence of each, bounding evidence before collection.
        for (name, marker) in [("UPX", "UPX!"), ("MPRESS", "MPRESS")] {
            if let Some(offset) = bytes
                .windows(marker.len())
                .position(|window| window == marker.as_bytes())
            {
                matches.push(
                    json!({"name":name, "confidence":"low", "source":"Turen legacy raw marker",
                    "evidence":[{"kind":"raw_marker", "marker":marker, "offset":offset}]}),
                );
            }
        }
    }
    json!({"count":matches.len(), "matches":matches, "warnings":warnings,
        "ruleSet":{"source":SOURCE, "revision":REVISION, "license":"MIT"},
        "interpretation":"Heuristic indicators only; not proof of packing or malware. No packer version is inferred."})
}

fn pe_sections(bytes: &[u8]) -> Result<Vec<(String, usize)>, &'static str> {
    use goblin::pe::{header, section_table};
    if !bytes.starts_with(b"MZ") {
        return Err("not a PE image; PE section rules were not evaluated");
    }
    let dos = header::DosHeader::parse(bytes).map_err(|_| "invalid PE DOS header")?;
    let pe = usize::try_from(dos.pe_pointer).map_err(|_| "PE offset overflow")?;
    let signature_end = pe.checked_add(4).ok_or("PE offset overflow")?;
    if bytes.get(pe..signature_end) != Some(b"PE\0\0".as_slice()) {
        return Err("invalid PE signature");
    }
    let mut offset = signature_end;
    let coff =
        header::CoffHeader::parse(bytes, &mut offset).map_err(|_| "invalid PE COFF header")?;
    // Inspect headers only, not imports, exports, debug data or raw section payloads.
    // Windows supports at most 96 sections; reject larger counts before allocation.
    if coff.number_of_sections > 96 {
        return Err("PE section count exceeds 96; section rules skipped");
    }
    let optional_end = offset
        .checked_add(usize::from(coff.size_of_optional_header))
        .ok_or("PE offset overflow")?;
    let optional = bytes
        .get(offset..optional_end)
        .ok_or("truncated PE optional header")?;
    if !(optional.starts_with(&[0x0b, 0x01]) && optional.len() >= 96
        || optional.starts_with(&[0x0b, 0x02]) && optional.len() >= 112)
    {
        return Err("invalid PE optional header");
    }
    offset = optional_end;
    let end = usize::from(coff.number_of_sections)
        .checked_mul(section_table::SIZEOF_SECTION_TABLE)
        .and_then(|length| offset.checked_add(length))
        .ok_or("PE section range overflow")?;
    if end > bytes.len() {
        return Err("truncated PE section table");
    }
    let mut sections = Vec::new();
    for _ in 0..coff.number_of_sections {
        let start = offset;
        // Long COFF names are not PE section-name equality evidence. Skip them without
        // resolving attacker-controlled string-table offsets or allocating long strings.
        if bytes[start] == b'/' {
            offset += section_table::SIZEOF_SECTION_TABLE;
            continue;
        }
        let section = section_table::SectionTable::parse(bytes, &mut offset, 0)
            .map_err(|_| "invalid PE section header")?;
        let length = section
            .name
            .iter()
            .rposition(|byte| *byte != 0)
            .map_or(0, |index| index + 1);
        if let Ok(name) = std::str::from_utf8(&section.name[..length]) {
            sections.push((name.to_owned(), start));
        }
    }
    Ok(sections)
}

#[cfg(test)]
mod tests {
    use super::{detect, RULES};

    fn pe(names: &[&str]) -> Vec<u8> {
        let mut bytes = vec![0; 0x178 + names.len() * 40];
        bytes[..2].copy_from_slice(b"MZ");
        bytes[0x3c..0x40].copy_from_slice(&0x80u32.to_le_bytes());
        bytes[0x80..0x84].copy_from_slice(b"PE\0\0");
        bytes[0x84..0x86].copy_from_slice(&0x14cu16.to_le_bytes());
        bytes[0x86..0x88].copy_from_slice(&(names.len() as u16).to_le_bytes());
        bytes[0x94..0x96].copy_from_slice(&224u16.to_le_bytes());
        bytes[0x98..0x9a].copy_from_slice(&0x10bu16.to_le_bytes());
        for (index, name) in names.iter().enumerate() {
            let offset = 0x178 + index * 40;
            bytes[offset..offset + name.len()].copy_from_slice(name.as_bytes());
        }
        bytes
    }

    #[test]
    fn exact_catalog_and_header_evidence() {
        for (name, names, all) in RULES {
            let report = detect(&pe(names));
            assert_eq!(report["count"], 1, "{name}");
            assert_eq!(report["matches"][0]["name"], name);
            assert_eq!(report["matches"][0]["confidence"], "heuristic");
            assert_eq!(report["matches"][0]["evidence"][0]["name"], names[0]);
            assert_eq!(report["matches"][0]["evidence"][0]["headerOffset"], 0x178);
            if all {
                assert_eq!(detect(&pe(&names[..1]))["count"], 0);
            }
        }
    }

    #[test]
    fn similar_names_do_not_match() {
        for name in [
            "upx0", "UPX4", "UPX01", ".vmp4", ".VMP0", ".themidX", ".loadcon", ".enigma3", "pec12",
            "petiteX", "nsp2", "UPX0\0X",
        ] {
            assert_eq!(detect(&pe(&[name]))["count"], 0, "{name}");
        }
    }

    #[test]
    fn invalid_inputs_only_report_literal_markers() {
        let report = detect(b"not PE .themida UPX! MPRESS UPX!");
        assert_eq!(report["count"], 2);
        assert_eq!(report["matches"][0]["confidence"], "low");
        assert_eq!(report["matches"][0]["evidence"][0]["offset"], 16);
        assert_eq!(detect(b"MZ .aspack .adata")["count"], 0);
        assert_eq!(detect(b"nothing")["count"], 0);
        let mut malformed = pe(&["UPX0"]);
        malformed.pop();
        assert_eq!(detect(&malformed)["count"], 0);
        malformed[0x86..0x88].copy_from_slice(&97u16.to_le_bytes());
        assert!(detect(&malformed)["warnings"][0]
            .as_str()
            .unwrap()
            .contains("96"));
    }
}
