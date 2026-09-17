//! SquashFS image detection, opening, listing, and single-entry reads.
//!
//! The input is one in-memory byte slice plus a base `offset` where the image
//! starts (firmware images frequently embed a SquashFS at a nonzero offset).
//! Kind detection looks only at the 4-byte magic; each candidate kind is then
//! asked to parse the image and the first successful parse wins. Everything is
//! read-only: no entry is ever written to a filesystem and symlinks are never
//! resolved.

use std::io::{Cursor, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};

use backhand::kind::{self, Kind};
use backhand::traits::filesystem::{BackhandInnerNode, BackhandNode};
use backhand::traits::FilesystemReaderTrait;
use backhand::BackhandError;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    error_json, MAX_CONTENT_BYTES, MAX_ENTRIES, MAX_ENTRY_BYTES, MAX_INODES, MAX_PATH_BYTES,
};

pub(crate) struct ListOptions {
    pub offset: u64,
    pub path_filter: Option<String>,
    pub max_results: Option<usize>,
}

pub(crate) struct ExtractOptions {
    pub offset: u64,
    pub path: String,
    pub max_bytes: Option<u64>,
}

/// Superblock fields normalized across v3 and v4 for reporting.
pub(crate) struct SuperblockInfo {
    kind_name: &'static str,
    magic: [u8; 4],
    type_endian: &'static str,
    data_endian: &'static str,
    version_major: u16,
    version_minor: u16,
    compression: &'static str,
    compression_supported: bool,
    block_size: u32,
    block_log: u16,
    inode_count: u32,
    fragment_count: u64,
    flags: u32,
    id_count: u32,
    mod_time: u32,
    bytes_used: u64,
    root_inode: u64,
}

/// An opened image: a version-agnostic reader plus its superblock summary.
pub(crate) struct Opened<'a> {
    fs: Box<dyn FilesystemReaderTrait + 'a>,
    sb: SuperblockInfo,
}

/// Candidate kinds to try for a 4-byte magic. Order matters: for `sqsh`
/// (big-endian) the plain v4 kind is tried before the AVM mixed-endian kind.
/// `InnerKind` constants are not publicly nameable, so `Kind::from_const` is
/// applied inline; it is infallible for the fixed set used here.
fn candidates(magic: [u8; 4]) -> Result<Vec<(&'static str, Kind)>, String> {
    let kind = |name: &'static str, inner| -> Result<(&'static str, Kind), String> {
        Kind::from_const(inner)
            .map(|kind| (name, kind))
            .map_err(|_| error_json("internal", json!({ "detail": "kind construction failed" })))
    };
    match &magic {
        b"hsqs" => Ok(vec![
            kind("le_v4_0", kind::LE_V4_0)?,
            kind("le_v3_0", kind::LE_V3_0)?,
        ]),
        b"sqsh" => Ok(vec![
            kind("be_v4_0", kind::BE_V4_0)?,
            kind("avm_be_v4_0", kind::AVM_BE_V4_0)?,
            kind("be_v3_0", kind::BE_V3_0)?,
        ]),
        b"qshs" => Err(error_json(
            "unsupported_kind",
            json!({
                "magic": "qshs",
                "detail": "Netgear-style SquashFS v3 with LZMA compression; the v3_lzma kind set requires the GPL lzma-adaptive-sys decompressor and is not built",
            }),
        )),
        b"shsq" => Err(error_json(
            "unsupported_kind",
            json!({
                "magic": "shsq",
                "detail": "swapped-magic SquashFS v3 with LZMA compression; the v3_lzma kind set requires the GPL lzma-adaptive-sys decompressor and is not built",
            }),
        )),
        _ => Err(error_json(
            "not_squashfs",
            json!({ "magic": magic_text(magic) }),
        )),
    }
}

fn magic_text(magic: [u8; 4]) -> String {
    if magic.iter().all(|byte| byte.is_ascii_graphic()) {
        String::from_utf8_lossy(&magic).into_owned()
    } else {
        format!("0x{}", data_encoding::HEXLOWER.encode(&magic))
    }
}

/// `Some((major, minor))` read from raw superblock bytes at offset 28/30, an
/// offset shared by the v3 and v4 superblock layouts.
fn peek_version(head: &[u8], little_endian: bool) -> Option<(u16, u16)> {
    let read_u16 = |at: usize| -> Option<u16> {
        let pair: [u8; 2] = head.get(at..at + 2)?.try_into().ok()?;
        Some(if little_endian {
            u16::from_le_bytes(pair)
        } else {
            u16::from_be_bytes(pair)
        })
    };
    Some((read_u16(28)?, read_u16(30)?))
}

/// Raw v4 compressor id at superblock offset 20 (v3 has no compressor field).
fn peek_compressor_id(head: &[u8], little_endian: bool) -> Option<u16> {
    let pair: [u8; 2] = head.get(20..22)?.try_into().ok()?;
    Some(if little_endian {
        u16::from_le_bytes(pair)
    } else {
        u16::from_be_bytes(pair)
    })
}

fn open(bytes: &[u8], offset: u64) -> Result<Opened<'_>, String> {
    if offset >= bytes.len() as u64 || offset > usize::MAX as u64 {
        return Err(error_json(
            "invalid_options",
            json!({ "detail": format!("offset {offset} is beyond input size {}", bytes.len()) }),
        ));
    }
    let head = &bytes[offset as usize..];
    let magic: [u8; 4] = match head.get(..4) {
        Some(bytes) => bytes.try_into().unwrap(),
        None => {
            return Err(error_json(
                "not_squashfs",
                json!({ "detail": "fewer than 4 bytes at offset; no squashfs magic" }),
            ))
        }
    };
    let little_endian = &magic == b"hsqs";
    let list = candidates(magic)?;

    let mut first_error: Option<String> = None;
    for (name, kind) in list {
        let outcome = catch_unwind(AssertUnwindSafe(|| open_as(bytes, offset, name, kind)));
        match outcome {
            Ok(Ok(opened)) => return Ok(opened),
            Ok(Err(message)) => {
                // An explicit unsupported-* answer is definitive: retrying a
                // different kind cannot change the image's compressor.
                if is_error_code(&message, "unsupported_compression")
                    || is_error_code(&message, "unsupported_version")
                {
                    return Err(message);
                }
                first_error.get_or_insert(message);
            }
            Err(_panic) => {
                // A parser panic is a defect in the format handling, not a host
                // crash: report it as a bounded error. On wasm32 this unwind
                // still aborts into a trap; on native targets it is contained.
                first_error.get_or_insert_with(|| {
                    error_json(
                        "internal",
                        json!({ "detail": "panic during squashfs parse" }),
                    )
                });
            }
        }
    }

    // All candidates failed: enrich the answer from raw superblock fields so
    // unsupported versions and compressors are reported explicitly.
    if let Some((major, minor)) = peek_version(head, little_endian) {
        if major != 3 && major != 4 {
            return Err(error_json(
                "unsupported_version",
                json!({ "versionMajor": major, "versionMinor": minor }),
            ));
        }
        if major == 4 {
            if let Some(id) = peek_compressor_id(head, little_endian) {
                if !matches!(id, 0 | 1 | 5) {
                    return Err(error_json(
                        "unsupported_compression",
                        json!({ "compressor": compressor_name(id), "compressorId": id }),
                    ));
                }
            }
        }
        if major == 3 {
            let mut parsed: serde_json::Map<String, Value> = first_error
                .as_deref()
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
                .and_then(|value| value.as_object().cloned())
                .unwrap_or_default();
            parsed
                .entry("error".to_string())
                .or_insert_with(|| json!("invalid_image"));
            parsed.insert(
                "hint".into(),
                json!(
                    "squashfs v3 supports only gzip here; lzma-compressed v3 images are not built"
                ),
            );
            return Err(Value::Object(parsed).to_string());
        }
    }
    Err(first_error.unwrap_or_else(|| {
        error_json(
            "invalid_image",
            json!({ "detail": "no candidate kind parsed" }),
        )
    }))
}

fn is_error_code(message: &str, code: &str) -> bool {
    serde_json::from_str::<Value>(message)
        .ok()
        .and_then(|value| value.get("error")?.as_str().map(|s| s == code))
        .unwrap_or(false)
}

fn open_as<'a>(
    bytes: &'a [u8],
    offset: u64,
    kind_name: &'static str,
    kind: Kind,
) -> Result<Opened<'a>, String> {
    let little_endian = endianness(kind_name).0 == "little";
    // Raw v4 compressor id, for naming it in errors even when the superblock
    // has not been constructed yet (the decompressor fails before then).
    let raw_compressor =
        || peek_compressor_id(&bytes[offset as usize..], little_endian).map(compressor_name);
    match kind.version_major() {
        4 => {
            let squashfs = backhand::v4::squashfs::Squashfs::from_reader_with_offset_and_kind(
                Cursor::new(bytes),
                offset,
                kind,
            )
            .map_err(|error| backhand_error(error, kind_name, raw_compressor()))?;
            if squashfs.superblock.inode_count > MAX_INODES {
                return Err(error_json(
                    "invalid_image",
                    json!({ "detail": format!("inode_count {} is implausible", squashfs.superblock.inode_count) }),
                ));
            }
            let sb = superblock_v4(&squashfs.superblock, kind_name);
            let fs = squashfs
                .into_filesystem_reader()
                .map_err(|error| backhand_error(error, kind_name, Some(sb.compression)))?;
            Ok(Opened {
                fs: Box::new(fs),
                sb,
            })
        }
        3 => {
            let squashfs = backhand::v3::squashfs::Squashfs::from_reader_with_offset_and_kind(
                Cursor::new(bytes),
                offset,
                kind,
            )
            .map_err(|error| backhand_error(error, kind_name, Some("gzip")))?;
            if squashfs.superblock.inode_count > MAX_INODES {
                return Err(error_json(
                    "invalid_image",
                    json!({ "detail": format!("inode_count {} is implausible", squashfs.superblock.inode_count) }),
                ));
            }
            let sb = superblock_v3(&squashfs.superblock, kind_name);
            let fs = squashfs
                .into_filesystem_reader()
                .map_err(|error| backhand_error(error, kind_name, Some(sb.compression)))?;
            Ok(Opened {
                fs: Box::new(fs),
                sb,
            })
        }
        major => Err(error_json(
            "unsupported_version",
            json!({ "versionMajor": major, "versionMinor": kind.version_minor() }),
        )),
    }
}

/// Map an upstream error to the shared error envelope. `compressor` names the
/// attempted compressor when known, including before the superblock is fully
/// constructed (a missing decompressor fails inside the parse).
fn backhand_error(
    error: BackhandError,
    kind_name: &'static str,
    compressor: Option<&'static str>,
) -> String {
    use std::io::ErrorKind;
    let code = match &error {
        BackhandError::UnsupportedCompression(_) => "unsupported_compression",
        BackhandError::UnsupportedSquashfsVersion(_, _) => "unsupported_version",
        BackhandError::FileNotFound => "not_found",
        BackhandError::TryReserveError(_) => "allocation_failed",
        BackhandError::MutexPoisoned => "internal",
        BackhandError::StdIo(io) if io.kind() == ErrorKind::UnexpectedEof => "truncated_image",
        BackhandError::StdIo(io) if io.kind() == ErrorKind::Unsupported => {
            "unsupported_compression"
        }
        _ => "invalid_image",
    };
    let mut extra = serde_json::Map::new();
    extra.insert("detail".into(), json!(error.to_string()));
    extra.insert("kind".into(), json!(kind_name));
    if let Some(compressor) = compressor {
        extra.insert("compressor".into(), json!(compressor));
    }
    error_json(code, Value::Object(extra))
}

fn compressor_name(id: u16) -> &'static str {
    match id {
        0 => "none",
        1 => "gzip",
        2 => "lzma",
        3 => "lzo",
        4 => "xz",
        5 => "lz4",
        6 => "zstd",
        _ => "unknown",
    }
}

fn endianness(kind_name: &'static str) -> (&'static str, &'static str) {
    match kind_name {
        "le_v4_0" | "le_v3_0" => ("little", "little"),
        "be_v4_0" | "be_v3_0" => ("big", "big"),
        "avm_be_v4_0" => ("big", "little"),
        _ => ("unknown", "unknown"),
    }
}

fn superblock_v4(
    sb: &backhand::v4::squashfs::SuperBlock,
    kind_name: &'static str,
) -> SuperblockInfo {
    use backhand::v4::compressor::Compressor;
    let compression = compressor_name(sb.compressor as u16);
    let (type_endian, data_endian) = endianness(kind_name);
    SuperblockInfo {
        kind_name,
        magic: sb.magic,
        type_endian,
        data_endian,
        version_major: sb.version_major,
        version_minor: sb.version_minor,
        compression,
        compression_supported: matches!(
            sb.compressor,
            Compressor::Uncompressed | Compressor::Gzip | Compressor::Lz4
        ),
        block_size: sb.block_size,
        block_log: sb.block_log,
        inode_count: sb.inode_count,
        fragment_count: u64::from(sb.frag_count),
        flags: u32::from(sb.flags),
        id_count: u32::from(sb.id_count),
        mod_time: sb.mod_time,
        bytes_used: sb.bytes_used,
        root_inode: sb.root_inode,
    }
}

fn superblock_v3(
    sb: &backhand::v3::squashfs::SuperBlock,
    kind_name: &'static str,
) -> SuperblockInfo {
    let (type_endian, data_endian) = endianness(kind_name);
    SuperblockInfo {
        kind_name,
        magic: sb.magic,
        type_endian,
        data_endian,
        version_major: sb.version_major,
        version_minor: sb.version_minor,
        // v3 images carry no compressor field; plain v3 is zlib/gzip. LZMA
        // v3 images only exist under the lzma kind set, which is not built.
        compression: "gzip",
        compression_supported: true,
        block_size: sb.block_size,
        block_log: sb.block_log,
        inode_count: sb.inode_count,
        fragment_count: u64::from(sb.fragments),
        flags: u32::from(sb.flags),
        id_count: u32::from(sb.no_uids) + u32::from(sb.no_guids),
        mod_time: sb.mkfs_time,
        bytes_used: sb.bytes_used,
        root_inode: sb.root_inode,
    }
}

fn superblock_json(sb: &SuperblockInfo, offset: u64) -> Value {
    json!({
        "schema_version": 1,
        "offset": offset,
        "kind": sb.kind_name,
        "magic": magic_text(sb.magic),
        "typeEndian": sb.type_endian,
        "dataEndian": sb.data_endian,
        "versionMajor": sb.version_major,
        "versionMinor": sb.version_minor,
        "compression": sb.compression,
        "compressionSupported": sb.compression_supported,
        "blockSize": sb.block_size,
        "blockLog": sb.block_log,
        "inodeCount": sb.inode_count,
        "fragmentCount": sb.fragment_count,
        "flags": sb.flags,
        "idCount": sb.id_count,
        "modTime": sb.mod_time,
        "bytesUsed": sb.bytes_used,
        "rootInode": format!("0x{:x}", sb.root_inode),
    })
}

/// Canonicalize a request or filter path to `/a/b` byte form. Parent
/// components are never resolved — `..` is rejected outright.
fn normalize_path(raw: &str) -> Result<Vec<u8>, String> {
    if raw.len() > MAX_PATH_BYTES {
        return Err(error_json(
            "invalid_path",
            json!({ "detail": format!("path exceeds {MAX_PATH_BYTES} bytes") }),
        ));
    }
    let mut out: Vec<u8> = Vec::new();
    for component in raw.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                return Err(error_json(
                    "invalid_path",
                    json!({ "detail": "parent components are not resolved" }),
                ))
            }
            name => {
                out.push(b'/');
                out.extend_from_slice(name.as_bytes());
            }
        }
    }
    if out.is_empty() {
        out.push(b'/');
    }
    Ok(out)
}

/// `filter` selects `path` when it is an exact match or a directory prefix.
fn matches_filter(path: &[u8], filter: &[u8]) -> bool {
    if filter == b"/" {
        return true;
    }
    if path == filter {
        return true;
    }
    path.len() > filter.len() && path.starts_with(filter) && path[filter.len()] == b'/'
}

struct Row {
    path: Vec<u8>,
    entry: Value,
}

fn node_row(node: &BackhandNode) -> Row {
    let path = node.fullpath.as_os_str().as_encoded_bytes().to_vec();
    let mut entry = serde_json::Map::new();
    entry.insert(
        "path".into(),
        json!(String::from_utf8_lossy(&path).into_owned()),
    );
    entry.insert("uid".into(), json!(node.header.uid));
    entry.insert("gid".into(), json!(node.header.gid));
    entry.insert("mtime".into(), json!(node.header.mtime));
    entry.insert(
        "mode".into(),
        json!(format!("{:04o}", node.header.permissions)),
    );
    let (kind, size) = match &node.inner {
        BackhandInnerNode::File(inner) => ("file", inner.file_len() as u64),
        BackhandInnerNode::Symlink { link } => {
            entry.insert(
                "linkTarget".into(),
                json!(String::from_utf8_lossy(link.as_os_str().as_encoded_bytes()).into_owned()),
            );
            ("symlink", 0)
        }
        BackhandInnerNode::Dir => ("dir", 0),
        BackhandInnerNode::CharacterDevice { device_number } => {
            entry.insert("deviceNumber".into(), json!(device_number));
            ("chardev", 0)
        }
        BackhandInnerNode::BlockDevice { device_number } => {
            entry.insert("deviceNumber".into(), json!(device_number));
            ("blockdev", 0)
        }
        BackhandInnerNode::NamedPipe => ("fifo", 0),
        BackhandInnerNode::Socket => ("socket", 0),
    };
    entry.insert("type".into(), json!(kind));
    entry.insert("size".into(), json!(size));
    Row {
        path,
        entry: Value::Object(entry),
    }
}

/// `squashfs_list` implementation.
pub(crate) fn list(bytes: &[u8], options: &ListOptions) -> Result<Value, String> {
    let opened = open(bytes, options.offset)?;
    let filter = match &options.path_filter {
        Some(raw) => Some(normalize_path(raw)?),
        None => None,
    };
    let cap = options.max_results.unwrap_or(MAX_ENTRIES);

    let mut rows: Vec<Row> = Vec::new();
    let mut total_matching = 0usize;
    let mut total_nodes = 0usize;
    for node in opened.fs.files() {
        total_nodes += 1;
        let row = node_row(&node);
        if let Some(filter) = &filter {
            if !matches_filter(&row.path, filter) {
                continue;
            }
        }
        total_matching += 1;
        if rows.len() < cap {
            rows.push(row);
        }
    }
    let truncated = total_matching > rows.len();
    rows.sort_by(|a, b| a.path.cmp(&b.path));

    let mut report = superblock_json(&opened.sb, options.offset);
    let object = report.as_object_mut().unwrap();
    object.insert(
        "entries".into(),
        Value::Array(rows.into_iter().map(|row| row.entry).collect()),
    );
    object.insert("entryCount".into(), json!(total_matching));
    object.insert("imageNodes".into(), json!(total_nodes));
    object.insert("truncated".into(), json!(truncated));
    Ok(report)
}

/// A `std::io::Write` sink that stops the copy at `limit` bytes. The upstream
/// `std::io::copy` loop turns the sentinel error into an early return, so the
/// sink keeps the first `limit` bytes and `overflowed` marks the cut.
struct CappedWriter {
    buf: Vec<u8>,
    limit: usize,
    overflowed: bool,
}

impl Write for CappedWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let room = self.limit.saturating_sub(self.buf.len());
        if bytes.len() <= room {
            self.buf.extend_from_slice(bytes);
            return Ok(bytes.len());
        }
        self.buf.extend_from_slice(&bytes[..room]);
        self.overflowed = true;
        Err(std::io::Error::new(
            std::io::ErrorKind::QuotaExceeded,
            "squashfs extract cap",
        ))
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// `squashfs_extract` implementation. One entry, memory-only, exact path.
pub(crate) fn extract(bytes: &[u8], options: &ExtractOptions) -> Result<Value, String> {
    let opened = open(bytes, options.offset)?;
    let want = normalize_path(&options.path)?;

    let mut found: Option<BackhandNode> = None;
    for node in opened.fs.files() {
        if node.fullpath.as_os_str().as_encoded_bytes() == want.as_slice() {
            found = Some(node);
            break;
        }
    }
    let node = found.ok_or_else(|| {
        error_json(
            "not_found",
            json!({ "path": String::from_utf8_lossy(&want).into_owned() }),
        )
    })?;
    let file = match &node.inner {
        BackhandInnerNode::File(file) => file.clone(),
        other => {
            let kind = match other {
                BackhandInnerNode::Dir => "dir",
                BackhandInnerNode::Symlink { .. } => "symlink",
                BackhandInnerNode::CharacterDevice { .. } => "chardev",
                BackhandInnerNode::BlockDevice { .. } => "blockdev",
                BackhandInnerNode::NamedPipe => "fifo",
                BackhandInnerNode::Socket => "socket",
                BackhandInnerNode::File(_) => unreachable!(),
            };
            return Err(error_json(
                "entry_not_file",
                json!({
                    "path": String::from_utf8_lossy(&want).into_owned(),
                    "entryType": kind,
                }),
            ));
        }
    };

    // Bounds before allocation: the entry's declared size must fit the JSON
    // transport budget unless a preview cap was requested. A preview still
    // never returns more than `max_bytes` bytes.
    let declared = file.file_len() as u64;
    let limit = match options.max_bytes {
        Some(max) => max.min(MAX_CONTENT_BYTES as u64),
        None => {
            if declared > MAX_CONTENT_BYTES as u64 {
                return Err(error_json(
                    "entry_too_large",
                    json!({
                        "declaredSize": declared,
                        "limit": MAX_CONTENT_BYTES,
                        "detail": format!("entry exceeds the JSON transport budget; request a bounded preview with maxBytes (hard entry cap is {MAX_ENTRY_BYTES} bytes)"),
                    }),
                ));
            }
            MAX_CONTENT_BYTES as u64
        }
    };

    let reserve = declared.min(limit).min(64 * 1024) as usize;
    let mut sink = CappedWriter {
        buf: Vec::with_capacity(reserve),
        limit: limit as usize,
        overflowed: false,
    };
    let copy = catch_unwind(AssertUnwindSafe(|| {
        opened.fs.file_data_to_writer(&file, &mut sink)
    }));
    let (data, overflowed) = match copy {
        Ok(Ok(_)) => (sink.buf, sink.overflowed),
        Ok(Err(error)) => {
            if sink.overflowed && options.max_bytes.is_some() {
                (sink.buf, true)
            } else if sink.overflowed {
                // Declared size fit, but the stream produced more: fail closed.
                return Err(error_json(
                    "entry_too_large",
                    json!({ "declaredSize": declared, "limit": limit }),
                ));
            } else {
                return Err(backhand_error(
                    error,
                    opened.sb.kind_name,
                    Some(opened.sb.compression),
                ));
            }
        }
        Err(_panic) => {
            return Err(error_json(
                "internal",
                json!({ "detail": "panic during entry decode" }),
            ))
        }
    };
    let truncated = overflowed || declared > data.len() as u64;

    let sha256 = Sha256::digest(&data);
    let preview_len = data.len().min(64);
    Ok(json!({
        "schema_version": 1,
        "path": String::from_utf8_lossy(&want).into_owned(),
        "type": "file",
        "size": data.len(),
        "declaredSize": declared,
        "mode": format!("{:04o}", node.header.permissions),
        "uid": node.header.uid,
        "gid": node.header.gid,
        "mtime": node.header.mtime,
        "sha256": data_encoding::HEXLOWER.encode(&sha256),
        "truncated": truncated,
        "bytesHex": data_encoding::HEXLOWER.encode(&data[..preview_len]),
        "contentBase64": data_encoding::BASE64.encode(&data),
    }))
}
