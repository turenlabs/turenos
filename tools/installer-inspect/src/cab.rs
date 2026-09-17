//! Microsoft Cabinet (MS-CAB) listing and bounded single-file extraction.
//!
//! The CFHEADER/CFFOLDER/CFFILE walk is implemented here so that listing can
//! report per-file folder offsets, reserved bytes, and previous/next cabinet
//! names that the `cab` crate does not expose. Decompression for
//! `cab_extract` uses the `cab` crate (`read_file`), which handles MSZIP
//! (flate2/miniz_oxide), LZX (lzxd), and stored folders including data that
//! spans multiple CFDATA blocks.

use std::io::{Cursor, Read};
use std::panic::{catch_unwind, AssertUnwindSafe};

use serde_json::{json, Map, Value};

use sha2::{Digest, Sha256};

use crate::{
    check_input, clean, error_json, finish_json, option_string, option_u64, parse_options,
    MAX_CONTENT_BYTES, MAX_EXTRACT_BYTES, MAX_LIST_ITEMS,
};

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// iFolder sentinel: file's data begins in the previous cabinet of the set.
const FOLDER_CONTINUED_FROM_PREV: u16 = 0xfffd;
/// iFolder sentinel: file's data continues into the next cabinet of the set.
const FOLDER_CONTINUED_TO_NEXT: u16 = 0xffff;

/// Largest null-terminated name scan accepted inside a cabinet.
const MAX_NAME_BYTES: usize = 1024;
/// Largest per-folder/per-data reserved region read during header parse.
const MAX_RESERVE_BYTES: usize = 4096;

struct CabFile {
    name: String,
    size: u32,
    folder_offset: u32,
    folder_index: u16,
    date: u16,
    time: u16,
    attribs: u16,
    utf8_name: bool,
}

struct CabFolder {
    data_offset: u32,
    num_blocks: u16,
    compression_bits: u16,
    reserve: Vec<u8>,
}

struct CabInfo {
    total_size: u32,
    files_offset: u32,
    version_minor: u8,
    version_major: u8,
    flags: u16,
    set_id: u16,
    set_index: u16,
    reserve_data: Vec<u8>,
    data_reserve_size: u8,
    prev_cabinet: Option<(String, String)>,
    next_cabinet: Option<(String, String)>,
    folders: Vec<CabFolder>,
    files: Vec<CabFile>,
    /// Names of non-zero CFHEADER reserved fields (spec violation).
    nonzero_reserved: Vec<&'static str>,
    /// Counts declared by the header before list caps were applied.
    declared_folders: usize,
    declared_files: usize,
    /// Bytes the parser consumed through the end of the file entries.
    parsed_end: u64,
}

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Reader<'a> {
        Reader { bytes, pos: 0 }
    }

    fn remaining(&self) -> usize {
        self.bytes.len().saturating_sub(self.pos)
    }

    fn take(&mut self, count: usize, what: &str) -> Result<&'a [u8], String> {
        if self.remaining() < count {
            return Err(error_json(
                "truncated_cabinet",
                json!({ "detail": format!("ran out of input reading {what} at offset {}", self.pos) }),
            ));
        }
        let slice = &self.bytes[self.pos..self.pos + count];
        self.pos += count;
        Ok(slice)
    }

    fn u8(&mut self, what: &str) -> Result<u8, String> {
        Ok(self.take(1, what)?[0])
    }

    fn u16(&mut self, what: &str) -> Result<u16, String> {
        let bytes = self.take(2, what)?;
        Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
    }

    fn u32(&mut self, what: &str) -> Result<u32, String> {
        let bytes = self.take(4, what)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn cstring(&mut self, what: &str) -> Result<String, String> {
        let window = &self.bytes[self.pos..self.pos + self.remaining().min(MAX_NAME_BYTES)];
        let end = window
            .iter()
            .position(|b| *b == 0)
            .ok_or_else(|| {
                error_json(
                    "invalid_cabinet",
                    json!({ "detail": format!("unterminated {what} string at offset {}", self.pos) }),
                )
            })?;
        let raw = &window[..end];
        self.pos += end + 1;
        Ok(String::from_utf8_lossy(raw).into_owned())
    }
}

/// Parse the cabinet header, folder table, and file table. Read-only and
/// bounded: at most `MAX_LIST_ITEMS` folders and files are decoded.
fn parse_cabinet(bytes: &[u8]) -> Result<CabInfo, String> {
    let mut reader = Reader::new(bytes);
    let signature = reader.take(4, "signature")?;
    if signature != b"MSCF" {
        return Err(error_json(
            "not_cabinet",
            json!({ "detail": "missing MSCF signature" }),
        ));
    }
    let reserved1 = reader.u32("reserved1")?;
    let total_size = reader.u32("cbCabinet")?;
    let reserved2 = reader.u32("reserved2")?;
    let files_offset = reader.u32("coffFiles")?;
    let reserved3 = reader.u32("reserved3")?;
    let version_minor = reader.u8("versionMinor")?;
    let version_major = reader.u8("versionMajor")?;
    if version_major != 1 {
        return Err(error_json(
            "unsupported_version",
            json!({ "versionMajor": version_major, "versionMinor": version_minor }),
        ));
    }
    let num_folders = reader.u16("cFolders")? as usize;
    let num_files = reader.u16("cFiles")? as usize;
    let flags = reader.u16("flags")?;
    let set_id = reader.u16("setID")?;
    let set_index = reader.u16("iCabinet")?;

    let nonzero_reserved = {
        let mut fields = Vec::new();
        if reserved1 != 0 {
            fields.push("reserved1");
        }
        if reserved2 != 0 {
            fields.push("reserved2");
        }
        if reserved3 != 0 {
            fields.push("reserved3");
        }
        fields
    };

    let mut header_reserve = Vec::new();
    let mut folder_reserve_size = 0u8;
    let mut data_reserve_size = 0u8;
    if flags & 0x4 != 0 {
        let header_reserve_size = reader.u16("cbCFHeader")? as usize;
        folder_reserve_size = reader.u8("cbCFFolder")?;
        data_reserve_size = reader.u8("cbCFData")?;
        if header_reserve_size > MAX_RESERVE_BYTES {
            return Err(error_json(
                "invalid_cabinet",
                json!({ "detail": format!("header reserve size {header_reserve_size} exceeds bound") }),
            ));
        }
        header_reserve = reader.take(header_reserve_size, "header reserve")?.to_vec();
    }

    let prev_cabinet = if flags & 0x1 != 0 {
        let name = reader.cstring("prevCabinet name")?;
        let disk = reader.cstring("prevCabinet disk")?;
        Some((name, disk))
    } else {
        None
    };
    let next_cabinet = if flags & 0x2 != 0 {
        let name = reader.cstring("nextCabinet name")?;
        let disk = reader.cstring("nextCabinet disk")?;
        Some((name, disk))
    } else {
        None
    };

    let mut folders = Vec::with_capacity(num_folders.min(MAX_LIST_ITEMS));
    for index in 0..num_folders {
        if index >= MAX_LIST_ITEMS {
            break;
        }
        let data_offset = reader.u32("CFFOLDER.coffCabStart")?;
        let num_blocks = reader.u16("CFFOLDER.cCFData")?;
        let compression_bits = reader.u16("CFFOLDER.typeCompress")?;
        let reserve = reader
            .take(folder_reserve_size as usize, "CFFOLDER.abReserve")?
            .to_vec();
        folders.push(CabFolder {
            data_offset,
            num_blocks,
            compression_bits,
            reserve,
        });
    }

    if (files_offset as usize) > bytes.len() {
        return Err(error_json(
            "invalid_cabinet",
            json!({ "detail": format!("coffFiles {files_offset} is beyond input size {}", bytes.len()) }),
        ));
    }
    reader.pos = files_offset as usize;

    let mut files = Vec::with_capacity(num_files.min(MAX_LIST_ITEMS));
    for index in 0..num_files {
        if index >= MAX_LIST_ITEMS {
            break;
        }
        let size = reader.u32("CFFILE.cbFile")?;
        let folder_offset = reader.u32("CFFILE.uoffFolderStart")?;
        let folder_index = reader.u16("CFFILE.iFolder")?;
        let date = reader.u16("CFFILE.date")?;
        let time = reader.u16("CFFILE.time")?;
        let attribs = reader.u16("CFFILE.attribs")?;
        let utf8_name = attribs & 0x80 != 0;
        let name = reader.cstring("CFFILE.szName")?;
        files.push(CabFile {
            name,
            size,
            folder_offset,
            folder_index,
            date,
            time,
            attribs,
            utf8_name,
        });
    }

    Ok(CabInfo {
        total_size,
        files_offset,
        version_minor,
        version_major,
        flags,
        set_id,
        set_index,
        reserve_data: header_reserve,
        data_reserve_size,
        prev_cabinet,
        next_cabinet,
        folders,
        files,
        nonzero_reserved,
        declared_folders: num_folders,
        declared_files: num_files,
        parsed_end: reader.pos as u64,
    })
}

fn compression_json(bits: u16) -> Value {
    let scheme = match bits & 0x000f {
        0 => "none",
        1 => "mszip",
        2 => "quantum",
        3 => "lzx",
        _ => "unknown",
    };
    let mut out = Map::new();
    out.insert("scheme".into(), json!(scheme));
    out.insert("bits".into(), json!(format!("0x{bits:04x}")));
    match scheme {
        "quantum" => {
            out.insert("level".into(), json!((bits & 0x00f0) >> 4));
            out.insert("memory".into(), json!((bits & 0x1f00) >> 8));
        }
        "lzx" => {
            let window_bits = (bits & 0x1f00) >> 8;
            out.insert("windowBits".into(), json!(window_bits));
            if (15..=32).contains(&window_bits) {
                out.insert("windowBytes".into(), json!(1u64 << window_bits));
            }
        }
        _ => {}
    }
    Value::Object(out)
}

fn compression_supported(bits: u16) -> bool {
    matches!(bits & 0x000f, 0 | 1 | 3)
}

fn dos_datetime(date: u16, time: u16) -> Option<String> {
    let year = 1980 + ((date >> 9) & 0x7f);
    let month = (date >> 5) & 0x0f;
    let day = date & 0x1f;
    let hour = (time >> 11) & 0x1f;
    let minute = (time >> 5) & 0x3f;
    let second = (time & 0x1f) * 2;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some(format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}"))
}

fn attribute_names(attribs: u16) -> Vec<&'static str> {
    let mut names = Vec::new();
    if attribs & 0x01 != 0 {
        names.push("readOnly");
    }
    if attribs & 0x02 != 0 {
        names.push("hidden");
    }
    if attribs & 0x04 != 0 {
        names.push("system");
    }
    if attribs & 0x20 != 0 {
        names.push("archive");
    }
    if attribs & 0x40 != 0 {
        names.push("exec");
    }
    if attribs & 0x80 != 0 {
        names.push("nameIsUtf");
    }
    names
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

pub(crate) fn list_impl(bytes: &[u8], options_json: &str) -> Result<String, String> {
    check_input(bytes)?;
    let options = parse_options(options_json)?;
    let max_files = option_u64(&options, "maxFiles")?
        .map(|value| value.clamp(1, MAX_LIST_ITEMS as u64) as usize)
        .unwrap_or(MAX_LIST_ITEMS);

    let info = match catch_unwind(AssertUnwindSafe(|| parse_cabinet(bytes))) {
        Ok(result) => result?,
        Err(_) => {
            return Err(error_json(
                "internal",
                json!({ "detail": "panic during cabinet parse" }),
            ))
        }
    };

    let mut warnings = Vec::new();
    let mut truncated = false;

    let folders: Vec<Value> = info
        .folders
        .iter()
        .enumerate()
        .map(|(index, folder)| {
            json!({
                "index": index,
                "dataOffset": folder.data_offset,
                "dataBlocks": folder.num_blocks,
                "compression": compression_json(folder.compression_bits),
                "compressionSupported": compression_supported(folder.compression_bits),
                "reserveBytes": folder.reserve.len(),
                "reserveHex": if folder.reserve.is_empty() { Value::Null } else { json!(hex(&folder.reserve)) },
            })
        })
        .collect();
    let folder_count = info.folders.len();
    if info.declared_folders > info.folders.len() {
        truncated = true;
        warnings.push(format!(
            "folders truncated at {} of {} declared",
            info.folders.len(),
            info.declared_folders
        ));
    }
    if info.declared_files > info.files.len() {
        warnings.push(format!(
            "file entries truncated at {} of {} declared",
            info.files.len(),
            info.declared_files
        ));
        truncated = true;
    }

    let mut files = Vec::new();
    for (index, file) in info.files.iter().enumerate() {
        if index >= max_files {
            truncated = true;
            warnings.push(format!(
                "files truncated at {max_files} of {} parsed",
                info.files.len()
            ));
            break;
        }
        let (compression, spans) = match file.folder_index {
            FOLDER_CONTINUED_FROM_PREV => (json!("continued-from-previous"), "fromPrevious"),
            FOLDER_CONTINUED_TO_NEXT => (json!("continues-in-next"), "toNext"),
            index if (index as usize) < info.folders.len() => (
                json!(compression_json(info.folders[index as usize].compression_bits)["scheme"]),
                "",
            ),
            _ => (json!("invalid-index"), "invalidIndex"),
        };
        files.push(json!({
            "name": clean(&file.name),
            "size": file.size,
            "folderIndex": file.folder_index,
            "folderOffset": file.folder_offset,
            "compression": compression,
            "spansCabinet": if spans.is_empty() { Value::Null } else { json!(spans) },
            "dateTime": file
                .datetime_json()
                .unwrap_or(Value::Null),
            "attributes": attribute_names(file.attribs),
            "isExec": file.attribs & 0x40 != 0,
            "nameIsUtf": file.utf8_name,
        }));
    }

    let report = json!({
        "schema_version": 1,
        "format": "cabinet",
        "version": format!("{}.{}", info.version_major, info.version_minor),
        "totalSize": info.total_size,
        "inputSize": bytes.len(),
        "filesOffset": info.files_offset,
        "flags": format!("0x{:04x}", info.flags),
        "prevCabinetPresent": info.flags & 0x1 != 0,
        "nextCabinetPresent": info.flags & 0x2 != 0,
        "reservePresent": info.flags & 0x4 != 0,
        "prevCabinet": info
            .prev_cabinet
            .as_ref()
            .map(|(name, disk)| json!({ "name": clean(name), "disk": clean(disk) }))
            .unwrap_or(Value::Null),
        "nextCabinet": info
            .next_cabinet
            .as_ref()
            .map(|(name, disk)| json!({ "name": clean(name), "disk": clean(disk) }))
            .unwrap_or(Value::Null),
        "setId": info.set_id,
        "setIndex": info.set_index,
        "nonZeroReservedFields": info.nonzero_reserved,
        "headerReserveHex": if info.reserve_data.is_empty() {
            Value::Null
        } else {
            json!(hex(&info.reserve_data))
        },
        "dataReserveSize": info.data_reserve_size,
        "folders": folders,
        "folderCount": folder_count,
        "declaredFolderCount": info.declared_folders,
        "files": files,
        "fileCount": info.files.len(),
        "declaredFileCount": info.declared_files,
        "parsedBytes": info.parsed_end,
        "warnings": warnings,
        "truncated": truncated,
    });
    finish_json(report)
}

impl CabFile {
    fn datetime_json(&self) -> Option<Value> {
        dos_datetime(self.date, self.time).map(Value::from)
    }
}

/// Bounded read of a `Read` into a Vec, stopping at `limit + 1` bytes.
/// Returns `(bytes_capped_to_limit, overflowed)`.
fn read_bounded<R: Read>(
    mut reader: R,
    limit: usize,
    size_hint: usize,
) -> Result<(Vec<u8>, bool), String> {
    let mut out = Vec::with_capacity(size_hint.min(limit).min(4 * 1024 * 1024));
    let mut chunk = [0u8; 64 * 1024];
    let mut overflowed = false;
    loop {
        if out.len() > limit {
            overflowed = true;
            out.truncate(limit);
            break;
        }
        let want = (limit + 1 - out.len()).min(chunk.len());
        let read = reader
            .read(&mut chunk[..want])
            .map_err(|error| {
                error_json(
                    "decompress_failed",
                    json!({ "detail": clean(&error.to_string()) }),
                )
            })?;
        if read == 0 {
            break;
        }
        out.extend_from_slice(&chunk[..read]);
    }
    Ok((out, overflowed))
}

pub(crate) fn extract_impl(bytes: &[u8], options_json: &str) -> Result<String, String> {
    check_input(bytes)?;
    let options = parse_options(options_json)?;
    let name = option_string(&options, "file")?
        .ok_or_else(|| {
            error_json("invalid_options", json!({ "detail": "missing required option: file" }))
        })?;
    let max_bytes = option_u64(&options, "maxBytes")?
        .map(|value| value.clamp(1, MAX_CONTENT_BYTES as u64));

    // Hand-rolled pre-parse for richer, more precise errors than the crate
    // surfaces (spanning markers, unsupported compression, declared size).
    let info = match catch_unwind(AssertUnwindSafe(|| parse_cabinet(bytes))) {
        Ok(result) => result?,
        Err(_) => {
            return Err(error_json(
                "internal",
                json!({ "detail": "panic during cabinet parse" }),
            ))
        }
    };

    let file = info
        .files
        .iter()
        .find(|file| file.name == name)
        .ok_or_else(|| {
            error_json(
                "file_not_found",
                json!({ "file": clean(&name) }),
            )
        })?;

    let declared = file.size as u64;
    if declared > MAX_EXTRACT_BYTES as u64 {
        return Err(error_json(
            "entry_too_large",
            json!({ "file": clean(&name), "declaredSize": declared, "limit": MAX_EXTRACT_BYTES }),
        ));
    }
    match file.folder_index {
        FOLDER_CONTINUED_FROM_PREV => {
            return Err(error_json(
                "file_continued_from_previous",
                json!({ "file": clean(&name), "detail": "file data begins in a previous cabinet of the set" }),
            ))
        }
        FOLDER_CONTINUED_TO_NEXT => {
            return Err(error_json(
                "file_continues_in_next",
                json!({ "file": clean(&name), "detail": "file data continues into a following cabinet of the set" }),
            ))
        }
        index if (index as usize) >= info.folders.len() => {
            return Err(error_json(
                "invalid_cabinet",
                json!({ "detail": format!("file {name:?} references folder {index} but only {} folders exist", info.folders.len()) }),
            ))
        }
        index => {
            let bits = info.folders[index as usize].compression_bits;
            if !compression_supported(bits) {
                let scheme = compression_json(bits)["scheme"].clone();
                return Err(error_json(
                    "unsupported_compression",
                    json!({ "file": clean(&name), "compression": scheme, "compressionBits": format!("0x{bits:04x}") }),
                ));
            }
        }
    }

    // Any continuation-marked sibling makes the crate-level open fail; report
    // that explicitly rather than as a generic invalid_cabinet. Only checked
    // when the pre-parse is complete — if header lists were truncated the
    // crate still parses fully on its own.
    let parse_complete = info.declared_folders == info.folders.len()
        && info.declared_files == info.files.len();
    if parse_complete
        && info
            .files
            .iter()
            .any(|f| f.folder_index >= info.folders.len() as u16)
    {
        return Err(error_json(
            "unsupported_cabinet",
            json!({ "detail": "cabinet contains entries spanning cabinet boundaries; extraction of set members is not supported" }),
        ));
    }

    // Bounds before allocation: the member's declared size must fit the JSON
    // transport budget unless a preview cap was requested. A preview still
    // never returns more than `maxBytes` bytes.
    let limit = match max_bytes {
        Some(max) => max as usize,
        None => {
            if declared > MAX_CONTENT_BYTES as u64 {
                return Err(error_json(
                    "entry_too_large",
                    json!({
                        "file": clean(&name),
                        "declaredSize": declared,
                        "limit": MAX_CONTENT_BYTES,
                        "detail": format!("member exceeds the JSON transport budget; request a bounded preview with maxBytes (hard member cap is {MAX_EXTRACT_BYTES} bytes)"),
                    }),
                ));
            }
            MAX_CONTENT_BYTES
        }
    };
    let compression = compression_json(
        info.folders[file.folder_index as usize].compression_bits,
    )["scheme"]
        .clone();

    // `FileReader<'_>` borrows the Cabinet, so open + decompress + bounded
    // read all run inside one catch_unwind that returns owned bytes.
    let file_size = file.size as usize;
    let outcome = catch_unwind(AssertUnwindSafe(|| -> Result<(Vec<u8>, bool), String> {
        let mut cabinet =
            ::cab::Cabinet::new(Cursor::new(bytes)).map_err(|error| {
                error_json(
                    "invalid_cabinet",
                    json!({ "detail": clean(&error.to_string()) }),
                )
            })?;
        let reader = cabinet.read_file(&name).map_err(|error| {
            let detail = clean(&error.to_string());
            let code = if detail.contains("not yet supported")
                || detail.contains("compression")
            {
                "unsupported_compression"
            } else if error.kind() == std::io::ErrorKind::NotFound {
                "file_not_found"
            } else {
                "decompress_failed"
            };
            error_json(code, json!({ "file": clean(&name), "detail": detail }))
        })?;
        read_bounded(reader, limit, file_size)
    }));
    let (data, overflowed) = match outcome {
        Ok(Ok(pair)) => pair,
        Ok(Err(error)) => return Err(error),
        Err(_) => {
            return Err(error_json(
                "internal",
                json!({ "detail": "panic during cabinet decompression" }),
            ))
        }
    };
    if overflowed && max_bytes.is_none() {
        // Declared size fit, but the stream produced more: fail closed.
        return Err(error_json(
            "entry_too_large",
            json!({ "file": clean(&name), "declaredSize": declared, "limit": limit }),
        ));
    }
    let truncated = overflowed || declared > data.len() as u64;
    finish_json(json!({
        "schema_version": 1,
        "file": clean(&name),
        "compression": compression,
        "size": data.len(),
        "declaredSize": declared,
        "sha256": sha256_hex(&data),
        "contentBase64": data_encoding::BASE64.encode(&data),
        "truncated": truncated,
    }))
}
