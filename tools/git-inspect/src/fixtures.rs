//! Test fixture builders: fabricate loose objects, packfiles (including
//! ofs-delta/ref-delta chains), pack indexes, DIRC indexes, and bundles in
//! test code — no git binary or repository needed.

use flate2::write::ZlibEncoder;
use flate2::Compression;
use std::io::Write;

pub fn zlib(data: &[u8]) -> Vec<u8> {
    let mut enc = ZlibEncoder::new(Vec::new(), Compression::new(6));
    enc.write_all(data).unwrap();
    enc.finish().unwrap()
}

pub fn loose(kind: &str, content: &[u8]) -> Vec<u8> {
    zlib(&object_bytes(kind, content))
}

pub fn object_bytes(kind: &str, content: &[u8]) -> Vec<u8> {
    let mut raw = format!("{kind} {}\0", content.len()).into_bytes();
    raw.extend_from_slice(content);
    raw
}

pub fn sha1(data: &[u8]) -> [u8; 20] {
    crate::sha1_bytes(data)
}

pub fn object_id(kind: &str, content: &[u8]) -> [u8; 20] {
    crate::sha1_bytes_prefixed(kind, content)
}

// ---- pack building -------------------------------------------------------

pub enum PackEntry {
    /// (kind, resolved content) — a base object.
    Full(u8, Vec<u8>),
    /// (base entry index, delta payload) — ofs-delta.
    OfsDelta(usize, Vec<u8>),
    /// (base object id, delta payload) — ref-delta.
    RefDelta([u8; 20], Vec<u8>),
}

pub fn pack_entry_header(kind: u8, size: u64) -> Vec<u8> {
    let mut out = Vec::new();
    let mut first = ((kind & 7) << 4) | (size as u8 & 0x0f);
    let mut rest = size >> 4;
    if rest > 0 {
        first |= 0x80;
    }
    out.push(first);
    while rest > 0 {
        let mut byte = (rest as u8) & 0x7f;
        rest >>= 7;
        if rest > 0 {
            byte |= 0x80;
        }
        out.push(byte);
    }
    out
}

/// Git's offset varint (with the +1 carry): most significant group first.
pub fn offset_varint(mut value: u64) -> Vec<u8> {
    let mut out = vec![(value & 0x7f) as u8];
    value >>= 7;
    while value > 0 {
        value -= 1;
        out.push(((value & 0x7f) as u8) | 0x80);
        value >>= 7;
    }
    out.reverse();
    out
}

/// Delta-payload varint: little-endian 7-bit groups, MSB continuation.
pub fn delta_varint(mut value: u64) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value > 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if value == 0 {
            return out;
        }
    }
}

/// A copy-from-base delta opcode.
pub fn copy_op(offset: usize, size: usize) -> Vec<u8> {
    assert!(size > 0 && size <= 0xffffff);
    let mut cmd = 0x80u8;
    let mut tail = Vec::new();
    let offset_b = (offset as u32).to_le_bytes();
    for (i, b) in offset_b.iter().enumerate() {
        if *b != 0 {
            cmd |= 1 << i;
            tail.push(*b);
        }
    }
    let size_b = (size as u32).to_le_bytes();
    for i in 0..3 {
        if size_b[i] != 0 {
            cmd |= 0x10 << i;
            tail.push(size_b[i]);
        }
    }
    let mut out = vec![cmd];
    out.extend(tail);
    out
}

/// A literal-insert delta opcode (payload <= 127 bytes per opcode).
pub fn insert_op(data: &[u8]) -> Vec<u8> {
    assert!(!data.is_empty() && data.len() <= 127);
    let mut out = vec![data.len() as u8];
    out.extend_from_slice(data);
    out
}

/// Build a delta payload transforming `base` into `result` via ops.
pub fn delta(base_len: usize, result_len: usize, ops: &[u8]) -> Vec<u8> {
    let mut out = delta_varint(base_len as u64);
    out.extend(delta_varint(result_len as u64));
    out.extend_from_slice(ops);
    out
}

/// Assemble a packfile from entries; `pack` computes a correct trailer,
/// `pack_with_trailer` allows overriding it for corruption tests.
pub fn pack(entries: &[PackEntry]) -> Vec<u8> {
    pack_with_trailer(entries, None)
}

pub fn pack_with_trailer(entries: &[PackEntry], trailer: Option<[u8; 20]>) -> Vec<u8> {
    let mut out = b"PACK".to_vec();
    out.extend_from_slice(&2u32.to_be_bytes());
    out.extend_from_slice(&(entries.len() as u32).to_be_bytes());
    let mut offsets = Vec::new();
    for entry in entries {
        offsets.push(out.len() as u64);
        match entry {
            PackEntry::Full(kind, data) => {
                out.extend(pack_entry_header(*kind, data.len() as u64));
                out.extend(zlib(data));
            }
            PackEntry::OfsDelta(base, payload) => {
                let distance = out.len() as u64 - offsets[*base];
                out.extend(pack_entry_header(6, payload.len() as u64));
                out.extend(offset_varint(distance));
                out.extend(zlib(payload));
            }
            PackEntry::RefDelta(sha, payload) => {
                out.extend(pack_entry_header(7, payload.len() as u64));
                out.extend_from_slice(sha);
                out.extend(zlib(payload));
            }
        }
    }
    let trailer = trailer.unwrap_or_else(|| sha1(&out));
    out.extend_from_slice(&trailer);
    out
}

// ---- pack index ----------------------------------------------------------

pub fn pack_index_v2(shas: &[[u8; 20]]) -> Vec<u8> {
    let mut sorted = shas.to_vec();
    sorted.sort();
    let mut out = vec![0xff, 0x74, 0x4f, 0x63];
    out.extend_from_slice(&2u32.to_be_bytes());
    let mut cursor = 0usize;
    for byte in 0..256u32 {
        while cursor < sorted.len() && sorted[cursor][0] as u32 <= byte {
            cursor += 1;
        }
        out.extend_from_slice(&(cursor as u32).to_be_bytes());
    }
    for sha in &sorted {
        out.extend_from_slice(sha);
    }
    for _ in &sorted {
        out.extend_from_slice(&0u32.to_be_bytes()); // crc32
    }
    for (i, _) in sorted.iter().enumerate() {
        out.extend_from_slice(&(12u32 + i as u32).to_be_bytes()); // pack offset
    }
    out.extend_from_slice(&sha1(b"pack")); // pack checksum
    let sum = sha1(&out);
    out.extend_from_slice(&sum); // index checksum
    out
}

pub fn pack_index_v1(shas: &[[u8; 20]]) -> Vec<u8> {
    let mut sorted = shas.to_vec();
    sorted.sort();
    let mut out = Vec::new();
    let mut cursor = 0usize;
    for byte in 0..256u32 {
        while cursor < sorted.len() && sorted[cursor][0] as u32 <= byte {
            cursor += 1;
        }
        out.extend_from_slice(&(cursor as u32).to_be_bytes());
    }
    for (i, sha) in sorted.iter().enumerate() {
        out.extend_from_slice(&(i as u32).to_be_bytes()); // offset
        out.extend_from_slice(sha);
    }
    out
}

// ---- index (DIRC) --------------------------------------------------------

pub struct DircEntry {
    pub path: &'static str,
    pub sha: [u8; 20],
    pub mode: u32,
    pub stage: u8,
    pub size: u32,
    /// v3+ extended flags word (skip-worktree 0x4000, intent-to-add 0x2000).
    pub ext_flags: u16,
}

pub fn dirc_entry(path: &'static str, sha: [u8; 20], mode: u32) -> DircEntry {
    DircEntry {
        path,
        sha,
        mode,
        stage: 0,
        size: 0,
        ext_flags: 0,
    }
}

/// Build a v2 or v3 index. `extensions` are (4-byte name, payload).
pub fn dirc_v23(version: u32, entries: &[DircEntry], extensions: &[(&[u8; 4], Vec<u8>)]) -> Vec<u8> {
    let mut out = b"DIRC".to_vec();
    out.extend_from_slice(&version.to_be_bytes());
    out.extend_from_slice(&(entries.len() as u32).to_be_bytes());
    for e in entries {
        for value in [
            1_700_000_000u32, // ctime s
            123_456_789,      // ctime ns
            1_700_000_100,    // mtime s
            987_654_321,      // mtime ns
            0x8001,           // dev
            0xdead,           // ino
            e.mode,
            501, // uid
            20,  // gid
            e.size,
        ] {
            out.extend_from_slice(&value.to_be_bytes());
        }
        out.extend_from_slice(&e.sha);
        let namelen = e.path.len().min(0xfff) as u16;
        let has_ext = version >= 3 && e.ext_flags != 0;
        let flags = ((e.stage as u16) << 12) | namelen | if has_ext { 0x4000 } else { 0 };
        out.extend_from_slice(&flags.to_be_bytes());
        if has_ext {
            out.extend_from_slice(&e.ext_flags.to_be_bytes());
        }
        out.extend_from_slice(e.path.as_bytes());
        // 1-8 NUL pad bytes so the entry length is a multiple of 8.
        let fixed = 62 + if has_ext { 2 } else { 0 };
        let pad = 8 - (fixed + e.path.len()) % 8;
        out.resize(out.len() + pad, 0);
    }
    for (name, payload) in extensions {
        out.extend_from_slice(*name);
        out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        out.extend_from_slice(payload);
    }
    let sum = sha1(&out);
    out.extend_from_slice(&sum);
    out
}

/// Build a v4 index with prefix-compressed paths.
pub fn dirc_v4(entries: &[DircEntry]) -> Vec<u8> {
    let mut out = b"DIRC".to_vec();
    out.extend_from_slice(&4u32.to_be_bytes());
    out.extend_from_slice(&(entries.len() as u32).to_be_bytes());
    let mut prev: &[u8] = b"";
    for e in entries {
        for value in [
            1_700_000_000u32,
            123_456_789,
            1_700_000_100,
            987_654_321,
            0x8001,
            0xdead,
            e.mode,
            501,
            20,
            e.size,
        ] {
            out.extend_from_slice(&value.to_be_bytes());
        }
        out.extend_from_slice(&e.sha);
        let namelen = e.path.len().min(0xfff) as u16;
        out.extend_from_slice(&namelen.to_be_bytes());
        let common = prev
            .iter()
            .zip(e.path.as_bytes())
            .take_while(|(a, b)| a == b)
            .count();
        out.extend(offset_varint((prev.len() - common) as u64));
        out.extend_from_slice(&e.path.as_bytes()[common..]);
        out.push(0);
        prev = e.path.as_bytes();
    }
    let sum = sha1(&out);
    out.extend_from_slice(&sum);
    out
}

pub fn bundle() -> Vec<u8> {
    let mut out = b"# v2 git bundle\n".to_vec();
    out.extend_from_slice(b"-0123456789012345678901234567890123456789 base commit\n");
    out.extend_from_slice(b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/heads/main\n");
    out.extend_from_slice(b"\n");
    out.extend(pack(&[PackEntry::Full(3, b"hello".to_vec())]));
    out
}
