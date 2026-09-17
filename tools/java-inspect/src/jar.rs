//! `jar_inspect` — bounded JAR (ZIP) inspection: entry table, decoded
//! META-INF/MANIFEST.MF, signing-file listing, class count, multi-release
//! flag, module-info presence, and an optional `entry_index` path that
//! decompresses exactly one entry (bounded) and embeds its `class_inspect`
//! report — the retrieve-one-entry-at-a-time contract. Entries stream
//! through the `zip` crate's pure-Rust inflate; nothing touches disk.

use std::io::{Cursor, Read};

use serde::Deserialize;

use crate::{clean, fail_value, inspect, Fail, OpResult};
use crate::{
    MAX_ENTRY_BYTES, MAX_JAR_SCAN, MAX_MANIFEST_BYTES, MAX_RESULTS, MAX_STRING_CHARS,
    MAX_WARNINGS,
};

#[derive(Default, Deserialize)]
pub(crate) struct JarOptions {
    #[serde(default, alias = "maxEntries")]
    max_entries: Option<usize>,
    #[serde(default, alias = "entryIndex")]
    entry_index: Option<usize>,
}

pub(crate) fn run(bytes: &[u8], options: &JarOptions) -> OpResult {
    let max_entries = options
        .max_entries
        .unwrap_or(MAX_RESULTS)
        .clamp(1, MAX_RESULTS);
    let mut warnings: Vec<String> = Vec::new();
    let mut truncated = false;

    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| Fail::new("bad_zip").with("detail", clean(&error.to_string(), 200)))?;
    let entries_total = archive.len();
    if entries_total > MAX_JAR_SCAN && warnings.len() < MAX_WARNINGS {
        warnings.push(format!(
            "entry statistics scanned over first {MAX_JAR_SCAN} of {entries_total} entries"
        ));
    }

    let mut entries = Vec::new();
    let mut class_count = 0usize;
    let mut directory_count = 0usize;
    let mut versioned_count = 0usize;
    let mut versions: Vec<String> = Vec::new();
    let mut module_info: Option<String> = None;
    let mut signing_files = Vec::new();
    let mut manifest_index: Option<usize> = None;
    let mut scanned = 0usize;

    for index in 0..entries_total.min(MAX_JAR_SCAN) {
        let entry = match archive.by_index(index) {
            Ok(entry) => entry,
            Err(error) => {
                if warnings.len() < MAX_WARNINGS {
                    warnings.push(format!("entry {index} unreadable: {}", clean(&error.to_string(), 160)));
                }
                continue;
            }
        };
        scanned += 1;
        let name = clean(entry.name(), MAX_STRING_CHARS);
        let lower = name.to_ascii_lowercase();
        let is_dir = entry.is_dir();
        if is_dir {
            directory_count += 1;
        }
        let is_class = lower.ends_with(".class");
        if is_class {
            class_count += 1;
        }
        if lower == "meta-inf/manifest.mf" {
            manifest_index = Some(index);
        }
        if lower == "module-info.class" || lower.ends_with("/module-info.class") {
            module_info = Some(name.clone());
        }
        if let Some(rest) = lower.strip_prefix("meta-inf/versions/") {
            versioned_count += 1;
            if let Some(version) = rest.split('/').next() {
                if versions.len() < 64 && !versions.iter().any(|v| v == version) {
                    versions.push(version.to_string());
                }
            }
        }
        if lower.starts_with("meta-inf/")
            && (lower.ends_with(".sf")
                || lower.ends_with(".rsa")
                || lower.ends_with(".dsa")
                || lower.ends_with(".ec"))
        {
            signing_files.push(serde_json::json!({
                "index": index,
                "name": name,
                "size": entry.size(),
            }));
        }
        if index < max_entries {
            entries.push(serde_json::json!({
                "index": index,
                "name": name,
                "size": entry.size(),
                "compressed_size": entry.compressed_size(),
                "method": compression_name(entry.compression()),
                "is_dir": is_dir,
                "is_class": is_class,
            }));
        } else if index == max_entries {
            truncated = true;
            if warnings.len() < MAX_WARNINGS {
                warnings.push(format!(
                    "entry table truncated at {max_entries} of {entries_total} entries"
                ));
            }
        }
    }

    // Manifest: decode one bounded entry.
    let manifest = match manifest_index {
        Some(index) => decode_manifest(&mut archive, index, &mut warnings),
        None => serde_json::json!({ "present": false }),
    };
    let multi_release = manifest
        .get("main_attributes")
        .and_then(|a| a.get("Multi-Release"))
        .and_then(|v| v.as_str())
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    // Optional single-entry retrieval: decompress one entry, then run the
    // class inspector when it carries CAFEBABE.
    let selected_entry = match options.entry_index {
        Some(index) => Some(select_entry(&mut archive, index, entries_total)?),
        None => None,
    };

    Ok(serde_json::json!({
        "schema_version": 1,
        "format": "jar",
        "input_size": bytes.len(),
        "entries_total": entries_total,
        "entries_scanned": scanned,
        "directories": directory_count,
        "class_entries": class_count,
        "entries": entries,
        "manifest": manifest,
        "multi_release": multi_release || versioned_count > 0,
        "multi_release_manifest": multi_release,
        "versioned_entries": versioned_count,
        "versions": versions,
        "module_info": module_info,
        "signed": !signing_files.is_empty(),
        "signing_files": signing_files,
        "selected_entry": selected_entry,
        "warnings": warnings,
        "truncated": truncated,
    }))
}

fn compression_name(method: zip::CompressionMethod) -> String {
    format!("{method:?}").to_lowercase()
}

/// Read one entry's decompressed bytes, hard-capped at `cap` (+1 to detect
/// overflow). Returns (bytes, truncated_by_cap).
fn read_entry(
    archive: &mut zip::ZipArchive<Cursor<&[u8]>>,
    index: usize,
    cap: u64,
) -> Result<(Vec<u8>, bool, String), Fail> {
    let entry = archive
        .by_index(index)
        .map_err(|e| Fail::new("bad_zip_entry").with("detail", clean(&e.to_string(), 200)))?;
    let name = clean(entry.name(), MAX_STRING_CHARS);
    let mut buffer = Vec::new();
    let mut limited = entry.take(cap + 1);
    limited
        .read_to_end(&mut buffer)
        .map_err(|e| Fail::new("bad_zip_entry").with("detail", clean(&e.to_string(), 200)))?;
    let overflow = buffer.len() as u64 > cap;
    if overflow {
        buffer.truncate(cap as usize);
    }
    Ok((buffer, overflow, name))
}

/// Decode META-INF/MANIFEST.MF: bounded text plus parsed main attributes and
/// digest-attribute names. Read or decode failures degrade to
/// `present + read_error` — never a thrown error.
fn decode_manifest(
    archive: &mut zip::ZipArchive<Cursor<&[u8]>>,
    index: usize,
    warnings: &mut Vec<String>,
) -> serde_json::Value {
    match read_entry(archive, index, MAX_MANIFEST_BYTES) {
        Ok((raw, overflow, name)) => {
            let text = String::from_utf8_lossy(&raw);
            let (main_attributes, digests, sections) = parse_manifest(&text);
            serde_json::json!({
                "present": true,
                "index": index,
                "name": name,
                "size": raw.len(),
                "truncated": overflow,
                "main_attributes": main_attributes,
                "digest_attributes": digests,
                "section_count": sections,
                "text": clean(&text, MAX_MANIFEST_BYTES as usize),
            })
        }
        Err(fail) => {
            if warnings.len() < MAX_WARNINGS {
                warnings.push(format!("manifest entry {index} unreadable"));
            }
            serde_json::json!({
                "present": true,
                "index": index,
                "read_error": fail_value(fail)["error"],
            })
        }
    }
}

/// Manifest grammar: `Key: value` lines, continuation lines start with a
/// space, sections separated by blank lines. First section = main
/// attributes. Also collects any `*-Digest` header name seen anywhere.
fn parse_manifest(text: &str) -> (serde_json::Value, Vec<String>, usize) {
    let mut main_attributes = serde_json::Map::new();
    let mut digests: Vec<String> = Vec::new();
    let mut sections = 0usize;
    let mut section_has_content = false;
    let mut in_main = true;
    let mut last_key: Option<String> = None;
    for raw_line in text.lines() {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if line.is_empty() {
            if section_has_content {
                sections += 1;
            }
            section_has_content = false;
            in_main = false;
            last_key = None;
            continue;
        }
        section_has_content = true;
        if let Some(rest) = line.strip_prefix(' ') {
            // Continuation of the previous header's value.
            if in_main {
                if let Some(key) = &last_key {
                    if let Some(existing) = main_attributes.get_mut(key) {
                        let mut value = existing.as_str().unwrap_or("").to_string();
                        if value.len() < 512 {
                            value.push_str(&clean(rest, 512 - value.len()));
                        }
                        *existing = value.into();
                    }
                }
            }
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            let key = key.trim();
            if key.is_empty() || key.len() > 128 {
                continue;
            }
            if key.contains("Digest") || key.ends_with("-Digest") {
                if !digests.iter().any(|d| d == key) && digests.len() < 64 {
                    digests.push(key.to_string());
                }
            }
            if in_main && main_attributes.len() < 256 {
                let value = value.strip_prefix(' ').unwrap_or(value);
                main_attributes.insert(
                    key.to_string(),
                    clean(value, 512).into(),
                );
                last_key = Some(key.to_string());
            } else {
                last_key = None;
            }
        }
    }
    if section_has_content {
        sections += 1; // last section has no trailing blank line
    }
    digests.sort();
    (
        serde_json::Value::Object(main_attributes),
        digests,
        sections,
    )
}

/// `entry_index` retrieval: decompress one entry bounded at 32 MiB; when the
/// bytes carry CAFEBABE embed the full `class_inspect` report (or its error
/// JSON) under `class`.
fn select_entry(
    archive: &mut zip::ZipArchive<Cursor<&[u8]>>,
    index: usize,
    entries_total: usize,
) -> Result<serde_json::Value, Fail> {
    if index >= entries_total {
        return Err(Fail::new("entry_not_found")
            .with("entry_index", index as u64)
            .with("entries_total", entries_total as u64));
    }
    let (buffer, overflow, name) = read_entry(archive, index, MAX_ENTRY_BYTES)?;
    if overflow {
        return Err(Fail::new("entry_too_large")
            .with("entry_index", index as u64)
            .with("limit", MAX_ENTRY_BYTES));
    }
    let is_class = buffer.starts_with(&[0xCA, 0xFE, 0xBA, 0xBE]);
    let mut object = serde_json::json!({
        "index": index,
        "name": name,
        "size": buffer.len(),
        "is_class": is_class,
    });
    if is_class {
        object["class"] = match inspect::run(&buffer, &inspect::InspectOptions::default()) {
            Ok(report) => report,
            Err(fail) => fail_value(fail),
        };
    }
    Ok(object)
}

