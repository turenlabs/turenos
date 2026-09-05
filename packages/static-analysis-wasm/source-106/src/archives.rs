//! Byte-only archive extensions. ZIP and uncompressed tar stay in the parent module.
//! No archive pathname is ever opened. Unsupported codecs/encryption fail closed.
//! 7z's upstream metadata/dictionary allocations require a fresh WASM worker with
//! a verified 256 MiB linear-memory maximum and 30-second timeout. This is not a
//! native hostile-input API. Encoded 7z headers are rejected before upstream parsing
//! because they decompress before entry callbacks and cannot share our byte quota.
//!
//! Supported 7z subset: plain headers, one Copy/LZMA/LZMA2 codec per folder,
//! including solid folders, with dictionaries <=16 MiB and total expansion <=64 MiB.
//! This is not full 7-Zip support: encoded headers (common in default-created 7z),
//! encryption, filter chains/BCJ2 and other codecs fail closed. RAR, bzip2 and xz
//! containers are unsupported; no full 7-Zip or restricted RAR implementation ships.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read, Write};

const INPUT: usize = 32 * 1024 * 1024;
const JSON_LIMIT: usize = 4 * 1024 * 1024;
const ENTRY: usize = 8 * 1024 * 1024;
const EXPANSION: usize = 64 * 1024 * 1024;
const COUNT: usize = 4096;
const NAME: usize = 4096;

/// Recognizes extension formats, including formats with explicit unsupported errors.
/// Recognition is not a promise that an encrypted or unsupported variant can decode.
pub fn supports(bytes: &[u8]) -> bool {
    [
        b"7z\xbc\xaf\x27\x1c".as_slice(),
        b"Rar!",
        b"\x1f\x8b",
        b"BZh",
        b"\xfd7zXZ\0",
        b"!<arch>\n",
        b"!<thin>\n",
        b"070701",
        b"070702",
        b"070707",
    ]
    .iter()
    .any(|magic| bytes.starts_with(magic))
}

pub fn extra_list(bytes: &[u8], _options: &Value) -> Result<Value, String> {
    inspect(bytes, None)
}

pub fn extra_extract(bytes: &[u8], options: &Value) -> Result<Value, String> {
    let index = option(options, "index", 0, 0, COUNT - 1)?;
    let limit = option(options, "maxOutputBytes", ENTRY, 1, ENTRY)?;
    inspect(bytes, Some((index, limit)))
}

fn sevenz(bytes: &[u8], selection: Option<(usize, usize)>) -> Result<Value, String> {
    sevenz_header(bytes)?;
    let mut reader = sevenz_rust::SevenZReader::new(
        Cursor::new(bytes),
        bytes.len() as u64,
        sevenz_rust::Password::empty(),
    )
    .map_err(|e| format!("invalid or unsupported 7z archive: {e}"))?;
    let archive = reader.archive();
    if archive.files.len() > COUNT || archive.folders.len() > COUNT {
        return Err("7z exceeds 4096 entries/folders".into());
    }
    let mut expanded = 0u64;
    for folder in &archive.folders {
        // One linear codec avoids BCJ2's eager side-stream materialization and
        // cyclic/multi-coder graphs. Solid LZMA/LZMA2 folders remain supported.
        if folder.coders.len() != 1
            || folder.total_input_streams != 1
            || folder.total_output_streams != 1
        {
            return Err("7z multi-coder/filter graphs are unsupported".into());
        }
        let coder = &folder.coders[0];
        match coder.decompression_method_id() {
            [0] => {}
            [3, 1, 1] if coder.properties.len() == 5 => {
                let dictionary = u32::from_le_bytes(coder.properties[1..5].try_into().unwrap());
                if dictionary > 16 * 1024 * 1024 {
                    return Err("7z LZMA dictionary exceeds 16 MiB".into());
                }
            }
            [0x21] if coder.properties.len() == 1 && coder.properties[0] <= 24 => {}
            [6, 0xf1, 7, 1] => return Err("encrypted 7z archives are unsupported".into()),
            _ => return Err("unsupported 7z codec or dictionary size".into()),
        }
        expanded = expanded
            .checked_add(folder.get_unpack_size())
            .ok_or("7z expansion size overflow")?;
        if expanded > EXPANSION as u64 {
            return Err("7z archive exceeds 64 MiB expansion budget".into());
        }
    }
    let mut names = 0;
    let mut entries = Vec::new();
    for (index, file) in archive.files.iter().enumerate() {
        let filename = name(file.name.as_bytes())?;
        names += filename.len();
        if names > (JSON_LIMIT - COUNT * 160 - 1024) / 6 {
            return Err("7z names exceed JSON output budget".into());
        }
        entries.push(json!({"index": index, "name": filename, "size": file.size,
            "compressedSize": file.compressed_size, "encrypted": false, "directory": file.is_directory}));
    }
    let Some((index, limit)) = selection else {
        return bounded(json!({"format":"7z", "count": entries.len(), "entries":entries}));
    };
    let file = archive
        .files
        .get(index)
        .ok_or("archive entry index not found")?;
    let unix_type = (file.windows_attributes >> 16) & 0o170000;
    if file.is_directory
        || file.is_anti_item
        || (file.has_windows_attributes
            && (file.windows_attributes & 0x400 != 0 || (unix_type != 0 && unix_type != 0o100000)))
    {
        return Err("only regular archive members can be extracted".into());
    }
    if file.size > limit as u64 {
        return Err("entry exceeds maxOutputBytes".into());
    }
    if (file.size as usize).div_ceil(3) * 4 + NAME * 6 + 1024 > JSON_LIMIT {
        return Err("selected entry exceeds 4 MiB JSON output budget".into());
    }
    // The pinned reader invokes callbacks with references into archive.files,
    // but visits empty entries after folders. Pointer identity preserves listing
    // indexes even for duplicate names and reordered empty entries; no dereference.
    let target = file as *const sevenz_rust::SevenZArchiveEntry;
    let filename = name(file.name.as_bytes())?;
    let mut remaining = EXPANSION;
    let mut selected = None;
    let mut calls = 0;
    reader
        .for_each_entries(|entry, stream| {
            calls += 1;
            if calls > COUNT {
                return Err(sevenz_rust::Error::other("7z exceeds 4096 decoded entries"));
            }
            let chosen = std::ptr::eq(entry, target);
            let mut data = Vec::new();
            let mut size = 0usize;
            let mut chunk = [0; 8192];
            loop {
                let length = chunk.len().min(remaining.saturating_add(1));
                let read = stream
                    .read(&mut chunk[..length])
                    .map_err(sevenz_rust::Error::io)?;
                if read == 0 {
                    break;
                }
                if read > remaining {
                    return Err(sevenz_rust::Error::other(
                        "7z exceeds 64 MiB expansion budget",
                    ));
                }
                remaining -= read;
                size += read;
                if size as u64 > entry.size || (chosen && size > limit) {
                    return Err(sevenz_rust::Error::other(
                        "7z entry exceeds declared size or maxOutputBytes",
                    ));
                }
                if chosen {
                    data.extend_from_slice(&chunk[..read]);
                }
            }
            if size as u64 != entry.size {
                return Err(sevenz_rust::Error::other("truncated 7z entry"));
            }
            if chosen {
                selected = Some(data);
            }
            Ok(true)
        })
        .map_err(|e| format!("7z decompression failed: {e}"))?;
    let data = selected.ok_or("7z selected entry was not decoded")?;
    bounded(
        json!({"format":"7z", "index":index, "name":filename, "size":data.len(),
        "sha256":hex::encode(Sha256::digest(&data)), "bytesHex":hex::encode(&data[..data.len().min(64)]),
        "contentBase64":super::base64(&data)}),
    )
}

fn sevenz_header(bytes: &[u8]) -> Result<(), String> {
    let signature = range(bytes, 0, 32)?;
    if signature[6] != 0 {
        return Err("unsupported 7z major version".into());
    }
    let start_crc = u32::from_le_bytes(signature[8..12].try_into().unwrap());
    if crc32fast::hash(&signature[12..32]) != start_crc {
        return Err("7z start-header checksum mismatch".into());
    }
    let offset = u64::from_le_bytes(signature[12..20].try_into().unwrap());
    let size = u64::from_le_bytes(signature[20..28].try_into().unwrap());
    let offset = usize::try_from(offset)
        .map_err(|_| "7z header offset overflow")?
        .checked_add(32)
        .ok_or("7z header offset overflow")?;
    let size = usize::try_from(size).map_err(|_| "7z header size overflow")?;
    if size == 0 {
        return Err("7z archive has no next header".into());
    }
    let header = range(bytes, offset, size)?;
    if crc32fast::hash(header) != u32::from_le_bytes(signature[28..32].try_into().unwrap()) {
        return Err("7z next-header checksum mismatch".into());
    }
    if header[0] != 1 {
        return Err(
            "encoded or encrypted 7z headers are unsupported by the bounded decoder".into(),
        );
    }
    Ok(())
}

fn option(
    options: &Value,
    key: &str,
    default: usize,
    min: usize,
    max: usize,
) -> Result<usize, String> {
    let Some(value) = options.get(key) else {
        return Ok(default);
    };
    let value = value
        .as_u64()
        .ok_or_else(|| format!("{key} must be an unsigned integer"))?;
    if value < min as u64 || value > max as u64 {
        return Err(format!("{key} must be between {min} and {max}"));
    }
    Ok(value as usize)
}

struct Member<'a> {
    name: String,
    data: &'a [u8],
    directory: bool,
    regular: bool,
}

fn inspect(bytes: &[u8], selection: Option<(usize, usize)>) -> Result<Value, String> {
    if bytes.len() > INPUT {
        return Err("archive input exceeds 32 MiB".into());
    }
    if bytes.starts_with(b"Rar!") {
        return Err("RAR archives are unsupported; no restricted RAR decoder is bundled".into());
    }
    if bytes.starts_with(b"7z\xbc\xaf\x27\x1c") {
        return sevenz(bytes, selection);
    }
    if bytes.starts_with(b"BZh") || bytes.starts_with(b"\xfd7zXZ\0") {
        return Err("bzip2/xz archives are unsupported by this decoder".into());
    }
    if bytes.starts_with(b"!<thin>\n") {
        return Err("thin ar archives reference external files and are unsupported".into());
    }
    let expanded;
    let (format, members) = if bytes.starts_with(b"\x1f\x8b") {
        expanded = expand(flate2::read::MultiGzDecoder::new(bytes), EXPANSION)?;
        ("tar.gz", tar_members(&expanded)?)
    } else if bytes.starts_with(b"!<arch>\n") {
        ("ar", ar_members(bytes)?)
    } else if bytes.starts_with(b"070701")
        || bytes.starts_with(b"070702")
        || bytes.starts_with(b"070707")
    {
        ("cpio", cpio_members(bytes)?)
    } else {
        return Err("unrecognized archive format".into());
    };
    if let Some((index, limit)) = selection {
        let member = members.get(index).ok_or("archive entry index not found")?;
        if !member.regular {
            return Err("only regular archive members can be extracted".into());
        }
        if member.data.len() > limit {
            return Err("entry exceeds maxOutputBytes".into());
        }
        // Base64 expands by 4/3; leave room for the name, digest and envelope before allocation.
        if member.data.len().div_ceil(3) * 4 + NAME * 6 + 1024 > JSON_LIMIT {
            return Err("selected entry exceeds 4 MiB JSON output budget".into());
        }
        return bounded(json!({
            "format": format, "index": index, "name": member.name,
            "size": member.data.len(), "sha256": hex::encode(Sha256::digest(member.data)),
            "bytesHex": hex::encode(&member.data[..member.data.len().min(64)]),
            "contentBase64": super::base64(member.data),
        }));
    }
    let entries = members.iter().enumerate().map(|(index, member)| json!({
        "index": index, "name": member.name, "size": member.data.len(), "directory": member.directory,
    })).collect::<Vec<_>>();
    bounded(json!({ "format": format, "entries": entries }))
}

// Count serialized bytes without first creating an unbounded JSON string.
fn bounded(value: Value) -> Result<Value, String> {
    struct Budget(usize);
    impl Write for Budget {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self
                .0
                .checked_sub(bytes.len())
                .ok_or_else(|| std::io::Error::other("archive JSON output exceeds 4 MiB"))?;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    // Reserve the parent envelope's fixed fields and an error-free warnings array.
    serde_json::to_writer(Budget(JSON_LIMIT - 1024), &value).map_err(|e| e.to_string())?;
    Ok(value)
}

fn expand(mut reader: impl Read, limit: usize) -> Result<Vec<u8>, String> {
    let mut data = Vec::new();
    let mut chunk = [0; 8192];
    loop {
        let available = limit.saturating_sub(data.len());
        let length = chunk.len().min(available.saturating_add(1));
        let read = reader
            .read(&mut chunk[..length])
            .map_err(|e| format!("archive decompression failed: {e}"))?;
        if read == 0 {
            return Ok(data);
        }
        if read > available {
            return Err("archive decompression exceeds expansion budget".into());
        }
        data.extend_from_slice(&chunk[..read]);
    }
}

fn name(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() > NAME {
        return Err("archive member name exceeds 4096 bytes".into());
    }
    Ok(super::clean(&String::from_utf8_lossy(bytes)))
}

fn push<'a>(
    members: &mut Vec<Member<'a>>,
    member: Member<'a>,
    names: &mut usize,
) -> Result<(), String> {
    if members.len() >= COUNT {
        return Err("archive exceeds 4096 entries".into());
    }
    *names += member.name.len();
    // Worst-case JSON escaping is six bytes per source byte; bound before Value allocation.
    if *names > (JSON_LIMIT - COUNT * 128 - 1024) / 6 {
        return Err("archive names exceed JSON output budget".into());
    }
    members.push(member);
    Ok(())
}

fn range(bytes: &[u8], offset: usize, size: usize) -> Result<&[u8], String> {
    bytes
        .get(offset..offset.checked_add(size).ok_or("archive offset overflow")?)
        .ok_or_else(|| "truncated archive member".into())
}

fn number(bytes: &[u8], radix: u32) -> Result<usize, String> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "invalid archive numeric field")?
        .trim();
    usize::from_str_radix(text, radix)
        .map_err(|_| "invalid or overflowing archive numeric field".into())
}

fn aligned(value: usize, alignment: usize) -> Result<usize, String> {
    value
        .checked_add(alignment - 1)
        .map(|n| n / alignment * alignment)
        .ok_or_else(|| "archive alignment overflow".into())
}

fn tar_members(bytes: &[u8]) -> Result<Vec<Member<'_>>, String> {
    if bytes.len() < 1024 || bytes.len() % 512 != 0 {
        return Err("gzip payload is not a complete tar archive".into());
    }
    let mut archive = tar::Archive::new(Cursor::new(bytes));
    let mut members = Vec::new();
    let mut names = 0;
    let mut end = 0;
    // Raw iteration never materializes GNU longname/PAX payloads or sparse extents.
    for entry in archive.entries().map_err(|e| e.to_string())?.raw(true) {
        let file = entry.map_err(|e| e.to_string())?;
        let kind = file.header().entry_type();
        if !(kind.is_file() || kind.is_dir() || kind.is_symlink() || kind.is_hard_link()) {
            return Err("tar extensions, sparse entries and special files are unsupported".into());
        }
        let offset =
            usize::try_from(file.raw_file_position()).map_err(|_| "tar offset overflow")?;
        let size = usize::try_from(file.size()).map_err(|_| "tar size overflow")?;
        end = aligned(offset.checked_add(size).ok_or("tar size overflow")?, 512)?;
        push(
            &mut members,
            Member {
                name: name(&file.path_bytes())?,
                data: range(bytes, offset, size)?,
                directory: kind.is_dir(),
                regular: kind.is_file(),
            },
            &mut names,
        )?;
    }
    let trailer = bytes.get(end..).ok_or("truncated tar padding")?;
    if trailer.len() < 1024 || trailer.iter().any(|byte| *byte != 0) {
        return Err("tar must end with two zero blocks and zero padding".into());
    }
    Ok(members)
}

fn ar_members(bytes: &[u8]) -> Result<Vec<Member<'_>>, String> {
    let mut members = Vec::new();
    let mut offset = 8;
    let mut names = 0;
    let mut longnames: &[u8] = &[];
    let mut headers = 0;
    while offset < bytes.len() {
        headers += 1;
        if headers > COUNT {
            return Err("ar exceeds 4096 headers".into());
        }
        let header = range(bytes, offset, 60)?;
        if &header[58..60] != b"`\n" {
            return Err("invalid ar header terminator".into());
        }
        let size = number(&header[48..58], 10)?;
        let mut data = range(bytes, offset + 60, size)?;
        let raw = std::str::from_utf8(&header[..16])
            .map_err(|_| "invalid ar name")?
            .trim_end();
        offset = aligned(offset + 60 + size, 2)?;
        if offset > bytes.len() {
            return Err("missing ar alignment byte".into());
        }
        if raw == "//" {
            longnames = data;
            continue;
        }
        if raw == "/" || raw == "/SYM64/" {
            continue;
        }
        let filename = if let Some(length) = raw.strip_prefix("#1/") {
            let length = number(length.as_bytes(), 10)?;
            let filename = name(
                range(data, 0, length)?
                    .split(|b| *b == 0)
                    .next()
                    .unwrap_or_default(),
            )?;
            data = &data[length..];
            filename
        } else if let Some(position) = raw.strip_prefix('/') {
            let position = number(position.as_bytes(), 10)?;
            let tail = longnames
                .get(position..)
                .ok_or("invalid ar long-name offset")?;
            let end = tail
                .iter()
                .position(|b| *b == b'\n')
                .ok_or("unterminated ar long name")?;
            name(tail[..end].strip_suffix(b"/").unwrap_or(&tail[..end]))?
        } else {
            name(raw.strip_suffix('/').unwrap_or(raw).as_bytes())?
        };
        push(
            &mut members,
            Member {
                name: filename,
                data,
                directory: false,
                regular: true,
            },
            &mut names,
        )?;
    }
    Ok(members)
}

fn cpio_members(bytes: &[u8]) -> Result<Vec<Member<'_>>, String> {
    let mut offset = 0;
    let mut members = Vec::new();
    let mut names = 0;
    loop {
        let magic = range(bytes, offset, 6)?;
        let (header_size, mode, links, size, name_size, alignment, checksum) = match magic {
            b"070701" | b"070702" => {
                let header = range(bytes, offset, 110)?;
                (
                    110,
                    number(&header[14..22], 16)?,
                    number(&header[38..46], 16)?,
                    number(&header[54..62], 16)?,
                    number(&header[94..102], 16)?,
                    4,
                    if magic == b"070702" {
                        Some(number(&header[102..110], 16)?)
                    } else {
                        None
                    },
                )
            }
            b"070707" => {
                let header = range(bytes, offset, 76)?;
                (
                    76,
                    number(&header[18..24], 8)?,
                    number(&header[36..42], 8)?,
                    number(&header[65..76], 8)?,
                    number(&header[59..65], 8)?,
                    1,
                    None,
                )
            }
            _ => return Err("unsupported or malformed cpio header".into()),
        };
        if name_size == 0 || name_size > NAME + 1 {
            return Err("invalid cpio name length".into());
        }
        let raw_name = range(bytes, offset + header_size, name_size)?;
        if raw_name.last() != Some(&0) || raw_name[..name_size - 1].contains(&0) {
            return Err("invalid cpio name terminator".into());
        }
        let data_offset = aligned(offset + header_size + name_size, alignment)?;
        let data = range(bytes, data_offset, size)?;
        offset = aligned(data_offset + size, alignment)?;
        if offset > bytes.len() {
            return Err("missing cpio alignment bytes".into());
        }
        if let Some(checksum) = checksum {
            let actual = data
                .iter()
                .fold(0u32, |sum, byte| sum.wrapping_add(*byte as u32));
            if checksum as u64 != actual as u64 {
                return Err("cpio checksum mismatch".into());
            }
        }
        if &raw_name[..name_size - 1] == b"TRAILER!!!" {
            if size != 0 || bytes[offset..].iter().any(|b| *b != 0) {
                return Err("invalid cpio trailer".into());
            }
            return Ok(members);
        }
        let kind = mode & 0o170000;
        push(
            &mut members,
            Member {
                name: name(&raw_name[..name_size - 1])?,
                data,
                directory: kind == 0o040000,
                // Hard-link data placement varies between cpio variants. Never return a misleading empty file.
                regular: kind == 0o100000 && links <= 1,
            },
            &mut names,
        )?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ar(data: &[u8]) -> Vec<u8> {
        let mut bytes = b"!<arch>\n".to_vec();
        bytes.extend_from_slice(
            format!(
                "{:<16}{:<12}{:<6}{:<6}{:<8}{:<10}`\n",
                "hello.txt/",
                0,
                0,
                0,
                "100644",
                data.len()
            )
            .as_bytes(),
        );
        bytes.extend_from_slice(data);
        if data.len() % 2 != 0 {
            bytes.push(b'\n');
        }
        bytes
    }

    fn cpio_entry(bytes: &mut Vec<u8>, filename: &str, data: &[u8], crc: bool) {
        bytes.extend_from_slice(if crc { b"070702" } else { b"070701" });
        for field in [
            1,
            0o100644,
            0,
            0,
            1,
            0,
            data.len(),
            0,
            0,
            0,
            0,
            filename.len() + 1,
            if crc {
                data.iter().map(|b| *b as usize).sum()
            } else {
                0
            },
        ] {
            bytes.extend_from_slice(format!("{field:08x}").as_bytes());
        }
        bytes.extend_from_slice(filename.as_bytes());
        bytes.push(0);
        while bytes.len() % 4 != 0 {
            bytes.push(0);
        }
        bytes.extend_from_slice(data);
        while bytes.len() % 4 != 0 {
            bytes.push(0);
        }
    }

    #[test]
    fn valid_ar_and_cpio_extract_compatible_json() {
        let mut cpio = Vec::new();
        cpio_entry(&mut cpio, "hello.txt", b"hello", true);
        cpio_entry(&mut cpio, "TRAILER!!!", b"", true);
        for bytes in [ar(b"hello"), cpio] {
            assert!(supports(&bytes));
            let list = extra_list(&bytes, &json!({})).unwrap();
            assert_eq!(
                list["entries"][0],
                json!({"index":0,"name":"hello.txt","size":5,"directory":false})
            );
            let result = extra_extract(&bytes, &json!({"index":0,"maxOutputBytes":5})).unwrap();
            assert_eq!(result["contentBase64"], "aGVsbG8=");
            assert_eq!(result["bytesHex"], "68656c6c6f");
            assert_eq!(result["sha256"], hex::encode(Sha256::digest(b"hello")));
            assert!(extra_extract(&bytes, &json!({"maxOutputBytes":4})).is_err());
            assert!(extra_extract(&bytes, &json!({"index":1})).is_err());
        }
    }

    #[test]
    fn valid_gzip_tar_and_stream_budget() {
        let mut tar = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_ustar();
        header.set_size(5);
        header.set_mode(0o644);
        header.set_cksum();
        tar.append_data(&mut header, "hello.txt", &b"hello"[..])
            .unwrap();
        let tar = tar.into_inner().unwrap();
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gzip.write_all(&tar).unwrap();
        let gzip = gzip.finish().unwrap();
        assert_eq!(
            extra_extract(&gzip, &json!({})).unwrap()["contentBase64"],
            "aGVsbG8="
        );
        assert_eq!(extra_list(&gzip, &json!({})).unwrap()["format"], "tar.gz");
        assert!(expand(flate2::read::MultiGzDecoder::new(&gzip[..]), tar.len() - 1).is_err());
        assert_eq!(
            expand(flate2::read::MultiGzDecoder::new(&gzip[..]), tar.len()).unwrap(),
            tar
        );
        assert!(extra_list(&gzip[..gzip.len() - 1], &json!({})).is_err());
    }

    fn sevenz_fixture(codec: &[u8], packed: &[u8], unpacked: u64) -> Vec<u8> {
        let mut header = vec![1, 4, 6, 0, 1, 9, packed.len() as u8, 0, 7, 11, 1, 0, 1];
        header.extend_from_slice(codec);
        header.push(12);
        // Full-width 7z uint64 encoding keeps the fixture useful for size limits.
        header.push(0xff);
        header.extend_from_slice(&unpacked.to_le_bytes());
        header.extend_from_slice(&[0, 8, 0, 0, 5, 1, 17, 21, 0]);
        for unit in "hello.txt\0".encode_utf16() {
            header.extend_from_slice(&unit.to_le_bytes());
        }
        header.extend_from_slice(&[0, 0]);
        sevenz_container(&header, packed)
    }

    fn sevenz_container(header: &[u8], packed: &[u8]) -> Vec<u8> {
        let mut bytes = b"7z\xbc\xaf\x27\x1c\x00\x04".to_vec();
        let mut start = (packed.len() as u64).to_le_bytes().to_vec();
        start.extend_from_slice(&(header.len() as u64).to_le_bytes());
        start.extend_from_slice(&crc32fast::hash(header).to_le_bytes());
        bytes.extend_from_slice(&crc32fast::hash(&start).to_le_bytes());
        bytes.extend_from_slice(&start);
        bytes.extend_from_slice(packed);
        bytes.extend_from_slice(header);
        bytes
    }

    #[test]
    fn real_compressed_lzma_and_lzma2() {
        // Independent Python stdlib lzma FORMAT_RAW fixtures: dictionary=4096,
        // LZMA1 lc=3/lp=0/pb=2; input b"hello world " * 100.
        let expected = b"hello world ".repeat(100);
        for (codec, packed) in [
            (
                &[0x21, 0x21, 1, 0][..],
                "e004af00195d00341949ee8de917893a335ffd827c64d39cabf2370191e3870000",
            ),
            (
                &[0x23, 3, 1, 1, 5, 0x5d, 0, 0x10, 0, 0][..],
                "00341949ee8de917893a335ffd827c64d39cabf2370192f0194fffff85ae0000",
            ),
        ] {
            let packed = hex::decode(packed).unwrap();
            let bytes = sevenz_fixture(codec, &packed, expected.len() as u64);
            let result = extra_extract(&bytes, &json!({})).unwrap();
            assert_eq!(result["size"], expected.len());
            assert_eq!(result["contentBase64"], super::super::base64(&expected));
            assert_eq!(result["sha256"], hex::encode(Sha256::digest(&expected)));
            assert!(extra_extract(&bytes, &json!({"maxOutputBytes":1199})).is_err());
            let truncated =
                sevenz_fixture(codec, &packed[..packed.len() / 2], expected.len() as u64);
            assert!(extra_extract(&truncated, &json!({})).is_err());
        }
    }

    #[test]
    fn solid_7z_preserves_duplicate_name_indexes() {
        let packed = b"\x01\x00\x09helloworld\x00";
        let mut header = vec![
            1,
            4,
            6,
            0,
            1,
            9,
            packed.len() as u8,
            0,
            7,
            11,
            1,
            0,
            1,
            0x21,
            0x21,
            1,
            0,
            12,
            10,
            0,
            8,
            13,
            2,
            9,
            5,
            0,
            0,
            5,
            2,
            17,
            41,
            0,
        ];
        for unit in "hello.txt\0hello.txt\0".encode_utf16() {
            header.extend_from_slice(&unit.to_le_bytes());
        }
        header.extend_from_slice(&[0, 0]);
        let bytes = sevenz_container(&header, packed);
        assert_eq!(extra_list(&bytes, &json!({})).unwrap()["count"], 2);
        assert_eq!(
            extra_extract(&bytes, &json!({"index":0})).unwrap()["contentBase64"],
            "aGVsbG8="
        );
        assert_eq!(
            extra_extract(&bytes, &json!({"index":1})).unwrap()["contentBase64"],
            "d29ybGQ="
        );
    }

    #[test]
    fn valid_7z_copy_and_lzma2_and_rejected_headers() {
        // LZMA2 uncompressed chunk, dictionary reset, five bytes, end marker.
        for bytes in [
            sevenz_fixture(&[1, 0], b"hello", 5),
            sevenz_fixture(&[0x21, 0x21, 1, 0], b"\x01\x00\x04hello\x00", 5),
        ] {
            let list = extra_list(&bytes, &json!({})).unwrap();
            assert_eq!(list["entries"][0]["name"], "hello.txt");
            assert_eq!(list["count"], 1);
            assert_eq!(
                extra_extract(&bytes, &json!({})).unwrap()["contentBase64"],
                "aGVsbG8="
            );
            assert!(extra_extract(&bytes, &json!({"maxOutputBytes":4})).is_err());
        }
        let encrypted = sevenz_fixture(&[4, 6, 0xf1, 7, 1], b"hello", 5);
        assert!(extra_list(&encrypted, &json!({}))
            .unwrap_err()
            .contains("encrypted"));
        let huge = sevenz_fixture(&[1, 0], b"hello", EXPANSION as u64 + 1);
        assert!(extra_list(&huge, &json!({}))
            .unwrap_err()
            .contains("expansion budget"));
        let encoded = sevenz_container(&[0x17, 0], &[]);
        assert!(extra_list(&encoded, &json!({}))
            .unwrap_err()
            .contains("encoded"));
        let mut bad_crc = sevenz_fixture(&[1, 0], b"hello", 5);
        bad_crc[8] ^= 1;
        assert!(extra_list(&bad_crc, &json!({}))
            .unwrap_err()
            .contains("checksum"));
    }

    #[test]
    fn valid_odc_and_ar_long_names() {
        let mut odc = Vec::new();
        for (filename, data) in [
            ("hello.txt", b"hello".as_slice()),
            ("TRAILER!!!", b"".as_slice()),
        ] {
            odc.extend_from_slice(
                format!(
                    "070707{:06o}{:06o}{:06o}{:06o}{:06o}{:06o}{:06o}{:011o}{:06o}{:011o}",
                    0,
                    1,
                    0o100644,
                    0,
                    0,
                    1,
                    0,
                    0,
                    filename.len() + 1,
                    data.len()
                )
                .as_bytes(),
            );
            odc.extend_from_slice(filename.as_bytes());
            odc.push(0);
            odc.extend_from_slice(data);
        }
        assert_eq!(
            extra_extract(&odc, &json!({})).unwrap()["contentBase64"],
            "aGVsbG8="
        );
        let filename = "a-long-member-name.txt";
        let mut bsd = b"!<arch>\n".to_vec();
        bsd.extend_from_slice(
            format!(
                "{:<16}{:<12}{:<6}{:<6}{:<8}{:<10}`\n",
                format!("#1/{}", filename.len()),
                0,
                0,
                0,
                "100644",
                filename.len() + 5
            )
            .as_bytes(),
        );
        bsd.extend_from_slice(filename.as_bytes());
        bsd.extend_from_slice(b"hello");
        if bsd.len() % 2 != 0 {
            bsd.push(b'\n');
        }
        let result = extra_extract(&bsd, &json!({})).unwrap();
        assert_eq!(result["name"], filename);
        assert_eq!(result["contentBase64"], "aGVsbG8=");
    }

    #[test]
    fn rejects_real_gzip_bomb_and_encryption_flag() {
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        for _ in 0..=EXPANSION / 8192 {
            gzip.write_all(&[0; 8192]).unwrap();
        }
        let mut gzip = gzip.finish().unwrap();
        assert!(extra_list(&gzip, &json!({}))
            .unwrap_err()
            .contains("expansion budget"));
        gzip[3] |= 0x20;
        assert!(extra_extract(&gzip, &json!({})).is_err());
        assert!(extra_list(&vec![0; INPUT + 1], &json!({})).is_err());
    }

    #[test]
    fn rejects_malformed_unsupported_and_limits() {
        for bytes in [
            b"Rar!encrypted".as_slice(),
            b"7z\xbc\xaf\x27\x1cencrypted",
            b"!<thin>\n",
            b"070701",
            b"\x1f\x8b",
            b"BZh9",
            b"\xfd7zXZ\0",
        ] {
            assert!(supports(bytes));
            assert!(extra_list(bytes, &json!({})).is_err());
            assert!(extra_extract(bytes, &json!({})).is_err());
        }
        assert!(!supports(b"PK\x03\x04"));
        let mut bytes = b"!<arch>\n".to_vec();
        for _ in 0..=COUNT {
            bytes.extend_from_slice(&ar(b"")[8..]);
        }
        assert!(extra_list(&bytes, &json!({})).is_err());
        assert!(extra_extract(&ar(b"hello"), &json!({"index":4294967296u64})).is_err());
        assert!(extra_extract(&ar(b"hello"), &json!({"maxOutputBytes":0})).is_err());
        assert!(extra_extract(&ar(&vec![0; JSON_LIMIT]), &json!({})).is_err());
        let mut cpio = Vec::new();
        cpio_entry(&mut cpio, "hello.txt", b"hello", true);
        cpio_entry(&mut cpio, "TRAILER!!!", b"", true);
        cpio[124] ^= 1;
        assert!(extra_list(&cpio, &json!({})).is_err());
    }
}
