//! Bounded APK (ZIP) inspection.
//!
//! Lists the central directory through the `zip` crate (entry count is
//! pre-checked against the EOCD before `ZipArchive` allocates), reads one
//! selected entry at a time with a hard decompressed-size cap, auto-decodes
//! `AndroidManifest.xml` through the AXML decoder, enumerates
//! `classesN.dex` entries with SHA-256, decodes `resources.arsc` package
//! names with a small bounds-checked reader, and detects the APK v2/v3
//! signing block in the ZIP preamble plus v1 `META-INF` signature entries.

use std::io::{Cursor, Read};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use crate::axml::{decode_axml, MAX_WARNINGS};
use crate::dex::{inspect_dex, DexOptions, MAX_LIST};
use crate::util::{cap_str, hex, utf16_to_string, Reader};

pub(crate) const MAX_ZIP_ENTRIES: usize = 65_536;
pub(crate) const MAX_ENTRY_BYTES: u64 = 32 * 1024 * 1024;
pub(crate) const MAX_ENTRY_NAME_CHARS: usize = 512;
const MAX_DEX_ENTRIES: usize = 16;
const MAX_META_INF: usize = 256;
const MAX_PACKAGES: usize = 256;
const MAX_SIG_IDS: usize = 64;
const MAX_SIG_BLOCK: u64 = 16 * 1024 * 1024;
pub(crate) const MAX_XML_BYTES: usize = 1024 * 1024;

const EOCD_SIG: u32 = 0x0605_4b50;
const EOCD64_LOC_SIG: u32 = 0x0706_4b50;
const EOCD64_SIG: u32 = 0x0606_4b50;
const SIG_MAGIC: &[u8; 16] = b"APK Sig Block 42";

// ResTable chunk types for the ARSC-lite package scan.
const RES_TABLE: u16 = 0x0002;
const RES_TABLE_PACKAGE: u16 = 0x0200;
const RES_TABLE_LIBRARY: u16 = 0x0203;

#[derive(Default)]
pub(crate) struct ApkOptions {
    /// Decode AndroidManifest.xml through the AXML decoder (default true).
    pub decode_manifest: bool,
    /// Run the DEX inspector on each classesN.dex and embed compact stats
    /// (default false).
    pub dex_details: bool,
    /// Entry table cap, ≤ MAX_LIST.
    pub max_entries: usize,
    /// Per-entry decompressed read cap, ≤ MAX_ENTRY_BYTES.
    pub max_entry_bytes: u64,
}

/// Locate the EOCD record by scanning the trailing comment window.
fn find_eocd(data: &[u8]) -> Option<usize> {
    if data.len() < 22 {
        return None;
    }
    let earliest = data.len().saturating_sub(22 + 65_535);
    (earliest..=data.len() - 22)
        .rev()
        .find(|&pos| data.get(pos..pos + 4) == Some(&EOCD_SIG.to_le_bytes()[..]))
}

/// (central directory offset, total entry count) honoring ZIP64.
fn central_directory(data: &[u8], eocd: usize) -> Option<(u64, u64)> {
    let mut r = Reader::at(data, eocd + 4);
    let _disk = r.u16()?;
    let _cd_disk = r.u16()?;
    let entries_disk = r.u16()? as u64;
    let mut total = r.u16()? as u64;
    let _cd_size = r.u32()?;
    let mut cd_offset = r.u32()? as u64;

    if total == 0xffff || cd_offset == 0xffff_ffff {
        // ZIP64: the locator record sits immediately before the EOCD.
        if eocd >= 20 {
            let mut loc = Reader::at(data, eocd - 20);
            if loc.u32()? == EOCD64_LOC_SIG {
                let _disk = loc.u32()?;
                let eocd64_off = loc.u64()?;
                if (eocd64_off as usize) + 56 <= data.len() {
                    let mut r64 = Reader::at(data, eocd64_off as usize);
                    if r64.u32()? == EOCD64_SIG {
                        let _size = r64.u64()?;
                        let _ver = r64.u16()?;
                        let _minver = r64.u16()?;
                        let _disk = r64.u32()?;
                        let _cd_disk = r64.u32()?;
                        let _disk_entries = r64.u64()?;
                        total = r64.u64()?;
                        let _size64 = r64.u64()?;
                        cd_offset = r64.u64()?;
                    }
                }
            }
        }
    }
    let _ = entries_disk;
    Some((cd_offset, total))
}

/// Detect the APK Signing Block sitting between the ZIP entries and the
/// central directory: `[u64 size][id/value pairs][u64 size]["APK Sig Block 42"]`.
/// Returns the contained scheme/value IDs (V2 = 0x7109871a, V3 = 0xf05368c0,
/// V3.1 = 0x1b93ad61, ...).
fn signing_block(data: &[u8], cd_offset: u64) -> Option<Vec<u32>> {
    let cd = usize::try_from(cd_offset).ok()?;
    if cd < 24 || cd > data.len() {
        return None;
    }
    if data.get(cd - 16..cd)? != SIG_MAGIC {
        return None;
    }
    let size2 = Reader::at(data, cd - 24).u64()?;
    if size2 < 24 || size2 > MAX_SIG_BLOCK {
        return None;
    }
    let pairs_len = size2 - 24;
    let pairs_start = (cd - 24).checked_sub(pairs_len as usize)?;
    // The leading u64 size must repeat the trailing one.
    if Reader::at(data, pairs_start.checked_sub(8)?).u64()? != size2 {
        return None;
    }
    let mut ids = Vec::new();
    let mut r = Reader::at(data, pairs_start);
    let pairs_end = cd - 24;
    while r.pos + 8 <= pairs_end && ids.len() < MAX_SIG_IDS {
        let len = r.u64()?;
        if len < 4 || r.pos + (len as usize) > pairs_end {
            break;
        }
        let id = r.u32()?;
        ids.push(id);
        if !r.skip((len - 4) as usize) {
            break;
        }
    }
    Some(ids)
}

fn scheme_name(id: u32) -> &'static str {
    match id {
        0x7109_871a => "v2",
        0xf053_68c0 => "v3",
        0x1b93_ad61 => "v3.1",
        0x4272_6577 => "verity_padding",
        0x6dff_800d => "source_stamp",
        0x9d63_03f3 => "dependency_baseline",
        _ => "unknown",
    }
}

fn method_name(code: u16) -> String {
    match code {
        0 => "stored".into(),
        8 => "deflated".into(),
        9 => "deflate64".into(),
        12 => "bzip2".into(),
        14 => "lzma".into(),
        93 => "zstd".into(),
        95 => "xz".into(),
        98 => "ppmd".into(),
        99 => "aes".into(),
        other => format!("unsupported_{other}"),
    }
}

/// Read at most `cap` decompressed bytes of one entry. Returns
/// (bytes, uncompressed_size_reported, truncated).
fn read_entry(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    index: usize,
    cap: u64,
) -> Result<(Vec<u8>, u64, bool), String> {
    let file = archive
        .by_index(index)
        .map_err(|e| format!("entry_read_failed:{e}"))?;
    let reported = file.size();
    let mut limited = file.take(cap.saturating_add(1));
    let mut buf = Vec::with_capacity(reported.min(cap).min(1 << 20) as usize);
    limited
        .read_to_end(&mut buf)
        .map_err(|e| format!("entry_read_failed:{e}"))?;
    let truncated = buf.len() as u64 > cap || reported > cap;
    if buf.len() as u64 > cap {
        buf.truncate(cap as usize);
    }
    Ok((buf, reported, truncated))
}

/// Extract `classesN.dex` (index 1 = classes.dex) for `dex_inspect` when the
/// input is an APK/ZIP container instead of raw DEX bytes.
pub(crate) fn extract_dex(data: &[u8], dex_index: u32) -> Result<Vec<u8>, String> {
    let wanted = if dex_index <= 1 {
        "classes.dex".to_string()
    } else {
        format!("classes{dex_index}.dex")
    };
    let mut archive = open_zip(data)?;
    for i in 0..archive.len().min(MAX_LIST) {
        let name = archive
            .by_index(i)
            .map(|f| f.name().to_string())
            .unwrap_or_default();
        if name == wanted {
            let (bytes, _size, truncated) = read_entry(&mut archive, i, MAX_ENTRY_BYTES)?;
            if truncated {
                return Err("dex_entry_too_large".into());
            }
            return Ok(bytes);
        }
    }
    Err(format!("dex_not_found:{wanted}"))
}

/// EOCD pre-check then `ZipArchive` open. Rejects absurd entry counts before
/// the archive allocates its member table.
fn open_zip(data: &[u8]) -> Result<ZipArchive<Cursor<&[u8]>>, String> {
    if data.len() < 4 || &data[0..4] != b"PK\x03\x04" {
        if data.len() >= 4 && &data[0..4] == b"PK\x05\x06" {
            // Empty archive is still a valid container.
        } else {
            return Err("bad_magic".into());
        }
    }
    let eocd = find_eocd(data).ok_or_else(|| "missing_eocd".to_string())?;
    let (_cd_offset, total) =
        central_directory(data, eocd).ok_or_else(|| "malformed_eocd".to_string())?;
    if total > MAX_ZIP_ENTRIES as u64 {
        return Err("too_many_entries".into());
    }
    ZipArchive::new(Cursor::new(data)).map_err(|e| format!("zip_parse_failed:{e}"))
}

/// ARSC-lite: ResTable → ResTablePackage chunks → package id/name pairs.
fn arsc_packages(data: &[u8], warnings: &mut Vec<String>) -> Vec<Value> {
    let mut out = Vec::new();
    let mut head = Reader::new(data);
    let Some(ctype) = head.u16() else {
        warnings.push("arsc_too_small".into());
        return out;
    };
    if ctype != RES_TABLE {
        warnings.push("arsc_bad_magic".into());
        return out;
    }
    let header_size = head.u16().unwrap_or(0) as usize;
    let size = head.u32().unwrap_or(0) as usize;
    if header_size < 12 || size > data.len() {
        warnings.push("arsc_malformed_header".into());
        return out;
    }
    let package_count = head.u32().unwrap_or(0);
    let mut pos = header_size;
    while pos + 8 <= size && out.len() < MAX_PACKAGES {
        let mut chunk = Reader::at(data, pos);
        let ctype = chunk.u16().unwrap_or(0);
        let hsize = chunk.u16().unwrap_or(0) as usize;
        let csize = chunk.u32().unwrap_or(0) as usize;
        if csize < hsize || hsize < 8 || pos + csize > size {
            warnings.push("arsc_chunk_overrun".into());
            break;
        }
        if ctype == RES_TABLE_PACKAGE && csize >= 0x120 && hsize >= 0x120 {
            // id u32 then name[128] UTF-16LE at fixed offsets.
            let mut pr = Reader::at(data, pos + 8);
            let id = pr.u32().unwrap_or(0);
            let mut units = [0u16; 128];
            let mut used = 0usize;
            for unit in units.iter_mut() {
                match pr.u16() {
                    Some(0) | None => break,
                    Some(value) => {
                        *unit = value;
                        used += 1;
                    }
                }
            }
            let name = utf16_to_string(&units[..used]);
            out.push(json!({
                "id": format!("0x{id:02x}"),
                "name": cap_str(&name, 256),
            }));
        } else if ctype == RES_TABLE_LIBRARY {
            // Library chunk: header + count + entries{packageId u32, name[128] u16}
            if hsize >= 12 {
                let mut lr = Reader::at(data, pos + 8);
                let count = lr.u32().unwrap_or(0) as usize;
                let mut epos = pos + hsize;
                for _ in 0..count.min(MAX_PACKAGES) {
                    if epos + 8 + 256 > pos + csize {
                        break;
                    }
                    let mut er = Reader::at(data, epos);
                    let pid = er.u32().unwrap_or(0);
                    let mut units = [0u16; 128];
                    let mut used = 0usize;
                    for unit in units.iter_mut() {
                        match er.u16() {
                            Some(0) | None => break,
                            Some(v) => {
                                *unit = v;
                                used += 1;
                            }
                        }
                    }
                    out.push(json!({
                        "id": format!("0x{pid:02x}"),
                        "name": cap_str(&utf16_to_string(&units[..used]), 256),
                        "library": true,
                    }));
                    epos += 8 + 256;
                }
            }
        }
        pos += csize;
    }
    if package_count as usize > out.len() {
        warnings.push("arsc_packages_clamped".into());
    }
    out
}

fn is_dex_name(name: &str) -> bool {
    let rest = match name.strip_prefix("classes") {
        Some(rest) => rest,
        None => return false,
    };
    let digits = rest.strip_suffix(".dex").unwrap_or("");
    if digits.is_empty() {
        return rest == ".dex";
    }
    digits.bytes().all(|b| b.is_ascii_digit())
}

fn dex_index_of(name: &str) -> u32 {
    if name == "classes.dex" {
        return 1;
    }
    name["classes".len()..name.len() - ".dex".len()]
        .parse()
        .unwrap_or(0)
}

fn warn(warnings: &mut Vec<String>, message: &str) {
    if warnings.len() < MAX_WARNINGS && !warnings.iter().any(|w| w == message) {
        warnings.push(message.to_string());
    }
}

/// Inspect an APK container.
pub(crate) fn inspect_apk(data: &[u8], options: &ApkOptions) -> Result<Value, String> {
    let mut archive = open_zip(data)?;
    let mut warnings: Vec<String> = Vec::new();

    // Signing block from the EOCD/central-directory geometry.
    let eocd = find_eocd(data).unwrap_or(0);
    let (cd_offset, _total) = central_directory(data, eocd).unwrap_or((0, 0));
    let schemes = signing_block(data, cd_offset).unwrap_or_default();

    let total = archive.len();
    let mut entries = Vec::new();
    let mut manifest_index: Option<usize> = None;
    let mut dex_names: Vec<(usize, String)> = Vec::new();
    let mut arsc_index: Option<usize> = None;
    let mut meta_inf: Vec<String> = Vec::new();
    let truncated = total > options.max_entries;

    for i in 0..total.min(MAX_ZIP_ENTRIES) {
        let file = match archive.by_index_raw(i) {
            Ok(file) => file,
            Err(_) => {
                warn(&mut warnings, "entry_header_failed");
                continue;
            }
        };
        let name = file.name().to_string();
        let lower = name.to_ascii_lowercase();
        if name == "AndroidManifest.xml" {
            manifest_index = Some(i);
        } else if is_dex_name(&name) {
            dex_names.push((i, name.clone()));
        } else if name == "resources.arsc" {
            arsc_index = Some(i);
        } else if lower.starts_with("meta-inf/") {
            if meta_inf.len() < MAX_META_INF {
                meta_inf.push(name.clone());
            }
        }
        if entries.len() < options.max_entries {
            // `to_u16` is deprecated; every method without a compiled-in
            // codec arrives as `Unsupported(raw_code)`, so the raw ZIP
            // method id is still recovered for reporting.
            let method = match file.compression() {
                zip::CompressionMethod::Stored => 0,
                zip::CompressionMethod::Deflated => 8,
                #[allow(deprecated)]
                zip::CompressionMethod::Unsupported(code) => code,
                _ => u16::MAX,
            };
            entries.push(json!({
                "index": i,
                "name": cap_str(&name, MAX_ENTRY_NAME_CHARS),
                "method": method,
                "method_name": method_name(method),
                "size": file.size(),
                "compressed_size": file.compressed_size(),
                "crc32": format!("0x{:08x}", file.crc32()),
                "dir": file.is_dir(),
            }));
        }
    }
    if total > MAX_ZIP_ENTRIES {
        warn(&mut warnings, "entry_scan_capped");
    }
    dex_names.sort_by_key(|(_, name)| dex_index_of(name));
    if dex_names.len() > MAX_DEX_ENTRIES {
        warn(&mut warnings, "dex_entries_capped");
        dex_names.truncate(MAX_DEX_ENTRIES);
    }

    // ---- AndroidManifest.xml ----
    let mut manifest = Map::new();
    manifest.insert("present".into(), Value::Bool(manifest_index.is_some()));
    if let (true, Some(index)) = (options.decode_manifest, manifest_index) {
        match read_entry(&mut archive, index, options.max_entry_bytes) {
            Ok((bytes, _reported, entry_truncated)) => {
                manifest.insert("truncated".into(), Value::Bool(entry_truncated));
                match decode_axml(&bytes, MAX_XML_BYTES) {
                    Ok(report) => {
                        manifest.insert("decoded".into(), Value::Bool(true));
                        manifest.insert("xml".into(), Value::from(report.xml));
                        manifest
                            .insert("xml_truncated".into(), Value::Bool(report.xml_truncated));
                        manifest.insert("elements".into(), Value::from(report.elements));
                        manifest
                            .insert("attributes".into(), Value::from(report.attributes));
                        manifest.insert(
                            "namespaces".into(),
                            Value::from(
                                report
                                    .namespaces
                                    .iter()
                                    .map(|(p, u)| json!({"prefix": p, "uri": u}))
                                    .collect::<Vec<_>>(),
                            ),
                        );
                        manifest.insert(
                            "warnings".into(),
                            Value::from(report.warnings.clone()),
                        );
                    }
                    Err(code) => {
                        manifest.insert("decoded".into(), Value::Bool(false));
                        manifest.insert("error".into(), Value::from(code));
                    }
                }
            }
            Err(code) => {
                manifest.insert("decoded".into(), Value::Bool(false));
                manifest.insert("error".into(), Value::from(code));
            }
        }
    }

    // ---- classesN.dex entries ----
    let mut dex_files = Vec::new();
    for (index, name) in &dex_names {
        let mut item = Map::new();
        item.insert("name".into(), Value::from(cap_str(name, 128)));
        match read_entry(&mut archive, *index, options.max_entry_bytes) {
            Ok((bytes, reported, entry_truncated)) => {
                item.insert("size".into(), Value::from(reported));
                item.insert("truncated".into(), Value::Bool(entry_truncated));
                if entry_truncated {
                    item.insert("sha256".into(), Value::Null);
                } else {
                    let digest = Sha256::digest(&bytes);
                    item.insert("sha256".into(), Value::from(hex(&digest)));
                }
                if bytes.len() >= 8 && &bytes[0..4] == b"dex\n" {
                    item.insert(
                        "dex_version".into(),
                        Value::from(String::from_utf8_lossy(&bytes[4..7]).to_string()),
                    );
                }
                if options.dex_details && !entry_truncated {
                    let dex_opts = DexOptions {
                        dex_index: dex_index_of(name),
                        limit: MAX_LIST,
                        include_strings: false,
                    };
                    match inspect_dex(&bytes, &dex_opts) {
                        Ok(report) => {
                            // Embed only compact counts, never full lists.
                            let compact = json!({
                                "counts": report.get("counts").cloned().unwrap_or(Value::Null),
                                "stats": report.get("stats").cloned().unwrap_or(Value::Null),
                                "findings": report.get("findings").cloned().unwrap_or(Value::Null),
                                "truncated": report.get("truncated").cloned().unwrap_or(Value::Null),
                            });
                            item.insert("dex".into(), compact);
                        }
                        Err(code) => {
                            item.insert("dex_error".into(), Value::from(code));
                        }
                    }
                }
            }
            Err(code) => {
                item.insert("error".into(), Value::from(code));
            }
        }
        dex_files.push(Value::Object(item));
    }

    // ---- resources.arsc ----
    let mut arsc = Map::new();
    arsc.insert("present".into(), Value::Bool(arsc_index.is_some()));
    if let Some(index) = arsc_index {
        match read_entry(&mut archive, index, options.max_entry_bytes) {
            Ok((bytes, _reported, entry_truncated)) => {
                arsc.insert("truncated".into(), Value::Bool(entry_truncated));
                let packages = arsc_packages(&bytes, &mut warnings);
                arsc.insert("packages".into(), Value::from(packages));
            }
            Err(code) => {
                arsc.insert("error".into(), Value::from(code));
            }
        }
    }

    // ---- v1 signatures ----
    meta_inf.sort();
    let v1: Vec<String> = meta_inf
        .iter()
        .filter(|name| {
            let upper = name.to_ascii_uppercase();
            upper == "META-INF/MANIFEST.MF"
                || upper.ends_with(".SF")
                || upper.ends_with(".RSA")
                || upper.ends_with(".DSA")
                || upper.ends_with(".EC")
        })
        .cloned()
        .collect();

    let mut signing = Map::new();
    signing.insert(
        "v2_block".into(),
        Value::Bool(!schemes.is_empty()),
    );
    signing.insert(
        "schemes".into(),
        Value::from(
            schemes
                .iter()
                .map(|id| json!({"id": format!("0x{id:08x}"), "name": scheme_name(*id)}))
                .collect::<Vec<_>>(),
        ),
    );
    signing.insert("v1_entries".into(), Value::from(v1.clone()));
    signing.insert("v1_signed".into(), Value::Bool(!v1.is_empty()));
    signing.insert(
        "meta_inf_entries".into(),
        Value::from(meta_inf.clone()),
    );

    if truncated {
        warnings.push("entry_table_truncated".into());
    }

    Ok(json!({
        "schema_version": 1,
        "kind": "apk",
        "input_bytes": data.len(),
        "zip": {
            "entry_count": total,
            "entries": entries,
        },
        "manifest": Value::Object(manifest),
        "dex_files": dex_files,
        "resources_arsc": Value::Object(arsc),
        "signing": Value::Object(signing),
        "warnings": warnings,
        "truncated": truncated,
    }))
}
