//! Bounded offline parser for Windows minidump and Breakpad crash dumps.
//!
//! Wraps the `minidump` crate (rust-minidump, MIT) behind deterministic
//! wasm-bindgen entry points that accept the dump bytes plus a small JSON
//! options document and return bounded JSON. Parsing is read-only: no
//! filesystem, network, environment, clock, subprocess, or
//! analyzed-code-execution capability is exposed.
//!
//! Hard limits (enforced before allocation/serialization):
//!   input bytes        32 MiB
//!   options JSON        4 KiB
//!   JSON output         4 MiB
//!   stream directory  4,096 entries (pre-parse)
//!   list items        4,096
//!   stream preview     64 KiB (base64)
//!   memory read        64 KiB
//!
//! Safety note for wasm32: `minidump` 0.27.0 reads length-prefixed UTF-16
//! strings via `read_string_utf16`, which checks `offset + size > len` in
//! `usize` arithmetic. On 32-bit `usize` that addition can wrap, bypass the
//! check, and panic on the subsequent slice index. `prepare_dump` therefore
//! locates every RVA field that feeds that reader (system info CSD string,
//! module names, unloaded module names, thread names, macOS boot args) before
//! the crate sees the data and rewrites a hostile value to a provably-safe
//! RVA of zero in a patched copy. `MinidumpHandleDataStream` is decoded by
//! this wrapper instead of the crate because its `next_info_rva` linked list
//! has no cycle bound; the manual decoder caps chain walks.

use std::borrow::Cow;
use std::ops::Deref;

use minidump::format as md;
use minidump::{
    CodeView, Minidump, MinidumpAnnotation, MinidumpAssertion, MinidumpBreakpadInfo,
    MinidumpContext, MinidumpCrashpadInfo, MinidumpException, MinidumpLinuxCpuInfo,
    MinidumpLinuxEnviron, MinidumpLinuxLsbRelease, MinidumpLinuxMaps, MinidumpLinuxProcLimits,
    MinidumpLinuxProcStatus, MinidumpMacBootargs, MinidumpMacCrashInfo, MinidumpMemory64List,
    MinidumpMemoryInfoList, MinidumpMemoryList, MinidumpMiscInfo, MinidumpModuleList,
    MinidumpSoftErrors, MinidumpSystemInfo, MinidumpThreadInfoList, MinidumpThreadList,
    MinidumpThreadNames, MinidumpUnloadedModuleList, Module, RawMacCrashInfo, RawMiscInfo,
    StabilityReport, UnifiedMemory, UnifiedMemoryInfo, UnifiedMemoryInfoList, UnifiedMemoryList,
};
use num_traits::FromPrimitive;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use wasm_bindgen::prelude::*;

const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_OPTIONS_BYTES: usize = 4 * 1024;
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_LIST_ITEMS: usize = 4096;
const MAX_STREAMS: u64 = 4096;
const MAX_STREAM_PREVIEW: usize = 64 * 1024;
const MAX_MEMORY_READ: u64 = 64 * 1024;
const MAX_REGISTERS: usize = 64;
const MAX_ANNOTATIONS: usize = 512;
const MAX_STRING_CHARS: usize = 4096;
const MAX_HANDLE_CHAIN: usize = 64;
/// RVA above which a UTF-16 string read can wrap a 32-bit `usize` bound check.
const USIZE32_WRAP: u64 = 1 << 32;

const MINIDUMP_VERSION: u32 = 0xa793;
const MINIDUMP_SIGNATURE: u32 = 0x504d_444d; // "MDMP"
const HEADER_SIZE: u64 = 32;
const DIR_ENTRY_SIZE: u64 = 12;

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/// Error documents follow the repository convention:
/// `{"schema_version":1,"error":"<code>"}` plus optional details.
fn error_json(code: &str, message: &str) -> String {
    let mut obj = Map::new();
    obj.insert("schema_version".into(), Value::from(1));
    obj.insert("error".into(), Value::from(code));
    obj.insert("message".into(), Value::from(cap_str(message)));
    Value::Object(obj).to_string()
}

fn finish(value: Value) -> String {
    match serde_json::to_string(&value) {
        Ok(text) if text.len() <= MAX_OUTPUT_BYTES => text,
        Ok(_) => error_json("output_too_large", "serialized output exceeds 4 MiB limit"),
        Err(error) => error_json("serialize_failed", &error.to_string()),
    }
}

fn check_limits(bytes: &[u8], options_json: &str) -> Option<String> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Some(error_json("input_too_large", "input exceeds 32 MiB limit"));
    }
    if options_json.len() > MAX_OPTIONS_BYTES {
        return Some(error_json(
            "options_too_large",
            "options exceed 4 KiB limit",
        ));
    }
    None
}

fn parse_options<T: for<'de> Deserialize<'de> + Default>(
    options_json: &str,
) -> Result<T, String> {
    if options_json.trim().is_empty() {
        return Ok(T::default());
    }
    serde_json::from_str(options_json)
        .map_err(|error| error_json("options_invalid", &error.to_string()))
}

fn cap_str(value: &str) -> String {
    value.chars().take(MAX_STRING_CHARS).collect()
}

fn cap_cow(value: Cow<'_, str>) -> String {
    cap_str(&value)
}

fn hex64(value: u64) -> String {
    format!("0x{value:x}")
}

fn hex32(value: u32) -> String {
    format!("0x{value:x}")
}

fn map_read_error(error: &minidump::Error) -> String {
    error_json("parse_failed", error.name())
}

/// Data handed to `Minidump::read`: either the caller's slice or a patched
/// copy when hostile string RVAs had to be neutralized.
enum DumpData<'a> {
    Ref(&'a [u8]),
    Owned(Vec<u8>),
}

impl Deref for DumpData<'_> {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        match self {
            DumpData::Ref(bytes) => bytes,
            DumpData::Owned(bytes) => bytes,
        }
    }
}

struct Prepared<'a> {
    data: DumpData<'a>,
    dirs: Vec<DirEntry>,
    patched_rvas: Vec<usize>,
    input_len: usize,
    little: bool,
}

#[derive(Clone)]
struct DirEntry {
    index: usize,
    stream_type: u32,
    data_size: u32,
    rva: u32,
}

// ---------------------------------------------------------------------------
// Header / directory / RVA sanitization
// ---------------------------------------------------------------------------

fn read_u32_at(bytes: &[u8], offset: u64, little: bool) -> Option<u32> {
    let offset = usize::try_from(offset).ok()?;
    let raw = bytes.get(offset..offset.checked_add(4)?)?;
    Some(if little {
        u32::from_le_bytes(raw.try_into().ok()?)
    } else {
        u32::from_be_bytes(raw.try_into().ok()?)
    })
}

fn read_u64_at(bytes: &[u8], offset: u64, little: bool) -> Option<u64> {
    let offset = usize::try_from(offset).ok()?;
    let raw = bytes.get(offset..offset.checked_add(8)?)?;
    Some(if little {
        u64::from_le_bytes(raw.try_into().ok()?)
    } else {
        u64::from_be_bytes(raw.try_into().ok()?)
    })
}

fn write_u32_at(bytes: &mut [u8], offset: usize, value: u32) {
    if let Some(slot) = bytes.get_mut(offset..offset.saturating_add(4)) {
        slot.copy_from_slice(&value.to_le_bytes());
    }
}

fn write_u64_at(bytes: &mut [u8], offset: usize, value: u64) {
    if let Some(slot) = bytes.get_mut(offset..offset.saturating_add(8)) {
        slot.copy_from_slice(&value.to_le_bytes());
    }
}

/// Would `read_string_utf16(offset, size)` panic on wasm32? The crate checks
/// `*offset + size > len` with 32-bit `usize` arithmetic: when the sum wraps,
/// the bound check is bypassed and slice indexing can panic. Detect exactly
/// that window with 64-bit math.
fn utf16_rva_is_unsafe(bytes_len: usize, rva: u64, size: u64) -> bool {
    let len = bytes_len as u64;
    if rva.checked_add(4).map_or(true, |end| end > len) {
        return false; // crate reads the u32 length first; OOB is a clean None
    }
    if size % 2 != 0 {
        return false;
    }
    match rva.checked_add(4).and_then(|v| v.checked_add(size)) {
        Some(end) => end >= USIZE32_WRAP,
        None => false,
    }
}

/// Check the string target of an RVA (u32) field; returns true when it is in
/// the panic window. `little` matches the dump endianness.
fn utf16_rva32_unsafe(bytes: &[u8], rva: u32, little: bool) -> bool {
    if u64::from(rva) + 4 > bytes.len() as u64 {
        return false;
    }
    match read_u32_at(bytes, u64::from(rva), little) {
        Some(size) => utf16_rva_is_unsafe(bytes.len(), u64::from(rva), u64::from(size)),
        None => false,
    }
}

/// Same for an RVA64 field. The crate truncates the address to `usize`, so the
/// effective target on wasm32 is the low 32 bits; flag anything that cannot be
/// represented in 32 bits or whose truncated target is unsafe.
fn utf16_rva64_unsafe(bytes: &[u8], rva: u64, little: bool) -> bool {
    if rva > u64::from(u32::MAX) {
        return true;
    }
    utf16_rva32_unsafe(bytes, rva as u32, little)
}

fn check_rva32_field(
    bytes: &[u8],
    field_offset: u64,
    little: bool,
    hostile: &mut Vec<(usize, bool)>,
) {
    if let Some(rva) = read_u32_at(bytes, field_offset, little) {
        if rva != 0 && utf16_rva32_unsafe(bytes, rva, little) {
            if let Ok(offset) = usize::try_from(field_offset) {
                hostile.push((offset, false));
            }
        }
    }
}

fn check_rva64_field(
    bytes: &[u8],
    field_offset: u64,
    little: bool,
    hostile: &mut Vec<(usize, bool)>,
) {
    if let Some(rva) = read_u64_at(bytes, field_offset, little) {
        if rva != 0 && utf16_rva64_unsafe(bytes, rva, little) {
            if let Ok(offset) = usize::try_from(field_offset) {
                hostile.push((offset, true));
            }
        }
    }
}

/// Parse the minidump header and stream directory, and locate every RVA field
/// that reaches `read_string_utf16` in the crate. If any such field targets a
/// string whose declared size lands in the 32-bit wrap window, return a patched
/// copy of the input with those RVA fields zeroed (an RVA of 0 always resolves
/// to `None` cleanly: the leading `MDMP` signature decodes to an odd length in
/// little-endian dumps and to an out-of-bounds length in big-endian dumps).
fn prepare_dump(bytes: &[u8]) -> Result<Prepared<'_>, String> {
    let empty = Prepared {
        data: DumpData::Ref(bytes),
        dirs: Vec::new(),
        patched_rvas: Vec::new(),
        input_len: bytes.len(),
        little: true,
    };
    if bytes.len() < HEADER_SIZE as usize {
        return Ok(empty); // crate reports MissingHeader
    }
    let little = match read_u32_at(bytes, 0, true) {
        Some(sig) if sig == MINIDUMP_SIGNATURE => true,
        _ => match read_u32_at(bytes, 0, false) {
            Some(sig) if sig == MINIDUMP_SIGNATURE => false,
            _ => return Ok(empty), // crate reports HeaderMismatch
        },
    };
    let version = read_u32_at(bytes, 4, little).unwrap_or(0);
    if version & 0xffff != MINIDUMP_VERSION {
        return Ok(empty); // crate reports VersionMismatch
    }
    let stream_count = u64::from(read_u32_at(bytes, 8, little).unwrap_or(0));
    let dir_rva = u64::from(read_u32_at(bytes, 12, little).unwrap_or(0));
    if stream_count > MAX_STREAMS {
        return Err(error_json(
            "too_many_streams",
            "stream directory count exceeds limit",
        ));
    }
    if dir_rva
        .checked_add(stream_count.checked_mul(DIR_ENTRY_SIZE).unwrap_or(u64::MAX))
        .map_or(true, |end| end > bytes.len() as u64)
    {
        return Ok(empty); // crate reports MissingDirectory
    }

    let mut dirs = Vec::with_capacity(stream_count as usize);
    for i in 0..stream_count {
        let base = dir_rva + i * DIR_ENTRY_SIZE;
        let (Some(stream_type), Some(data_size), Some(rva)) = (
            read_u32_at(bytes, base, little),
            read_u32_at(bytes, base + 4, little),
            read_u32_at(bytes, base + 8, little),
        ) else {
            return Ok(empty);
        };
        dirs.push(DirEntry {
            index: i as usize,
            stream_type,
            data_size,
            rva,
        });
    }

    // Collect (file offset of the RVA field, is_u64) pairs that need zeroing.
    let mut hostile: Vec<(usize, bool)> = Vec::new();

    let stream_slice = |dir: &DirEntry| -> Option<(u64, u64)> {
        let start = u64::from(dir.rva);
        let size = u64::from(dir.data_size);
        if start.checked_add(size)? > bytes.len() as u64 {
            return None;
        }
        Some((start, size))
    };

    for dir in &dirs {
        let Some((start, size)) = stream_slice(dir) else {
            continue;
        };
        match dir.stream_type {
            // SystemInfoStream: csd_version_rva is a u32 at offset 24.
            t if t == md::MINIDUMP_STREAM_TYPE::SystemInfoStream as u32 => {
                if size >= 28 {
                    check_rva32_field(bytes, start + 24, little, &mut hostile);
                }
            }
            // ModuleListStream: u32 count then count * 108-byte
            // MINIDUMP_MODULE entries; module_name_rva at +20.
            t if t == md::MINIDUMP_STREAM_TYPE::ModuleListStream as u32 => {
                sanitize_list_names(bytes, start, size, little, 108, 20, false, &mut hostile);
            }
            // UnloadedModuleListStream: EX header then 24-byte
            // MINIDUMP_UNLOADED_MODULE entries; module_name_rva at +20.
            t if t == md::MINIDUMP_STREAM_TYPE::UnloadedModuleListStream as u32 => {
                if let (Some(soh), Some(soe), Some(noe)) = (
                    read_u32_at(bytes, start, little),
                    read_u32_at(bytes, start + 4, little),
                    read_u32_at(bytes, start + 8, little),
                ) {
                    let first = start + u64::from(soh);
                    let total = u64::from(noe).saturating_mul(24);
                    if soe == 24 && first + total <= start + size {
                        for i in 0..u64::from(noe) {
                            check_rva32_field(
                                bytes,
                                first + i * 24 + 20,
                                little,
                                &mut hostile,
                            );
                        }
                    }
                }
            }
            // ThreadNamesStream: u32 count then count * 12-byte
            // MINIDUMP_THREAD_NAME entries; thread_name_rva (RVA64) at +4.
            t if t == md::MINIDUMP_STREAM_TYPE::ThreadNamesStream as u32 => {
                sanitize_list_names(bytes, start, size, little, 12, 4, true, &mut hostile);
            }
            // MozMacosBootargsStream: stream_type u32 then bootargs RVA64.
            t if t == md::MINIDUMP_STREAM_TYPE::MozMacosBootargsStream as u32 => {
                if size >= 12 {
                    check_rva64_field(bytes, start + 4, little, &mut hostile);
                }
            }
            _ => {}
        }
    }

    if hostile.is_empty() {
        return Ok(Prepared {
            data: DumpData::Ref(bytes),
            dirs,
            patched_rvas: Vec::new(),
            input_len: bytes.len(),
            little,
        });
    }
    let mut patched = bytes.to_vec();
    for (offset, is_u64) in &hostile {
        if *is_u64 {
            write_u64_at(&mut patched, *offset, 0);
        } else {
            write_u32_at(&mut patched, *offset, 0);
        }
    }
    Ok(Prepared {
        data: DumpData::Owned(patched),
        dirs,
        patched_rvas: hostile.iter().map(|(offset, _)| *offset).collect(),
        input_len: bytes.len(),
        little,
    })
}

/// Walk a `u32 count + entry[]` list stream and check the UTF-16 string RVA
/// field inside each entry. The crate tolerates 4 bytes of padding between the
/// count and the array; mirror that here.
fn sanitize_list_names(
    bytes: &[u8],
    start: u64,
    size: u64,
    little: bool,
    entry_size: u64,
    field_off: u64,
    is_u64: bool,
    hostile: &mut Vec<(usize, bool)>,
) {
    let Some(count) = read_u32_at(bytes, start, little) else {
        return;
    };
    let count = u64::from(count);
    let need = 4 + count.saturating_mul(entry_size);
    let first = if need == size {
        start + 4
    } else if need + 4 == size {
        start + 8
    } else {
        return; // crate reports StreamSizeMismatch
    };
    for i in 0..count {
        let field = first + i * entry_size + field_off;
        if is_u64 {
            check_rva64_field(bytes, field, little, hostile);
        } else {
            check_rva32_field(bytes, field, little, hostile);
        }
    }
}

// ---------------------------------------------------------------------------
// wasm-bindgen operations
// ---------------------------------------------------------------------------

/// Inspect a minidump: header, stream directory, system info, exception,
/// threads, modules, memory regions, misc info, and Breakpad/Crashpad
/// annotations.
#[wasm_bindgen]
pub fn minidump_inspect(bytes: &[u8], options_json: &str) -> String {
    if let Some(error) = check_limits(bytes, options_json) {
        return error;
    }
    let options: CommonOptions = match parse_options(options_json) {
        Ok(options) => options,
        Err(error) => return error,
    };
    with_dump(bytes, |dump, prepared| {
        finish(inspect_dump(dump, prepared, &options))
    })
}

/// Decode one selected stream to JSON when the stream type has a typed
/// decoder, otherwise return a bounded base64 preview of the stream bytes.
///
/// Options: `{"stream": <u32 | "0x.." | "Name">, "name": "<StreamName>",
/// "previewBytes": <usize>}`
#[wasm_bindgen]
pub fn minidump_stream(bytes: &[u8], options_json: &str) -> String {
    if let Some(error) = check_limits(bytes, options_json) {
        return error;
    }
    let options: StreamOptions = match parse_options(options_json) {
        Ok(options) => options,
        Err(error) => return error,
    };
    let stream_type = match resolve_stream_type(&options) {
        Ok(stream_type) => stream_type,
        Err(error) => return error,
    };
    with_dump(bytes, |dump, prepared| {
        finish(stream_dump(dump, prepared, stream_type, &options, bytes))
    })
}

/// Bounded read of a virtual address range through the dump's memory regions.
///
/// Options: `{"address": <u64 | "0x..">, "length": <u64 | "0x..">}`
/// where `0 < length <= 65536`.
#[wasm_bindgen]
pub fn minidump_memory_read(bytes: &[u8], options_json: &str) -> String {
    if let Some(error) = check_limits(bytes, options_json) {
        return error;
    }
    let options: MemoryOptions = match parse_options(options_json) {
        Ok(options) => options,
        Err(error) => return error,
    };
    let (address, length) = match resolve_memory_options(&options) {
        Ok(pair) => pair,
        Err(error) => return error,
    };
    with_dump(bytes, |dump, _prepared| {
        finish(memory_read(dump, address, length))
    })
}

/// Module list with symbol identifiers (CodeView/PDB records, ELF build IDs,
/// debug identifiers) for matching against debug-symbols tool output.
#[wasm_bindgen]
pub fn minidump_modules(bytes: &[u8], options_json: &str) -> String {
    if let Some(error) = check_limits(bytes, options_json) {
        return error;
    }
    let options: CommonOptions = match parse_options(options_json) {
        Ok(options) => options,
        Err(error) => return error,
    };
    with_dump(bytes, |dump, _prepared| finish(modules_dump(dump, &options)))
}

// ---------------------------------------------------------------------------
// Dump loading
// ---------------------------------------------------------------------------

fn with_dump(
    bytes: &[u8],
    f: impl FnOnce(&Minidump<'_, DumpData<'_>>, &Prepared<'_>) -> String,
) -> String {
    let prepared = match prepare_dump(bytes) {
        Ok(prepared) => prepared,
        Err(error) => return error,
    };
    let dump = match Minidump::read(prepared.data) {
        Ok(dump) => dump,
        Err(error) => return map_read_error(&error),
    };
    // `prepared.data` moved into `dump`; the directory listing, patch
    // bookkeeping, input length, and endianness remain available.
    let prepared = Prepared {
        data: DumpData::Ref(&[]),
        dirs: prepared.dirs,
        patched_rvas: prepared.patched_rvas,
        input_len: prepared.input_len,
        little: prepared.little,
    };
    f(&dump, &prepared)
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
#[serde(default)]
struct CommonOptions {
    limit: Option<usize>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct StreamOptions {
    stream: Option<Value>,
    name: Option<String>,
    preview_bytes: Option<usize>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct MemoryOptions {
    address: Option<Value>,
    length: Option<Value>,
}

fn value_to_u64(value: &Value) -> Option<u64> {
    match value {
        Value::Number(n) => n.as_u64().or_else(|| {
            n.as_f64().and_then(|f| {
                (f >= 0.0 && f.fract() == 0.0 && f <= 9_007_199_254_740_992.0)
                    .then(|| f as u64)
            })
        }),
        Value::String(s) => {
            let s = s.trim();
            if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
                u64::from_str_radix(hex, 16).ok()
            } else {
                s.parse::<u64>().ok()
            }
        }
        _ => None,
    }
}

fn resolve_memory_options(options: &MemoryOptions) -> Result<(u64, u64), String> {
    let address = options
        .address
        .as_ref()
        .and_then(value_to_u64)
        .ok_or_else(|| {
            error_json(
                "invalid_address",
                "options.address must be a u64 or 0x-prefixed string",
            )
        })?;
    let length = options
        .length
        .as_ref()
        .and_then(value_to_u64)
        .ok_or_else(|| {
            error_json(
                "invalid_length",
                "options.length must be a u64 or 0x-prefixed string",
            )
        })?;
    if length == 0 {
        return Err(error_json("invalid_length", "options.length must be > 0"));
    }
    if length > MAX_MEMORY_READ {
        return Err(error_json(
            "invalid_length",
            "options.length exceeds 64 KiB limit",
        ));
    }
    Ok((address, length))
}

fn resolve_stream_type(options: &StreamOptions) -> Result<u32, String> {
    if let Some(value) = &options.stream {
        let resolved = match value {
            Value::Number(_) => value_to_u64(value).and_then(|v| u32::try_from(v).ok()),
            Value::String(s) => stream_type_by_name(s)
                .or_else(|| value_to_u64(value).and_then(|v| u32::try_from(v).ok())),
            _ => None,
        };
        return resolved.ok_or_else(|| {
            error_json(
                "invalid_stream",
                "options.stream must be a u32, 0x-hex string, or stream name",
            )
        });
    }
    if let Some(name) = &options.name {
        return stream_type_by_name(name).ok_or_else(|| {
            error_json("invalid_stream", "options.name is not a known stream type")
        });
    }
    Err(error_json(
        "missing_stream",
        "options.stream or options.name is required",
    ))
}

fn stream_type_by_name(name: &str) -> Option<u32> {
    let normalized = name.trim().to_ascii_lowercase().replace(['_', '-'], "");
    STREAM_NAMES
        .iter()
        .find(|(n, _)| {
            let bare = n.trim_end_matches("Stream").to_ascii_lowercase();
            n.eq_ignore_ascii_case(name.trim())
                || bare == normalized
                || n.to_ascii_lowercase() == normalized
        })
        .map(|(_, v)| *v)
}

const STREAM_NAMES: &[(&str, u32)] = &[
    ("UnusedStream", 0),
    ("ReservedStream0", 1),
    ("ReservedStream1", 2),
    ("ThreadListStream", 3),
    ("ModuleListStream", 4),
    ("MemoryListStream", 5),
    ("ExceptionStream", 6),
    ("SystemInfoStream", 7),
    ("ThreadExListStream", 8),
    ("Memory64ListStream", 9),
    ("CommentStreamA", 10),
    ("CommentStreamW", 11),
    ("HandleDataStream", 12),
    ("FunctionTable", 13),
    ("UnloadedModuleListStream", 14),
    ("MiscInfoStream", 15),
    ("MemoryInfoListStream", 16),
    ("ThreadInfoListStream", 17),
    ("HandleOperationListStream", 18),
    ("TokenStream", 19),
    ("JavaScriptDataStream", 20),
    ("SystemMemoryInfoStream", 21),
    ("ProcessVmCountersStream", 22),
    ("IptTraceStream", 23),
    ("ThreadNamesStream", 24),
    ("BreakpadInfoStream", 0x4767_0001),
    ("AssertionInfoStream", 0x4767_0002),
    ("LinuxCpuInfo", 0x4767_0003),
    ("LinuxProcStatus", 0x4767_0004),
    ("LinuxLsbRelease", 0x4767_0005),
    ("LinuxCmdLine", 0x4767_0006),
    ("LinuxEnviron", 0x4767_0007),
    ("LinuxAuxv", 0x4767_0008),
    ("LinuxMaps", 0x4767_0009),
    ("LinuxDsoDebug", 0x4767_000a),
    ("CrashpadInfoStream", 0x4350_0001),
    ("StabilityReportStream", 0x4b6b_0002),
    ("MozMacosCrashInfoStream", 0x4d7a_0001),
    ("MozMacosBootargsStream", 0x4d7a_0002),
    ("MozLinuxLimits", 0x4d7a_0003),
    ("MozSoftErrors", 0x4d7a_0004),
];

fn stream_type_name(stream_type: u32) -> String {
    md::MINIDUMP_STREAM_TYPE::from_u32(stream_type)
        .map(|value| format!("{value:?}"))
        .unwrap_or_else(|| "unknown".to_string())
}

fn stream_vendor(stream_type: u32) -> &'static str {
    if stream_type <= md::MINIDUMP_STREAM_TYPE::LastReservedStream as u32 {
        "official"
    } else {
        match stream_type & 0xffff_0000 {
            0x4767_0000 => "google_breakpad",
            0x4350_0000 => "crashpad",
            0x4d7a_0000 => "mozilla",
            0x4b6b_0000 => "chromium",
            _ => "unknown",
        }
    }
}

// ---------------------------------------------------------------------------
// Shared serialization helpers
// ---------------------------------------------------------------------------

fn cap_list<T>(items: impl IntoIterator<Item = T>, limit: usize) -> (Vec<T>, bool) {
    let limit = limit.min(MAX_LIST_ITEMS);
    let mut out = Vec::with_capacity(limit.min(256));
    let mut truncated = false;
    for item in items {
        if out.len() >= limit {
            truncated = true;
            break;
        }
        out.push(item);
    }
    (out, truncated)
}

fn effective_limit(limit: Option<usize>) -> usize {
    limit.unwrap_or(MAX_LIST_ITEMS).min(MAX_LIST_ITEMS)
}

/// Streams this wrapper can decode to structured JSON.
fn typed_stream_supported(stream_type: u32) -> bool {
    use md::MINIDUMP_STREAM_TYPE as S;
    matches!(
        md::MINIDUMP_STREAM_TYPE::from_u32(stream_type),
        Some(
            S::ThreadListStream
                | S::ModuleListStream
                | S::MemoryListStream
                | S::ExceptionStream
                | S::SystemInfoStream
                | S::Memory64ListStream
                | S::HandleDataStream
                | S::UnloadedModuleListStream
                | S::MiscInfoStream
                | S::MemoryInfoListStream
                | S::ThreadInfoListStream
                | S::ThreadNamesStream
                | S::BreakpadInfoStream
                | S::AssertionInfoStream
                | S::LinuxCpuInfo
                | S::LinuxProcStatus
                | S::LinuxLsbRelease
                | S::LinuxEnviron
                | S::LinuxMaps
                | S::CrashpadInfoStream
                | S::StabilityReportStream
                | S::MozMacosCrashInfoStream
                | S::MozMacosBootargsStream
                | S::MozLinuxLimits
                | S::MozSoftErrors
        )
    )
}

fn header_json(header: &md::MINIDUMP_HEADER) -> Value {
    json!({
        "signature": hex32(header.signature),
        "version": hex32(header.version),
        "stream_count": header.stream_count,
        "stream_directory_rva": header.stream_directory_rva,
        "checksum": hex32(header.checksum),
        "time_date_stamp": header.time_date_stamp,
        "flags": hex64(header.flags),
    })
}

fn streams_json(dirs: &[DirEntry], input_len: usize, limit: usize) -> Value {
    let input_len = input_len as u64;
    let (items, truncated) = cap_list(
        dirs.iter().map(|dir| {
            let in_bounds = u64::from(dir.rva)
                .checked_add(u64::from(dir.data_size))
                .map_or(false, |end| end <= input_len);
            json!({
                "index": dir.index,
                "type": dir.stream_type,
                "name": stream_type_name(dir.stream_type),
                "vendor": stream_vendor(dir.stream_type),
                "data_size": dir.data_size,
                "rva": dir.rva,
                "in_bounds": in_bounds,
                "typed_decode": typed_stream_supported(dir.stream_type),
            })
        }),
        limit,
    );
    json!({
        "count": dirs.len(),
        "items": items,
        "truncated": truncated,
    })
}

fn system_info_json(info: &MinidumpSystemInfo) -> Value {
    let (os_version, os_build) = info.os_parts();
    json!({
        "os": info.os.to_string(),
        "os_long_name": info.os.long_name().into_owned(),
        "cpu": info.cpu.to_string(),
        "processor_architecture": hex64(u64::from(info.raw.processor_architecture)),
        "processor_level": info.raw.processor_level,
        "processor_revision": hex64(u64::from(info.raw.processor_revision)),
        "number_of_processors": info.raw.number_of_processors,
        "product_type": info.raw.product_type,
        "platform_id": hex64(u64::from(info.raw.platform_id)),
        "version": format!(
            "{}.{}.{}",
            info.raw.major_version, info.raw.minor_version, info.raw.build_number
        ),
        "os_version": os_version,
        "os_build": os_build,
        "csd_version": info.csd_version().map(cap_cow),
        "cpu_info": info.cpu_info().map(cap_cow),
        "suite_mask": hex64(u64::from(info.raw.suite_mask)),
    })
}

fn context_json(context: &MinidumpContext) -> Value {
    let validity = match context.valid {
        minidump::MinidumpContextValidity::All => "all",
        minidump::MinidumpContextValidity::Some(_) => "partial",
    };
    let mut registers = Map::new();
    for (index, (name, value)) in context.valid_registers().enumerate() {
        if index >= MAX_REGISTERS {
            break;
        }
        registers.insert(name.to_string(), Value::from(hex64(value)));
    }
    json!({
        "validity": validity,
        "instruction_pointer": hex64(context.get_instruction_pointer()),
        "stack_pointer": hex64(context.get_stack_pointer()),
        "registers": Value::Object(registers),
    })
}

fn exception_json(
    exception: &MinidumpException<'_>,
    sysinfo: Option<&MinidumpSystemInfo>,
    misc: Option<&MinidumpMiscInfo>,
) -> Value {
    let record = &exception.raw.exception_record;
    let parameters: Vec<Value> = record
        .exception_information
        .iter()
        .take(record.number_parameters.min(15) as usize)
        .map(|value| Value::from(hex64(*value)))
        .collect();
    let (reason, crash_address) = match sysinfo {
        Some(info) => (
            Value::from(cap_str(
                &exception.get_crash_reason(info.os, info.cpu).to_string(),
            )),
            Value::from(hex64(exception.get_crash_address(info.os, info.cpu))),
        ),
        None => (Value::Null, Value::Null),
    };
    let context = sysinfo
        .and_then(|info| exception.context(info, misc))
        .map(|ctx| context_json(&ctx))
        .unwrap_or(Value::Null);
    json!({
        "thread_id": exception.thread_id,
        "exception_code": hex32(record.exception_code),
        "exception_flags": hex32(record.exception_flags),
        "exception_address": hex64(record.exception_address),
        "nested_exception_address": hex64(record.exception_record),
        "number_parameters": record.number_parameters,
        "parameters": parameters,
        "crash_reason": reason,
        "crash_address": crash_address,
        "context": context,
    })
}

fn thread_json(
    thread: &minidump::MinidumpThread<'_>,
    sysinfo: Option<&MinidumpSystemInfo>,
    misc: Option<&MinidumpMiscInfo>,
    names: Option<&MinidumpThreadNames>,
    memory: Option<&UnifiedMemoryList<'_>>,
) -> Value {
    let raw = &thread.raw;
    let context = sysinfo
        .and_then(|info| thread.context(info, misc))
        .map(|ctx| context_json(&ctx))
        .unwrap_or(Value::Null);
    let empty_memory = UnifiedMemoryList::default();
    let stack = thread
        .stack_memory(memory.unwrap_or(&empty_memory))
        .map(|region| {
            json!({
                "start": hex64(region.base_address()),
                "size": region.size(),
                "bytes_stored": region.bytes().len() as u64,
            })
        })
        .unwrap_or_else(|| {
            json!({
                "start": hex64(raw.stack.start_of_memory_range),
                "size": u64::from(raw.stack.memory.data_size),
                "bytes_stored": 0,
            })
        });
    json!({
        "thread_id": raw.thread_id,
        "name": names.and_then(|names| names.get_name(raw.thread_id).map(cap_cow)),
        "suspend_count": raw.suspend_count,
        "priority_class": hex32(raw.priority_class),
        "priority": raw.priority,
        "teb": hex64(raw.teb),
        "stack": stack,
        "context": context,
    })
}

fn module_json(module: &minidump::MinidumpModule) -> Value {
    let raw = &module.raw;
    let codeview = module.codeview_info.as_ref().map(|cv| match cv {
        CodeView::Pdb70(raw) => json!({
            "kind": "pdb70",
            "pdb_file": String::from_utf8_lossy(
                raw.pdb_file_name.split(|&b| b == 0).next().unwrap_or(&[])
            )
            .into_owned(),
            "signature": format!("{:#}", raw.signature),
            "age": raw.age,
        }),
        CodeView::Pdb20(raw) => json!({
            "kind": "pdb20",
            "pdb_file": String::from_utf8_lossy(
                raw.pdb_file_name.split(|&b| b == 0).next().unwrap_or(&[])
            )
            .into_owned(),
            "signature": hex32(raw.signature),
            "age": raw.age,
        }),
        CodeView::Elf(raw) => json!({
            "kind": "elf",
            "build_id": raw.build_id.iter().map(|b| format!("{b:02x}")).collect::<String>(),
        }),
        CodeView::Unknown(bytes) => json!({
            "kind": "unknown",
            "size": bytes.len(),
        }),
    });
    json!({
        "name": cap_str(&module.name),
        "code_file": cap_cow(module.code_file()),
        "base": hex64(module.base_address()),
        "size": module.size(),
        "version": module.version().map(cap_cow),
        "checksum": hex32(raw.checksum),
        "time_date_stamp": raw.time_date_stamp,
        "code_id": module.code_identifier().map(|id| id.as_str().to_string()),
        "debug_file": module.debug_file().map(cap_cow),
        "debug_id": module
            .debug_identifier()
            .map(|id| id.breakpad().to_string()),
        "codeview": codeview,
        "has_misc_record": raw.misc_record.data_size > 0,
    })
}

fn memory_info_json(info: UnifiedMemoryInfo<'_>) -> Value {
    match info {
        UnifiedMemoryInfo::Info(info) => {
            let range = info.memory_range();
            json!({
                "base": hex64(info.raw.base_address),
                "end": range.map(|r| hex64(r.end.saturating_add(1))),
                "size": info.raw.region_size,
                "allocation_base": hex64(info.raw.allocation_base),
                "allocation_protection": format!("{:?}", info.allocation_protection),
                "state": format!("{:?}", info.state),
                "protection": format!("{:?}", info.protection),
                "type": format!("{:?}", info.ty),
                "readable": info.is_readable(),
                "writable": info.is_writable(),
                "executable": info.is_executable(),
            })
        }
        UnifiedMemoryInfo::Map(map) => {
            let path = match &map.map.pathname {
                procfs_core::process::MMapPath::Path(path) => {
                    path.to_string_lossy().into_owned()
                }
                procfs_core::process::MMapPath::Heap => "[heap]".to_string(),
                procfs_core::process::MMapPath::Stack => "[stack]".to_string(),
                procfs_core::process::MMapPath::TStack(tid) => format!("[stack:{tid}]"),
                procfs_core::process::MMapPath::Vdso => "[vdso]".to_string(),
                procfs_core::process::MMapPath::Vvar => "[vvar]".to_string(),
                procfs_core::process::MMapPath::Vsyscall => "[vsyscall]".to_string(),
                procfs_core::process::MMapPath::Rollup => "[rollup]".to_string(),
                procfs_core::process::MMapPath::Anonymous => String::new(),
                procfs_core::process::MMapPath::Other(name) => format!("[{name}]"),
                procfs_core::process::MMapPath::Vsys(key) => format!("/SYSV{key:08x}"),
            };
            json!({
                "base": hex64(map.map.address.0),
                "end": hex64(map.map.address.1),
                "size": map.map.address.1.saturating_sub(map.map.address.0),
                "permissions": map.map.perms.as_str(),
                "offset": hex64(map.map.offset),
                "device": format!("{}:{}", map.map.dev.0, map.map.dev.1),
                "inode": map.map.inode,
                "path": cap_str(&path),
                "readable": map.is_readable(),
                "writable": map.is_writable(),
                "executable": map.is_executable(),
            })
        }
    }
}

fn utf16_units_to_string(units: &[u16]) -> Option<String> {
    let len = units.iter().take_while(|&&c| c != 0).count();
    String::from_utf16(&units[..len]).ok()
}

fn misc_info_json(info: &MinidumpMiscInfo) -> Value {
    let raw = &info.raw;
    let revision = match raw {
        RawMiscInfo::MiscInfo(_) => 1,
        RawMiscInfo::MiscInfo2(_) => 2,
        RawMiscInfo::MiscInfo3(_) => 3,
        RawMiscInfo::MiscInfo4(_) => 4,
        RawMiscInfo::MiscInfo5(_) => 5,
    };
    json!({
        "revision": revision,
        "size_of_info": raw.size_of_info().copied(),
        "flags1": raw.flags1().map(|v| hex32(*v)),
        "process_id": raw.process_id().copied(),
        "process_create_time": raw.process_create_time().copied(),
        "process_user_time": raw.process_user_time().copied(),
        "process_kernel_time": raw.process_kernel_time().copied(),
        "processor_max_mhz": raw.processor_max_mhz().copied(),
        "processor_current_mhz": raw.processor_current_mhz().copied(),
        "processor_mhz_limit": raw.processor_mhz_limit().copied(),
        "processor_max_idle_state": raw.processor_max_idle_state().copied(),
        "processor_current_idle_state": raw.processor_current_idle_state().copied(),
        "process_integrity_level": raw.process_integrity_level().copied(),
        "process_execute_flags": raw.process_execute_flags().map(|v| hex32(*v)),
        "protected_process": raw.protected_process().copied(),
        "time_zone_id": raw.time_zone_id().copied(),
        "build_string": raw
            .build_string()
            .and_then(|v| utf16_units_to_string(v))
            .map(|s| cap_str(&s)),
        "dbg_bld_str": raw
            .dbg_bld_str()
            .and_then(|v| utf16_units_to_string(v))
            .map(|s| cap_str(&s)),
        "process_cookie": raw.process_cookie().map(|v| hex32(*v)),
    })
}

fn crashpad_json(info: &MinidumpCrashpadInfo) -> Value {
    let mut simple = Map::new();
    for (index, (key, value)) in info.simple_annotations.iter().enumerate() {
        if index >= MAX_ANNOTATIONS {
            break;
        }
        simple.insert(cap_str(key), Value::from(cap_str(value)));
    }
    let (modules, modules_truncated) = cap_list(
        info.module_list.iter().map(|module| {
            let mut simple = Map::new();
            for (index, (key, value)) in module.simple_annotations.iter().enumerate() {
                if index >= MAX_ANNOTATIONS {
                    break;
                }
                simple.insert(cap_str(key), Value::from(cap_str(value)));
            }
            let mut objects = Map::new();
            for (index, (key, value)) in module.annotation_objects.iter().enumerate() {
                if index >= MAX_ANNOTATIONS {
                    break;
                }
                let rendered = match value {
                    MinidumpAnnotation::String(s) => Value::from(cap_str(s)),
                    MinidumpAnnotation::Invalid => Value::Null,
                    MinidumpAnnotation::UserDefined(raw)
                    | MinidumpAnnotation::Unsupported(raw) => {
                        json!({ "annotation_type": raw.ty })
                    }
                    _ => Value::Null,
                };
                objects.insert(cap_str(key), rendered);
            }
            json!({
                "module_index": module.module_index,
                "version": module.raw.version,
                "list_annotations": module
                    .list_annotations
                    .iter()
                    .take(MAX_ANNOTATIONS)
                    .map(|v| cap_str(v))
                    .collect::<Vec<_>>(),
                "simple_annotations": Value::Object(simple),
                "annotation_objects": Value::Object(objects),
            })
        }),
        MAX_LIST_ITEMS,
    );
    json!({
        "version": info.raw.version,
        "report_id": format!("{}", info.raw.report_id),
        "client_id": format!("{}", info.raw.client_id),
        "simple_annotations": Value::Object(simple),
        "modules": modules,
        "modules_truncated": modules_truncated,
    })
}

fn mac_crash_json(info: &MinidumpMacCrashInfo) -> Value {
    let (records, truncated) = cap_list(
        info.raw.iter().map(|record| {
            let record_version = match record {
                RawMacCrashInfo::V1(..) => 1,
                RawMacCrashInfo::V4(..) => 4,
                RawMacCrashInfo::V5(..) => 5,
            };
            json!({
                "record_version": record_version,
                "version": record.version().map(|v| hex64(*v)),
                "thread": record.thread().map(|v| hex64(*v)),
                "dialog_mode": record.dialog_mode().map(|v| hex64(*v)),
                "abort_cause": record.abort_cause().map(|v| hex64(*v)),
                "module_path": record.module_path().map(|v| cap_str(v)),
                "message": record.message().map(|v| cap_str(v)),
                "signature_string": record.signature_string().map(|v| cap_str(v)),
                "backtrace": record.backtrace().map(|v| cap_str(v)),
                "message2": record.message2().map(|v| cap_str(v)),
            })
        }),
        64,
    );
    json!({"records": records, "truncated": truncated})
}

fn linux_pairs<'a>(
    iter: impl Iterator<Item = (&'a minidump::strings::LinuxOsStr, &'a minidump::strings::LinuxOsStr)>,
) -> Value {
    let mut entries = Vec::new();
    let mut truncated = false;
    for (key, value) in iter {
        if entries.len() >= MAX_LIST_ITEMS {
            truncated = true;
            break;
        }
        entries.push(json!({
            "key": cap_str(&key.to_string_lossy()),
            "value": cap_str(&value.to_string_lossy()),
        }));
    }
    json!({"entries": entries, "truncated": truncated})
}

fn linux_lines<'a>(
    iter: impl Iterator<Item = &'a minidump::strings::LinuxOsStr>,
) -> Value {
    let mut lines = Vec::new();
    let mut truncated = false;
    for line in iter {
        if lines.len() >= MAX_LIST_ITEMS {
            truncated = true;
            break;
        }
        lines.push(Value::from(cap_str(&line.to_string_lossy())));
    }
    json!({"lines": lines, "truncated": truncated})
}

fn memory_info_list<'a>(
    dump: &'a Minidump<'a, DumpData<'a>>,
) -> Option<UnifiedMemoryInfoList<'a>> {
    if let Ok(info) = dump.get_stream::<MinidumpMemoryInfoList>() {
        return Some(UnifiedMemoryInfoList::Info(info));
    }
    if let Ok(maps) = dump.get_stream::<MinidumpLinuxMaps>() {
        return Some(UnifiedMemoryInfoList::Maps(maps));
    }
    None
}

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

fn inspect_dump(
    dump: &Minidump<'_, DumpData<'_>>,
    prepared: &Prepared<'_>,
    options: &CommonOptions,
) -> Value {
    let limit = effective_limit(options.limit);
    let mut warnings: Vec<String> = Vec::new();
    if !prepared.patched_rvas.is_empty() {
        warnings.push(format!(
            "neutralized {} out-of-bounds string RVA field(s)",
            prepared.patched_rvas.len()
        ));
    }

    let sysinfo = dump.get_stream::<MinidumpSystemInfo>().ok();
    let misc = dump.get_stream::<MinidumpMiscInfo>().ok();
    let thread_names = dump.get_stream::<MinidumpThreadNames>().ok();
    let memory = dump.get_memory();

    let threads_value = match dump.get_stream::<MinidumpThreadList>() {
        Ok(list) => {
            let count = list.threads.len();
            let (threads, truncated) = cap_list(
                list.threads.iter().map(|thread| {
                    thread_json(
                        thread,
                        sysinfo.as_ref(),
                        misc.as_ref(),
                        thread_names.as_ref(),
                        memory.as_ref(),
                    )
                }),
                limit,
            );
            json!({"count": count, "items": threads, "truncated": truncated})
        }
        Err(_) => Value::Null,
    };

    let modules_value = match dump.get_stream::<MinidumpModuleList>() {
        Ok(list) => {
            let count = list.iter().count();
            let (modules, truncated) = cap_list(list.iter().map(module_json), limit);
            json!({"count": count, "items": modules, "truncated": truncated})
        }
        Err(_) => Value::Null,
    };

    let unloaded_value = match dump.get_stream::<MinidumpUnloadedModuleList>() {
        Ok(list) => {
            let count = list.iter().count();
            let (modules, truncated) = cap_list(
                list.iter().map(|module| {
                    json!({
                        "name": cap_str(&module.name),
                        "base": hex64(module.raw.base_of_image),
                        "size": u64::from(module.raw.size_of_image),
                        "checksum": hex32(module.raw.checksum),
                        "time_date_stamp": module.raw.time_date_stamp,
                    })
                }),
                limit,
            );
            json!({"count": count, "items": modules, "truncated": truncated})
        }
        Err(_) => Value::Null,
    };

    let memory_regions = match &memory {
        Some(list) => {
            let count = list.iter().count();
            let (regions, truncated) = cap_list(
                list.iter().map(|region| {
                    json!({
                        "source": match region {
                            UnifiedMemory::Memory(_) => "memory_list",
                            UnifiedMemory::Memory64(_) => "memory64_list",
                        },
                        "base": hex64(region.base_address()),
                        "size": region.size(),
                        "bytes_stored": region.bytes().len() as u64,
                    })
                }),
                limit,
            );
            json!({"count": count, "items": regions, "truncated": truncated})
        }
        None => Value::Null,
    };

    let memory_info = match memory_info_list(dump) {
        Some(list) => {
            let (items, truncated) = cap_list(list.iter().map(memory_info_json), limit);
            json!({
                "kind": match list {
                    UnifiedMemoryInfoList::Info(_) => "memory_info_list",
                    UnifiedMemoryInfoList::Maps(_) => "linux_maps",
                },
                "items": items,
                "truncated": truncated,
            })
        }
        None => Value::Null,
    };

    let thread_infos_value = match dump.get_stream::<MinidumpThreadInfoList>() {
        Ok(list) => {
            let count = list.thread_infos.len();
            let (items, truncated) = cap_list(
                list.thread_infos.iter().map(|info| {
                    json!({
                        "thread_id": info.raw.thread_id,
                        "dump_flags": hex32(info.raw.dump_flags),
                        "dump_error": hex32(info.raw.dump_error),
                        "exit_status": hex32(info.raw.exit_status),
                        "create_time": info.raw.create_time,
                        "exit_time": info.raw.exit_time,
                        "kernel_time": info.raw.kernel_time,
                        "user_time": info.raw.user_time,
                        "start_address": hex64(info.raw.start_address),
                        "affinity": hex64(info.raw.affinity),
                    })
                }),
                limit,
            );
            json!({"count": count, "items": items, "truncated": truncated})
        }
        Err(_) => Value::Null,
    };

    let mut obj = Map::new();
    obj.insert("schema_version".into(), Value::from(1));
    obj.insert("valid".into(), Value::Bool(true));
    obj.insert(
        "endian".into(),
        Value::from(if prepared.little { "little" } else { "big" }),
    );
    obj.insert("header".into(), header_json(&dump.header));
    obj.insert(
        "streams".into(),
        streams_json(&prepared.dirs, prepared.input_len, limit),
    );
    obj.insert(
        "system_info".into(),
        sysinfo.as_ref().map(system_info_json).unwrap_or(Value::Null),
    );
    obj.insert(
        "exception".into(),
        match dump.get_stream::<MinidumpException>() {
            Ok(exception) => exception_json(&exception, sysinfo.as_ref(), misc.as_ref()),
            Err(_) => Value::Null,
        },
    );
    obj.insert("threads".into(), threads_value);
    obj.insert("thread_infos".into(), thread_infos_value);
    obj.insert("modules".into(), modules_value);
    obj.insert("unloaded_modules".into(), unloaded_value);
    obj.insert("memory_regions".into(), memory_regions);
    obj.insert("memory_info".into(), memory_info);
    obj.insert(
        "misc_info".into(),
        misc.as_ref().map(misc_info_json).unwrap_or(Value::Null),
    );
    obj.insert(
        "breakpad_info".into(),
        dump.get_stream::<MinidumpBreakpadInfo>()
            .map(|info| {
                json!({
                    "dump_thread_id": info.dump_thread_id,
                    "requesting_thread_id": info.requesting_thread_id,
                })
            })
            .unwrap_or(Value::Null),
    );
    obj.insert(
        "assertion".into(),
        dump.get_stream::<MinidumpAssertion>()
            .map(|assertion| {
                json!({
                    "expression": assertion.expression().map(|v| cap_str(&v)),
                    "function": assertion.function().map(|v| cap_str(&v)),
                    "file": assertion.file().map(|v| cap_str(&v)),
                    "line": assertion.raw.line,
                    "type": assertion.raw._type,
                })
            })
            .unwrap_or(Value::Null),
    );
    obj.insert(
        "crashpad_info".into(),
        dump.get_stream::<MinidumpCrashpadInfo>()
            .map(|info| crashpad_json(&info))
            .unwrap_or(Value::Null),
    );
    obj.insert(
        "mac_crash_info".into(),
        dump.get_stream::<MinidumpMacCrashInfo>()
            .map(|info| mac_crash_json(&info))
            .unwrap_or(Value::Null),
    );
    obj.insert(
        "mac_bootargs".into(),
        dump.get_stream::<MinidumpMacBootargs>()
            .ok()
            .and_then(|args| args.bootargs)
            .map(|args| Value::from(cap_str(&args)))
            .unwrap_or(Value::Null),
    );
    obj.insert(
        "soft_errors".into(),
        dump.get_stream::<MinidumpSoftErrors>()
            .ok()
            .map(|errors| Value::from(cap_str(errors.as_ref())))
            .unwrap_or(Value::Null),
    );
    obj.insert("warnings".into(), json!(warnings));
    Value::Object(obj)
}

// ---------------------------------------------------------------------------
// modules
// ---------------------------------------------------------------------------

fn modules_dump(dump: &Minidump<'_, DumpData<'_>>, options: &CommonOptions) -> Value {
    let limit = effective_limit(options.limit);
    match dump.get_stream::<MinidumpModuleList>() {
        Ok(list) => {
            let count = list.iter().count();
            let (modules, truncated) = cap_list(list.iter().map(module_json), limit);
            let main = list.main_module().map(|module| cap_str(&module.name));
            json!({
                "schema_version": 1,
                "count": count,
                "main_module": main,
                "items": modules,
                "truncated": truncated,
            })
        }
        Err(_) => json!({
            "schema_version": 1,
            "count": 0,
            "items": Vec::<Value>::new(),
            "truncated": false,
            "warnings": ["module_list_stream_absent"],
        }),
    }
}

// ---------------------------------------------------------------------------
// memory_read
// ---------------------------------------------------------------------------

fn memory_read(dump: &Minidump<'_, DumpData<'_>>, address: u64, length: u64) -> Value {
    let mut found: Option<(&str, u64, &[u8])> = None;
    if let Ok(list) = dump.get_stream::<MinidumpMemory64List>() {
        for region in list.iter() {
            if let Some(bytes) =
                region_slice(region.base_address, region.size, region.bytes, address, length)
            {
                found = Some(("memory64_list", region.base_address, bytes));
                break;
            }
        }
    }
    if found.is_none() {
        if let Ok(list) = dump.get_stream::<MinidumpMemoryList>() {
            for region in list.iter() {
                if let Some(bytes) = region_slice(
                    region.base_address,
                    region.size,
                    region.bytes,
                    address,
                    length,
                ) {
                    found = Some(("memory_list", region.base_address, bytes));
                    break;
                }
            }
        }
    }
    match found {
        Some((source, base, bytes)) => {
            let coverage = if bytes.len() as u64 == length {
                "full"
            } else {
                "partial"
            };
            json!({
                "schema_version": 1,
                "address": hex64(address),
                "requested_length": length,
                "bytes_read": bytes.len(),
                "coverage": coverage,
                "region": {
                    "source": source,
                    "base": hex64(base),
                    "served_until": hex64(address.saturating_add(bytes.len() as u64)),
                },
                "data_base64": base64_encode(bytes),
            })
        }
        None => json!({
            "schema_version": 1,
            "error": "unmapped_address",
            "address": hex64(address),
        }),
    }
}

/// Slice the window `[address, address+length)` out of a memory region, when
/// the region covers the start address. Returns at most `length` bytes and
/// fewer when the region ends mid-window.
fn region_slice<'a>(
    base: u64,
    size: u64,
    bytes: &'a [u8],
    address: u64,
    length: u64,
) -> Option<&'a [u8]> {
    if address < base {
        return None;
    }
    let offset = address.checked_sub(base)?;
    if offset >= size {
        return None;
    }
    let available = size.checked_sub(offset)?.min(u64::from(u32::MAX)) as usize;
    let available = available.min(bytes.len());
    let start = usize::try_from(offset).ok()?;
    let take = available.min(length as usize);
    bytes.get(start..start.checked_add(take)?)
}

// ---------------------------------------------------------------------------
// stream
// ---------------------------------------------------------------------------

fn stream_dump(
    dump: &Minidump<'_, DumpData<'_>>,
    prepared: &Prepared<'_>,
    stream_type: u32,
    options: &StreamOptions,
    all: &[u8],
) -> Value {
    use md::MINIDUMP_STREAM_TYPE as S;
    let sysinfo = dump.get_stream::<MinidumpSystemInfo>().ok();
    let misc = dump.get_stream::<MinidumpMiscInfo>().ok();
    let dir = prepared
        .dirs
        .iter()
        .rev()
        .find(|dir| dir.stream_type == stream_type);
    let raw = dump.get_raw_stream(stream_type).ok();

    let mut envelope = Map::new();
    envelope.insert("schema_version".into(), Value::from(1));
    envelope.insert("stream_type".into(), Value::from(stream_type));
    envelope.insert("name".into(), Value::from(stream_type_name(stream_type)));
    envelope.insert("vendor".into(), Value::from(stream_vendor(stream_type)));

    let decoded: Option<Value> = match S::from_u32(stream_type) {
        Some(S::SystemInfoStream) => dump
            .get_stream::<MinidumpSystemInfo>()
            .ok()
            .map(|info| system_info_json(&info)),
        Some(S::ExceptionStream) => dump
            .get_stream::<MinidumpException>()
            .ok()
            .map(|exception| exception_json(&exception, sysinfo.as_ref(), misc.as_ref())),
        Some(S::ThreadListStream) => dump
            .get_stream::<MinidumpThreadList>()
            .ok()
            .map(|list| {
                let memory = dump.get_memory();
                let names = dump.get_stream::<MinidumpThreadNames>().ok();
                let (items, truncated) = cap_list(
                    list.threads.iter().map(|thread| {
                        thread_json(
                            thread,
                            sysinfo.as_ref(),
                            misc.as_ref(),
                            names.as_ref(),
                            memory.as_ref(),
                        )
                    }),
                    MAX_LIST_ITEMS,
                );
                json!({
                    "count": list.threads.len(),
                    "items": items,
                    "truncated": truncated,
                })
            }),
        Some(S::ModuleListStream) => dump
            .get_stream::<MinidumpModuleList>()
            .ok()
            .map(|list| {
                let (items, truncated) = cap_list(list.iter().map(module_json), MAX_LIST_ITEMS);
                json!({
                    "count": list.iter().count(),
                    "items": items,
                    "truncated": truncated,
                })
            }),
        Some(S::UnloadedModuleListStream) => dump
            .get_stream::<MinidumpUnloadedModuleList>()
            .ok()
            .map(|list| {
                let (items, truncated) = cap_list(
                    list.iter().map(|module| {
                        json!({
                            "name": cap_str(&module.name),
                            "base": hex64(module.raw.base_of_image),
                            "size": u64::from(module.raw.size_of_image),
                            "checksum": hex32(module.raw.checksum),
                            "time_date_stamp": module.raw.time_date_stamp,
                        })
                    }),
                    MAX_LIST_ITEMS,
                );
                json!({
                    "count": list.iter().count(),
                    "items": items,
                    "truncated": truncated,
                })
            }),
        Some(S::MemoryListStream) => dump
            .get_stream::<MinidumpMemoryList>()
            .ok()
            .map(|list| {
                let (items, truncated) = cap_list(
                    list.iter().map(|region| {
                        json!({
                            "base": hex64(region.base_address),
                            "size": region.size,
                            "bytes_stored": region.bytes.len() as u64,
                            "data_rva": region.desc.memory.rva,
                        })
                    }),
                    MAX_LIST_ITEMS,
                );
                json!({
                    "count": list.iter().count(),
                    "items": items,
                    "truncated": truncated,
                })
            }),
        Some(S::Memory64ListStream) => dump
            .get_stream::<MinidumpMemory64List>()
            .ok()
            .map(|list| {
                let (items, truncated) = cap_list(
                    list.iter().map(|region| {
                        json!({
                            "base": hex64(region.base_address),
                            "size": region.size,
                            "bytes_stored": region.bytes.len() as u64,
                        })
                    }),
                    MAX_LIST_ITEMS,
                );
                json!({
                    "count": list.iter().count(),
                    "items": items,
                    "truncated": truncated,
                })
            }),
        Some(S::MemoryInfoListStream) => dump
            .get_stream::<MinidumpMemoryInfoList>()
            .ok()
            .map(|list| {
                let (items, truncated) = cap_list(
                    list.iter().map(|info| memory_info_json(UnifiedMemoryInfo::Info(info))),
                    MAX_LIST_ITEMS,
                );
                json!({
                    "count": list.iter().count(),
                    "items": items,
                    "truncated": truncated,
                })
            }),
        Some(S::LinuxMaps) => dump
            .get_stream::<MinidumpLinuxMaps>()
            .ok()
            .map(|list| {
                let (items, truncated) = cap_list(
                    list.iter().map(|info| memory_info_json(UnifiedMemoryInfo::Map(info))),
                    MAX_LIST_ITEMS,
                );
                json!({
                    "count": list.iter().count(),
                    "items": items,
                    "truncated": truncated,
                })
            }),
        Some(S::MiscInfoStream) => dump
            .get_stream::<MinidumpMiscInfo>()
            .ok()
            .map(|info| misc_info_json(&info)),
        Some(S::BreakpadInfoStream) => dump
            .get_stream::<MinidumpBreakpadInfo>()
            .ok()
            .map(|info| {
                json!({
                    "dump_thread_id": info.dump_thread_id,
                    "requesting_thread_id": info.requesting_thread_id,
                })
            }),
        Some(S::AssertionInfoStream) => dump
            .get_stream::<MinidumpAssertion>()
            .ok()
            .map(|assertion| {
                json!({
                    "expression": assertion.expression().map(|v| cap_str(&v)),
                    "function": assertion.function().map(|v| cap_str(&v)),
                    "file": assertion.file().map(|v| cap_str(&v)),
                    "line": assertion.raw.line,
                    "type": assertion.raw._type,
                })
            }),
        Some(S::CrashpadInfoStream) => dump
            .get_stream::<MinidumpCrashpadInfo>()
            .ok()
            .map(|info| crashpad_json(&info)),
        Some(S::MozMacosCrashInfoStream) => dump
            .get_stream::<MinidumpMacCrashInfo>()
            .ok()
            .map(|info| mac_crash_json(&info)),
        Some(S::MozMacosBootargsStream) => dump
            .get_stream::<MinidumpMacBootargs>()
            .ok()
            .map(|args| {
                json!({
                    "stream_type": args.raw.stream_type,
                    "bootargs": args.bootargs.map(|v| cap_str(&v)),
                })
            }),
        Some(S::ThreadInfoListStream) => dump
            .get_stream::<MinidumpThreadInfoList>()
            .ok()
            .map(|list| {
                let (items, truncated) = cap_list(
                    list.thread_infos.iter().map(|info| {
                        json!({
                            "thread_id": info.raw.thread_id,
                            "dump_flags": hex32(info.raw.dump_flags),
                            "dump_error": hex32(info.raw.dump_error),
                            "exit_status": hex32(info.raw.exit_status),
                            "create_time": info.raw.create_time,
                            "exit_time": info.raw.exit_time,
                            "kernel_time": info.raw.kernel_time,
                            "user_time": info.raw.user_time,
                            "start_address": hex64(info.raw.start_address),
                            "affinity": hex64(info.raw.affinity),
                        })
                    }),
                    MAX_LIST_ITEMS,
                );
                json!({
                    "count": list.thread_infos.len(),
                    "items": items,
                    "truncated": truncated,
                })
            }),
        Some(S::StabilityReportStream) => dump
            .get_stream::<StabilityReport>()
            .ok()
            .map(|report| {
                let (states, truncated) = cap_list(
                    report.process_states.iter().map(|state| {
                        let mem = state
                            .memory_state
                            .as_ref()
                            .and_then(|m| m.windows_memory.as_ref())
                            .map(|w| {
                                json!({
                                    "private_usage_pages": w.process_private_usage,
                                    "peak_workingset_pages": w.process_peak_workingset_size,
                                    "peak_pagefile_pages": w.process_peak_pagefile_usage,
                                    "allocation_attempt": w.process_allocation_attempt,
                                })
                            });
                        let fs = state.file_system_state.as_ref().map(|f| {
                            json!({
                                "open_fds": f
                                    .posix_file_system_state
                                    .as_ref()
                                    .and_then(|p| p.open_file_descriptors),
                                "handle_count": f
                                    .windows_file_system_state
                                    .as_ref()
                                    .and_then(|w| w.process_handle_count),
                            })
                        });
                        json!({
                            "process_id": state.process_id,
                            "memory_state": mem,
                            "file_system_state": fs,
                        })
                    }),
                    MAX_LIST_ITEMS,
                );
                let system = report.system_memory_state.as_ref().and_then(|s| {
                    s.windows_memory.as_ref().map(|w| {
                        json!({
                            "commit_limit_pages": w.system_commit_limit,
                            "commit_remaining_pages": w.system_commit_remaining,
                            "handle_count": w.system_handle_count,
                        })
                    })
                });
                json!({
                    "process_states": states,
                    "process_states_truncated": truncated,
                    "system_memory_state": system,
                })
            }),
        Some(S::LinuxCpuInfo) => dump
            .get_stream::<MinidumpLinuxCpuInfo>()
            .ok()
            .map(|info| linux_pairs(info.iter())),
        Some(S::LinuxEnviron) => dump
            .get_stream::<MinidumpLinuxEnviron>()
            .ok()
            .map(|info| linux_pairs(info.iter())),
        Some(S::LinuxLsbRelease) => dump
            .get_stream::<MinidumpLinuxLsbRelease>()
            .ok()
            .map(|info| linux_pairs(info.iter())),
        Some(S::LinuxProcStatus) => dump
            .get_stream::<MinidumpLinuxProcStatus>()
            .ok()
            .map(|info| linux_pairs(info.iter())),
        Some(S::MozLinuxLimits) => dump
            .get_stream::<MinidumpLinuxProcLimits>()
            .ok()
            .map(|info| linux_lines(info.iter())),
        Some(S::MozSoftErrors) => dump
            .get_stream::<MinidumpSoftErrors>()
            .ok()
            .map(|errors| json!({ "text": cap_str(errors.as_ref()) })),
        // Decoded manually: the crate walks an unbounded `next_info_rva` chain.
        Some(S::HandleDataStream) => {
            raw.map(|bytes| handles_decode(bytes, all, prepared.little))
        }
        // Decoded manually so every name is enumerable (the crate exposes only
        // per-id lookup, not iteration).
        Some(S::ThreadNamesStream) => {
            raw.map(|bytes| thread_names_decode(bytes, all, prepared.little))
        }
        _ => None,
    };

    match decoded {
        Some(decoded) => {
            envelope.insert("decoded".into(), Value::Bool(true));
            envelope.insert("content".into(), decoded);
        }
        None => {
            envelope.insert("decoded".into(), Value::Bool(false));
            match (dir, raw) {
                (_, Some(bytes)) => {
                    let preview_cap = options
                        .preview_bytes
                        .unwrap_or(MAX_STREAM_PREVIEW)
                        .min(MAX_STREAM_PREVIEW);
                    let take = bytes.len().min(preview_cap);
                    let preview = &bytes[..take];
                    envelope.insert("size".into(), Value::from(bytes.len() as u64));
                    envelope.insert(
                        "preview_base64".into(),
                        Value::from(base64_encode(preview)),
                    );
                    envelope
                        .insert("preview_truncated".into(), Value::Bool(bytes.len() > take));
                    if let Ok(text) = std::str::from_utf8(preview) {
                        if text.chars().all(|c| !c.is_control() || c.is_whitespace()) {
                            envelope.insert("text".into(), Value::from(cap_str(text)));
                        }
                    }
                }
                _ => {
                    envelope.insert("error".into(), Value::from("stream_not_found"));
                }
            }
        }
    }
    Value::Object(envelope)
}

// ---------------------------------------------------------------------------
// Manual stream decoders (bounds-checked, no crate internals)
// ---------------------------------------------------------------------------

/// Safe length-prefixed UTF-16 string read used by the manual decoders.
/// Mirrors the crate's semantics with 64-bit checked arithmetic.
fn safe_utf16(bytes: &[u8], rva: u64, little: bool) -> Option<String> {
    let size = read_u32_at(bytes, rva, little)? as usize;
    if size % 2 != 0 {
        return None;
    }
    let start = usize::try_from(rva.checked_add(4)?).ok()?;
    let end = start.checked_add(size)?;
    let raw = bytes.get(start..end)?;
    let units: Vec<u16> = raw
        .chunks_exact(2)
        .map(|pair| {
            if little {
                u16::from_le_bytes([pair[0], pair[1]])
            } else {
                u16::from_be_bytes([pair[0], pair[1]])
            }
        })
        .collect();
    String::from_utf16(&units).ok()
}

/// MINIDUMP_HANDLE_DATA_STREAM decoded by hand: the stream header is
/// `{size_of_header, size_of_descriptor, number_of_descriptors, reserved}`,
/// followed by fixed-size descriptors (v1 = 32 bytes, v2 = 40 bytes where the
/// trailing `object_info_rva`/`reserved0` pair is present). v2 object-info
/// chains are walked with a per-descriptor cycle bound.
fn handles_decode(stream: &[u8], all: &[u8], little: bool) -> Value {
    let (Some(header_size), Some(desc_size), Some(desc_count)) = (
        read_u32_at(stream, 0, little),
        read_u32_at(stream, 4, little),
        read_u32_at(stream, 8, little),
    ) else {
        return json!({"error": "malformed_handle_data_stream"});
    };
    let header_size = u64::from(header_size);
    let desc_size = u64::from(desc_size);
    if !(32..=4096).contains(&desc_size) {
        return json!({"error": "malformed_handle_data_stream"});
    }
    let desc_count = u64::from(desc_count);
    let available = (stream.len() as u64).saturating_sub(header_size);
    let present = available / desc_size;
    let count = desc_count.min(present);
    let (handles, truncated) = cap_list(
        (0..count).map(|i| {
            let off = header_size + i * desc_size;
            let handle = read_u64_at(stream, off, little).unwrap_or(0);
            let type_name_rva = read_u32_at(stream, off + 8, little).unwrap_or(0);
            let object_name_rva = read_u32_at(stream, off + 12, little).unwrap_or(0);
            let attributes = read_u32_at(stream, off + 16, little).unwrap_or(0);
            let granted_access = read_u32_at(stream, off + 20, little).unwrap_or(0);
            let handle_count = read_u32_at(stream, off + 24, little).unwrap_or(0);
            let pointer_count = read_u32_at(stream, off + 28, little).unwrap_or(0);
            let (object_info_rva, infos) = if desc_size >= 40 {
                let rva = read_u32_at(stream, off + 32, little).unwrap_or(0);
                (
                    Value::from(hex32(rva)),
                    handle_info_chain(all, rva, little),
                )
            } else {
                (Value::Null, Vec::new())
            };
            json!({
                "handle": hex64(handle),
                "type_name": if type_name_rva != 0 {
                    safe_utf16(all, u64::from(type_name_rva), little).map(|v| cap_str(&v))
                } else {
                    None
                },
                "object_name": if object_name_rva != 0 {
                    safe_utf16(all, u64::from(object_name_rva), little).map(|v| cap_str(&v))
                } else {
                    None
                },
                "attributes": hex32(attributes),
                "granted_access": hex32(granted_access),
                "handle_count": handle_count,
                "pointer_count": pointer_count,
                "object_info_rva": object_info_rva,
                "object_info": infos,
            })
        }),
        MAX_LIST_ITEMS,
    );
    json!({
        "size_of_header": header_size,
        "size_of_descriptor": desc_size,
        "declared_descriptors": desc_count,
        "descriptors_decoded": handles.len(),
        "items": handles,
        "truncated": truncated || count < desc_count,
    })
}

/// Walk one `MINIDUMP_HANDLE_OBJECT_INFORMATION` chain with a hard cycle
/// bound. Each node is `{next_info_rva, info_type, size_of_info}` followed by
/// `size_of_info - 12` bytes of type-specific payload.
fn handle_info_chain(all: &[u8], start_rva: u32, little: bool) -> Vec<Value> {
    let mut infos = Vec::new();
    let mut rva = start_rva;
    let mut seen = std::collections::BTreeSet::new();
    while rva != 0 && infos.len() < MAX_HANDLE_CHAIN && seen.insert(rva) {
        let (Some(next), Some(info_type), Some(size)) = (
            read_u32_at(all, u64::from(rva), little),
            read_u32_at(all, u64::from(rva) + 4, little),
            read_u32_at(all, u64::from(rva) + 8, little),
        ) else {
            infos.push(json!({"rva": hex32(rva), "error": "out_of_bounds"}));
            break;
        };
        infos.push(json!({
            "rva": hex32(rva),
            "info_type": info_type,
            "size_of_info": size,
            "next_info_rva": hex32(next),
        }));
        rva = next;
    }
    if rva != 0 && infos.len() >= MAX_HANDLE_CHAIN {
        infos.push(json!({"error": "chain_truncated"}));
    }
    infos
}

/// MINIDUMP_THREAD_NAME list decoded by hand: `u32 count` then `count` entries
/// of `{thread_id u32, thread_name_rva RVA64}` (12 bytes each). The crate only
/// exposes per-id lookups; enumerating needs the raw layout.
fn thread_names_decode(stream: &[u8], all: &[u8], little: bool) -> Value {
    let Some(count) = read_u32_at(stream, 0, little) else {
        return json!({"error": "malformed_thread_names_stream"});
    };
    let count = u64::from(count);
    let present = ((stream.len() as u64).saturating_sub(4)) / 12;
    let decoded = count.min(present);
    let (items, truncated) = cap_list(
        (0..decoded).map(|i| {
            let off = 4 + i * 12;
            let thread_id = read_u32_at(stream, off, little).unwrap_or(0);
            let rva = read_u64_at(stream, off + 4, little).unwrap_or(0);
            json!({
                "thread_id": thread_id,
                "name": safe_utf16(all, rva, little).map(|v| cap_str(&v)),
            })
        }),
        MAX_LIST_ITEMS,
    );
    json!({
        "declared_count": count,
        "items": items,
        "truncated": truncated || decoded < count,
    })
}

// ---------------------------------------------------------------------------
// base64 (no dependency; table-driven encoder)
// ---------------------------------------------------------------------------

const B64: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64[(triple >> 18) as usize & 0x3f] as char);
        out.push(B64[(triple >> 12) as usize & 0x3f] as char);
        out.push(if chunk.len() > 1 {
            B64[(triple >> 6) as usize & 0x3f] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64[triple as usize & 0x3f] as char
        } else {
            '='
        });
    }
    out
}

// ---------------------------------------------------------------------------
// Tests: synthetic minidumps built byte-by-byte in test code.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Byte-level minidump builder: header + directory + stream blobs,
    /// followed by tail blobs placed at explicitly computed RVAs.
    struct DumpBuilder {
        streams: Vec<(u32, Vec<u8>)>,
        tail: Vec<Vec<u8>>,
    }

    impl DumpBuilder {
        fn new() -> Self {
            DumpBuilder {
                streams: Vec::new(),
                tail: Vec::new(),
            }
        }

        fn stream(&mut self, stream_type: u32, data: Vec<u8>) -> &mut Self {
            self.streams.push((stream_type, data));
            self
        }

        /// RVA where the next tail blob lands if pushed now (streams are laid
        /// out in push order right after the directory).
        fn next_tail_rva(&self) -> u64 {
            HEADER_SIZE
                + self.streams.len() as u64 * DIR_ENTRY_SIZE
                + self
                    .streams
                    .iter()
                    .map(|(_, v)| v.len() as u64)
                    .sum::<u64>()
                + self.tail.iter().map(|v| v.len() as u64).sum::<u64>()
        }

        fn push_tail(&mut self, data: Vec<u8>) -> u64 {
            let rva = self.next_tail_rva();
            self.tail.push(data);
            rva
        }

        fn build(&self) -> Vec<u8> {
            let mut bytes = Vec::new();
            bytes.extend_from_slice(&MINIDUMP_SIGNATURE.to_le_bytes());
            bytes.extend_from_slice(&MINIDUMP_VERSION.to_le_bytes());
            bytes.extend_from_slice(&(self.streams.len() as u32).to_le_bytes());
            bytes.extend_from_slice(&(HEADER_SIZE as u32).to_le_bytes());
            bytes.extend_from_slice(&0u32.to_le_bytes()); // checksum
            bytes.extend_from_slice(&1_700_000_000u32.to_le_bytes()); // timestamp
            bytes.extend_from_slice(&0u64.to_le_bytes()); // flags
            let mut rva = HEADER_SIZE + self.streams.len() as u64 * DIR_ENTRY_SIZE;
            for (stream_type, data) in &self.streams {
                bytes.extend_from_slice(&stream_type.to_le_bytes());
                bytes.extend_from_slice(&(data.len() as u32).to_le_bytes());
                bytes.extend_from_slice(&(rva as u32).to_le_bytes());
                rva += data.len() as u64;
            }
            for (_, data) in &self.streams {
                bytes.extend_from_slice(data);
            }
            for data in &self.tail {
                bytes.extend_from_slice(data);
            }
            bytes
        }
    }

    fn utf16_blob(text: &str) -> Vec<u8> {
        let units: Vec<u16> = text.encode_utf16().collect();
        let mut out = (units.len() as u32 * 2).to_le_bytes().to_vec();
        for unit in units {
            out.extend_from_slice(&unit.to_le_bytes());
        }
        out
    }

    /// Build a dump containing SysInfo + ModuleList(2) + ThreadList(1 with
    /// context + stack) + Exception + MemoryList. Returns (bytes, stack_base).
    fn sample_dump() -> (Vec<u8>, u64) {
        let mut b = DumpBuilder::new();
        let stack_base: u64 = 0x7fff_0000;
        let stack_bytes = vec![0xabu8; 256];
        // CONTEXT_X86 is 716 bytes; context_flags must carry the CONTEXT_X86
        // base flag (0x0001_0000) for the crate to parse registers.
        let mut ctx_bytes = vec![0u8; 716];
        ctx_bytes[0..4].copy_from_slice(&0x0001_0007u32.to_le_bytes());
        ctx_bytes[176..180].copy_from_slice(&0x1122_3344u32.to_le_bytes()); // eax
        ctx_bytes[184..188].copy_from_slice(&0x0040_1234u32.to_le_bytes()); // eip
        ctx_bytes[196..200]
            .copy_from_slice(&((stack_base + 0x80) as u32).to_le_bytes()); // esp

        // Tail blob RVAs are known only after every stream is queued, so the
        // stream payloads are built with placeholder RVAs first, patched after.
        // Instead, compute the layout up-front: 5 streams -> dir at 32, data
        // starts at 32 + 5*12 = 92.
        let sysinfo_len = 56u64;
        let module_stream_len = 4 + 2 * 108;
        let thread_stream_len = 4 + 48;
        let exception_len = 168u64;
        let memory_stream_len = 4 + 16u64;
        let sysinfo_rva = HEADER_SIZE + 5 * DIR_ENTRY_SIZE;
        let modules_rva = sysinfo_rva + sysinfo_len;
        let threads_rva = modules_rva + module_stream_len;
        let exception_rva = threads_rva + thread_stream_len;
        let memory_rva = exception_rva + exception_len;
        let mut tail_rva = memory_rva + memory_stream_len;

        let csd_rva = tail_rva;
        tail_rva += utf16_blob("Service Pack 1").len() as u64;
        let name1_rva = tail_rva;
        tail_rva += utf16_blob("app.exe").len() as u64;
        let name2_rva = tail_rva;
        tail_rva += utf16_blob("ntdll.dll").len() as u64;
        let stack_rva = tail_rva;
        tail_rva += stack_bytes.len() as u64;
        let ctx_rva = tail_rva;
        tail_rva += ctx_bytes.len() as u64;
        let exc_ctx_rva = tail_rva;

        // -- SystemInfoStream (7): MINIDUMP_SYSTEM_INFO, 56 bytes --
        let mut sysinfo = Vec::new();
        sysinfo.extend_from_slice(&0u16.to_le_bytes()); // processor_arch x86
        sysinfo.extend_from_slice(&6u16.to_le_bytes()); // processor_level
        sysinfo.extend_from_slice(&0x1a01u16.to_le_bytes()); // revision
        sysinfo.push(4); // number_of_processors
        sysinfo.push(1); // product_type
        sysinfo.extend_from_slice(&10u32.to_le_bytes()); // major
        sysinfo.extend_from_slice(&0u32.to_le_bytes()); // minor
        sysinfo.extend_from_slice(&19045u32.to_le_bytes()); // build
        sysinfo.extend_from_slice(&2u32.to_le_bytes()); // platform WIN32_NT
        sysinfo.extend_from_slice(&(csd_rva as u32).to_le_bytes()); // csd rva
        sysinfo.extend_from_slice(&0x100u16.to_le_bytes()); // suite_mask
        sysinfo.extend_from_slice(&0u16.to_le_bytes()); // reserved2
        sysinfo.extend_from_slice(&[0u8; 24]); // cpu info union
        assert_eq!(sysinfo.len() as u64, sysinfo_len);
        b.stream(7, sysinfo);
        let _ = sysinfo_rva;
        let _ = modules_rva;
        let _ = threads_rva;
        let _ = exception_rva;
        let _ = memory_rva;

        // -- ModuleListStream (4): u32 count + 2 * MINIDUMP_MODULE (108) --
        let mut module_list = Vec::new();
        module_list.extend_from_slice(&2u32.to_le_bytes());
        for (i, name_rva) in [name1_rva, name2_rva].iter().enumerate() {
            let mut m = Vec::new();
            m.extend_from_slice(&(0x400000u64 + i as u64 * 0x100000).to_le_bytes());
            m.extend_from_slice(&0x20000u32.to_le_bytes()); // size_of_image
            m.extend_from_slice(&0u32.to_le_bytes()); // checksum
            m.extend_from_slice(&0x5f00u32.to_le_bytes()); // time_date_stamp
            m.extend_from_slice(&(*name_rva as u32).to_le_bytes()); // name rva
            m.extend_from_slice(&[0u8; 52]); // VS_FIXEDFILEINFO
            m.extend_from_slice(&[0u8; 8]); // cv_record location
            m.extend_from_slice(&[0u8; 8]); // misc_record location
            m.extend_from_slice(&0u64.to_le_bytes()); // reserved0
            m.extend_from_slice(&0u64.to_le_bytes()); // reserved1
            assert_eq!(m.len(), 108);
            module_list.extend_from_slice(&m);
        }
        b.stream(4, module_list);

        // -- ThreadListStream (3): u32 count + MINIDUMP_THREAD (48) --
        let mut threads = Vec::new();
        threads.extend_from_slice(&1u32.to_le_bytes());
        threads.extend_from_slice(&0x1234u32.to_le_bytes()); // thread_id
        threads.extend_from_slice(&0u32.to_le_bytes()); // suspend_count
        threads.extend_from_slice(&0u32.to_le_bytes()); // priority_class
        threads.extend_from_slice(&0u32.to_le_bytes()); // priority
        threads.extend_from_slice(&0x7ff0_0000u64.to_le_bytes()); // teb
        threads.extend_from_slice(&stack_base.to_le_bytes()); // stack start
        threads.extend_from_slice(&(stack_bytes.len() as u32).to_le_bytes());
        threads.extend_from_slice(&(stack_rva as u32).to_le_bytes());
        threads.extend_from_slice(&(ctx_bytes.len() as u32).to_le_bytes());
        threads.extend_from_slice(&(ctx_rva as u32).to_le_bytes());
        assert_eq!(threads.len() as u64, thread_stream_len);
        b.stream(3, threads);

        // -- ExceptionStream (6): thread_id + align + MINIDUMP_EXCEPTION --
        let mut exc = Vec::new();
        exc.extend_from_slice(&0x1234u32.to_le_bytes());
        exc.extend_from_slice(&0u32.to_le_bytes());
        exc.extend_from_slice(&0xc000_0005u32.to_le_bytes()); // ACCESS_VIOLATION
        exc.extend_from_slice(&0u32.to_le_bytes()); // flags
        exc.extend_from_slice(&0u64.to_le_bytes()); // nested record
        exc.extend_from_slice(&0x0040_1234u64.to_le_bytes()); // address
        exc.extend_from_slice(&2u32.to_le_bytes()); // number_parameters
        exc.extend_from_slice(&0u32.to_le_bytes()); // align
        exc.extend_from_slice(&1u64.to_le_bytes()); // info[0] = write
        exc.extend_from_slice(&0xdead_beefu64.to_le_bytes()); // info[1] = addr
        exc.extend_from_slice(&[0u8; 13 * 8]);
        exc.extend_from_slice(&(ctx_bytes.len() as u32).to_le_bytes());
        exc.extend_from_slice(&(exc_ctx_rva as u32).to_le_bytes());
        assert_eq!(exc.len() as u64, exception_len);
        b.stream(6, exc);

        // -- MemoryListStream (5): u32 count + MINIDUMP_MEMORY_DESCRIPTOR --
        let mut mem = Vec::new();
        mem.extend_from_slice(&1u32.to_le_bytes());
        mem.extend_from_slice(&stack_base.to_le_bytes());
        mem.extend_from_slice(&(stack_bytes.len() as u32).to_le_bytes());
        mem.extend_from_slice(&(stack_rva as u32).to_le_bytes());
        b.stream(5, mem);

        // Tail blobs in the same order the RVAs were computed.
        b.push_tail(utf16_blob("Service Pack 1"));
        b.push_tail(utf16_blob("app.exe"));
        b.push_tail(utf16_blob("ntdll.dll"));
        b.push_tail(stack_bytes);
        b.push_tail(ctx_bytes.clone());
        b.push_tail(ctx_bytes);

        (b.build(), stack_base)
    }

    fn parse(json_text: &str) -> Value {
        serde_json::from_str(json_text).expect("output is valid JSON")
    }

    #[test]
    fn inspect_happy_path() {
        let (dump, _stack_base) = sample_dump();
        let out = parse(&minidump_inspect(&dump, "{}"));
        assert_eq!(out["schema_version"], 1);
        assert_eq!(out["valid"], true);
        assert_eq!(out["streams"]["count"], 5);
        assert_eq!(out["system_info"]["os"], "windows");
        assert_eq!(out["system_info"]["csd_version"], "Service Pack 1");
        assert_eq!(out["exception"]["exception_code"], "0xc0000005");
        assert_eq!(out["exception"]["crash_address"], "0xdeadbeef");
        assert_eq!(out["threads"]["count"], 1);
        assert_eq!(out["threads"]["items"][0]["thread_id"], 0x1234);
        assert_eq!(
            out["threads"]["items"][0]["context"]["instruction_pointer"],
            "0x401234"
        );
        assert_eq!(out["modules"]["count"], 2);
        assert_eq!(out["modules"]["items"][0]["name"], "app.exe");
        assert_eq!(out["memory_regions"]["count"], 1);
    }

    #[test]
    fn stream_directory_and_selection() {
        let (dump, _) = sample_dump();
        let out = parse(&minidump_stream(&dump, r#"{"stream":7}"#));
        assert_eq!(out["decoded"], true);
        assert_eq!(out["content"]["os"], "windows");
        let out = parse(&minidump_stream(&dump, r#"{"name":"ModuleListStream"}"#));
        assert_eq!(out["decoded"], true);
        assert_eq!(out["content"]["count"], 2);
        let out = parse(&minidump_stream(&dump, r#"{"stream":99}"#));
        assert_eq!(out["error"], "stream_not_found");
        let out = parse(&minidump_stream(&dump, "{}"));
        assert_eq!(out["error"], "missing_stream");
        let out = parse(&minidump_stream(&dump, r#"{"stream":"bogus"}"#));
        assert_eq!(out["error"], "invalid_stream");
    }

    #[test]
    fn stream_raw_preview() {
        // Unknown stream type falls back to a bounded base64 preview.
        let mut b = DumpBuilder::new();
        b.stream(0x7777_0001, vec![0xde, 0xad, 0xbe, 0xef]);
        let dump = b.build();
        let out = parse(&minidump_stream(&dump, r#"{"stream":"0x77770001"}"#));
        assert_eq!(out["decoded"], false);
        assert_eq!(out["size"], 4);
        assert_eq!(out["preview_base64"], base64_encode(&[0xde, 0xad, 0xbe, 0xef]));
    }

    #[test]
    fn memory_read_hit_miss_partial() {
        let (dump, stack_base) = sample_dump();
        let out = parse(&minidump_memory_read(
            &dump,
            &format!(r#"{{"address":"0x{stack_base:x}","length":16}}"#),
        ));
        assert_eq!(out["coverage"], "full");
        assert_eq!(out["bytes_read"], 16);
        assert_eq!(out["data_base64"], base64_encode(&[0xabu8; 16]));
        // partial: 300 requested but the region only has 256
        let out = parse(&minidump_memory_read(
            &dump,
            &format!(r#"{{"address":"0x{stack_base:x}","length":300}}"#),
        ));
        assert_eq!(out["coverage"], "partial");
        assert_eq!(out["bytes_read"], 256);
        // miss
        let out = parse(&minidump_memory_read(
            &dump,
            r#"{"address":"0x41414141","length":16}"#,
        ));
        assert_eq!(out["error"], "unmapped_address");
    }

    #[test]
    fn modules_operation() {
        let (dump, _) = sample_dump();
        let out = parse(&minidump_modules(&dump, "{}"));
        assert_eq!(out["count"], 2);
        assert_eq!(out["items"][1]["name"], "ntdll.dll");
    }

    #[test]
    fn malformed_inputs() {
        // bad signature
        let mut bad = vec![0u8; 64];
        bad[0..4].copy_from_slice(b"NOPE");
        let out = parse(&minidump_inspect(&bad, "{}"));
        assert_eq!(out["error"], "parse_failed");

        // truncated header
        let out = parse(&minidump_inspect(&[0u8; 8], "{}"));
        assert_eq!(out["error"], "parse_failed");

        // directory beyond EOF
        let mut d = Vec::new();
        d.extend_from_slice(&MINIDUMP_SIGNATURE.to_le_bytes());
        d.extend_from_slice(&MINIDUMP_VERSION.to_le_bytes());
        d.extend_from_slice(&4u32.to_le_bytes());
        d.extend_from_slice(&0xffff_fff0u32.to_le_bytes());
        d.extend_from_slice(&[0u8; 16]);
        let out = parse(&minidump_inspect(&d, "{}"));
        assert_eq!(out["error"], "parse_failed");

        // truncation of a valid dump still produces a bounded document
        let (dump, _) = sample_dump();
        let truncated = &dump[..dump.len() / 2];
        let out = parse(&minidump_inspect(truncated, "{}"));
        assert_eq!(out["schema_version"], 1);

        // overlapping/duplicate stream directory entries do not panic
        let mut b = DumpBuilder::new();
        b.stream(3, vec![0u8; 8]);
        b.stream(3, vec![0u8; 8]);
        let out = parse(&minidump_inspect(&b.build(), "{}"));
        assert_eq!(out["schema_version"], 1);
    }

    #[test]
    fn input_and_options_caps() {
        let big = vec![0u8; MAX_INPUT_BYTES + 1];
        let out = parse(&minidump_inspect(&big, "{}"));
        assert_eq!(out["error"], "input_too_large");
        let (dump, _) = sample_dump();
        let options = format!(r#"{{"pad":"{}"}}"#, "x".repeat(MAX_OPTIONS_BYTES));
        let out = parse(&minidump_inspect(&dump, &options));
        assert_eq!(out["error"], "options_too_large");
        let out = parse(&minidump_inspect(&dump, "{not json"));
        assert_eq!(out["error"], "options_invalid");
    }

    #[test]
    fn memory_read_option_validation() {
        let (dump, _) = sample_dump();
        let out = parse(&minidump_memory_read(&dump, r#"{"length":16}"#));
        assert_eq!(out["error"], "invalid_address");
        let out = parse(&minidump_memory_read(
            &dump,
            r#"{"address":"0x1000","length":70000}"#,
        ));
        assert_eq!(out["error"], "invalid_length");
        let out = parse(&minidump_memory_read(&dump, r#"{"address":"zz","length":16}"#));
        assert_eq!(out["error"], "invalid_address");
        let out = parse(&minidump_memory_read(&dump, r#"{"address":0,"length":0}"#));
        assert_eq!(out["error"], "invalid_length");
    }

    #[test]
    fn deterministic_repeated_calls() {
        let (dump, stack_base) = sample_dump();
        let first = minidump_inspect(&dump, "{}");
        for _ in 0..3 {
            assert_eq!(first, minidump_inspect(&dump, "{}"));
        }
        let opts = format!(r#"{{"address":"0x{stack_base:x}","length":16}}"#);
        let first = minidump_memory_read(&dump, &opts);
        for _ in 0..3 {
            assert_eq!(first, minidump_memory_read(&dump, &opts));
        }
    }

    #[test]
    fn hostile_utf16_rva_is_neutralized() {
        // Corrupt the csd_version RVA to point at a length field whose size
        // would wrap a 32-bit usize bound check inside the crate's UTF-16
        // reader. The wrapper must mask it rather than panic.
        let (mut dump, _) = sample_dump();
        let sysinfo_rva = 92usize; // header 32 + 5 dir entries * 12
        let str_rva = dump.len() as u32; // string header appended at EOF
        dump[sysinfo_rva + 24..sysinfo_rva + 28]
            .copy_from_slice(&str_rva.to_le_bytes());
        dump.extend_from_slice(&0xffff_ff00u32.to_le_bytes()); // declared size
        dump.extend_from_slice(&[0u8; 8]);
        let out = parse(&minidump_inspect(&dump, "{}"));
        assert_eq!(out["schema_version"], 1);
        assert_eq!(out["valid"], true);
        assert!(out["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|w| w.as_str().unwrap().contains("neutralized")));
        assert_eq!(out["system_info"]["csd_version"], Value::Null);
    }

    #[test]
    fn handle_data_cycle_is_bounded() {
        // HandleDataStream with a self-referential object_info chain must not
        // loop forever.
        let mut b = DumpBuilder::new();
        let mut handles = Vec::new();
        handles.extend_from_slice(&16u32.to_le_bytes()); // size_of_header
        handles.extend_from_slice(&40u32.to_le_bytes()); // size_of_descriptor
        handles.extend_from_slice(&1u32.to_le_bytes()); // count
        handles.extend_from_slice(&0u32.to_le_bytes()); // reserved
        handles.extend_from_slice(&0x10u64.to_le_bytes()); // handle
        handles.extend_from_slice(&0u32.to_le_bytes()); // type_name_rva
        handles.extend_from_slice(&0u32.to_le_bytes()); // object_name_rva
        handles.extend_from_slice(&0u32.to_le_bytes()); // attributes
        handles.extend_from_slice(&0u32.to_le_bytes()); // granted_access
        handles.extend_from_slice(&1u32.to_le_bytes()); // handle_count
        handles.extend_from_slice(&1u32.to_le_bytes()); // pointer_count
        let info_rva_pos = handles.len();
        handles.extend_from_slice(&0u32.to_le_bytes()); // object_info_rva
        handles.extend_from_slice(&0u32.to_le_bytes()); // reserved0
        let stream_rva = HEADER_SIZE + DIR_ENTRY_SIZE;
        let info_rva = stream_rva + handles.len() as u64;
        handles[info_rva_pos..info_rva_pos + 4]
            .copy_from_slice(&(info_rva as u32).to_le_bytes());
        b.stream(12, handles);
        // object info node that points at itself
        let mut tail = Vec::new();
        tail.extend_from_slice(&(info_rva as u32).to_le_bytes()); // next = self
        tail.extend_from_slice(&1u32.to_le_bytes()); // info_type
        tail.extend_from_slice(&12u32.to_le_bytes()); // size_of_info
        b.push_tail(tail);
        let dump = b.build();
        let out = parse(&minidump_stream(&dump, r#"{"stream":12}"#));
        assert_eq!(out["decoded"], true);
        let items = out["content"]["items"].as_array().unwrap();
        let info = items[0]["object_info"].as_array().unwrap();
        assert!(info.len() <= MAX_HANDLE_CHAIN + 1);
    }
}
