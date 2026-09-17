//! `git_identify`: classify one file's bytes as a loose object, packfile,
//! pack index (v1/v2), index (DIRC), bundle, or unknown — using magic bytes,
//! structural checks, and a bounded probe inflate.

use serde_json::{json, Value};

use crate::loose;
use crate::zlib::inflate_bounded;
use crate::{hex_encode, u32_be, Report, IDENTIFY_INFLATE_CAP};

pub(crate) fn identify(bytes: &[u8], report: &mut Report) -> Result<Value, &'static str> {
    if bytes.len() >= 4 && &bytes[..4] == b"PACK" {
        return Ok(identify_pack(bytes));
    }
    if bytes.len() >= 8 && bytes[..4] == [0xff, 0x74, 0x4f, 0x63] {
        return Ok(identify_pack_index_v2(bytes));
    }
    if bytes.len() >= 4 && &bytes[..4] == b"DIRC" {
        return Ok(identify_index(bytes));
    }
    if let Some(bundle) = identify_bundle(bytes) {
        return Ok(bundle);
    }
    if let Some(v1) = identify_pack_index_v1(bytes) {
        return Ok(v1);
    }
    if let Some(loose) = identify_loose(bytes, report) {
        return Ok(loose);
    }
    Ok(json!({
        "schema_version": 1,
        "kind": "unknown",
        "byteLength": bytes.len(),
        "warnings": report.warnings,
    }))
}

fn identify_pack(bytes: &[u8]) -> Value {
    let mut out = json!({
        "schema_version": 1,
        "kind": "pack",
        "byteLength": bytes.len(),
    });
    if bytes.len() >= 12 {
        out["version"] = json!(u32_be(bytes, 4));
        out["declaredObjects"] = json!(u32_be(bytes, 8));
    }
    if bytes.len() >= 32 {
        let body_end = bytes.len() - 20;
        out["trailerSha1"] = json!(hex_encode(&bytes[body_end..]));
        out["trailerSha1Valid"] = json!(crate::sha1_bytes(&bytes[..body_end]) == bytes[body_end..]);
    }
    out
}

/// Pack index v2: magic, version, 256-entry fanout, then N sha1s, N crc32s,
/// N offsets, optional 8-byte large offsets, pack sha1, index sha1.
fn identify_pack_index_v2(bytes: &[u8]) -> Value {
    let mut out = json!({
        "schema_version": 1,
        "kind": "pack-index",
        "byteLength": bytes.len(),
    });
    if bytes.len() < 8 + 256 * 4 {
        out["truncated"] = json!(true);
        return out;
    }
    out["version"] = json!(u32_be(bytes, 4));
    let count = u32_be(bytes, 8 + 255 * 4) as usize;
    out["objectCount"] = json!(count);
    // expected = magic+version+fanout + N*(sha1+crc+off) + pack sha1 + idx sha1
    let expected = 8usize
        .saturating_add(256 * 4)
        .saturating_add(count.saturating_mul(28))
        .saturating_add(40);
    out["expectedBytes"] = json!(expected);
    out["sizeMatches"] = json!(bytes.len() == expected);
    if bytes.len() > expected && (bytes.len() - expected) % 8 == 0 {
        out["largeOffsetCount"] = json!((bytes.len() - expected) / 8);
    }
    if bytes.len() >= expected {
        let pack_sha = &bytes[bytes.len() - 40..bytes.len() - 20];
        out["packSha1"] = json!(hex_encode(pack_sha));
        out["indexSha1"] = json!(hex_encode(&bytes[bytes.len() - 20..]));
        out["indexSha1Valid"] =
            json!(crate::sha1_bytes(&bytes[..bytes.len() - 20]) == bytes[bytes.len() - 20..]);
    }
    out
}

/// Pack index v1 has no magic: it is exactly a 256-entry big-endian fanout
/// table followed by N (offset, sha1) pairs and no trailer. The fanout must be
/// monotonically non-decreasing and the file length must match exactly.
fn identify_pack_index_v1(bytes: &[u8]) -> Option<Value> {
    if bytes.len() < 1024 + 24 || bytes.len() % 4 != 0 {
        return None;
    }
    let mut previous = 0u32;
    for i in 0..256 {
        let value = u32_be(bytes, i * 4);
        if value < previous {
            return None;
        }
        previous = value;
    }
    let count = previous as usize;
    if 1024usize.saturating_add(count.saturating_mul(24)) != bytes.len() {
        return None;
    }
    Some(json!({
        "schema_version": 1,
        "kind": "pack-index",
        "version": 1,
        "objectCount": count,
        "byteLength": bytes.len(),
        "sizeMatches": true,
    }))
}

fn identify_index(bytes: &[u8]) -> Value {
    let mut out = json!({
        "schema_version": 1,
        "kind": "index",
        "byteLength": bytes.len(),
    });
    if bytes.len() >= 12 {
        out["version"] = json!(u32_be(bytes, 4));
        out["declaredEntries"] = json!(u32_be(bytes, 8));
    }
    if bytes.len() >= 32 {
        let body_end = bytes.len() - 20;
        out["trailerSha1Valid"] =
            json!(crate::sha1_bytes(&bytes[..body_end]) == bytes[body_end..]);
    }
    out
}

/// Bundle files start with a `# vN git bundle` line, then `-sha1 comment`
/// prerequisites and `sha1 name` refs, then the pack bytes.
fn identify_bundle(bytes: &[u8]) -> Option<Value> {
    if bytes.len() < 16 || !bytes.starts_with(b"# v") {
        return None;
    }
    let first_end = bytes.iter().position(|b| *b == b'\n')?;
    let first = std::str::from_utf8(&bytes[..first_end]).ok()?;
    let version = first
        .strip_prefix("# v")
        .and_then(|rest| rest.strip_suffix(" git bundle"))
        .and_then(|v| v.parse::<u32>().ok())
        .filter(|v| (1..=3).contains(v))?;
    // Scan header lines until the PACK payload or a non-conforming line.
    let mut pos = first_end + 1;
    let mut prerequisites = 0usize;
    let mut refs = 0usize;
    let mut pack_follows = false;
    while pos < bytes.len() && pos < first_end + 1 + 64 * 1024 {
        let line_end = bytes[pos..]
            .iter()
            .position(|b| *b == b'\n')
            .map(|at| pos + at)
            .unwrap_or(bytes.len());
        let line = &bytes[pos..line_end];
        if line.starts_with(b"PACK") {
            pack_follows = true;
            break;
        }
        if line.first() == Some(&b'-') && line.len() >= 41 {
            prerequisites += 1;
        } else if line.len() > 41
            && line[..40].iter().all(|b| b.is_ascii_hexdigit())
            && line[40] == b' '
        {
            refs += 1;
        } else if line.is_empty() {
            // tolerate a blank separator
        } else {
            break;
        }
        if line_end == bytes.len() {
            break;
        }
        pos = line_end + 1;
    }
    Some(json!({
        "schema_version": 1,
        "kind": "bundle",
        "version": version,
        "prerequisites": prerequisites,
        "refs": refs,
        "packFollows": pack_follows,
        "byteLength": bytes.len(),
    }))
}

/// Loose objects are zlib streams whose inflated bytes begin with a
/// `type SP size NUL` header. Probe with a bounded inflate.
fn identify_loose(bytes: &[u8], _report: &mut Report) -> Option<Value> {
    if bytes.len() < 2
        || bytes[0] & 0x0f != 8
        || (bytes[0] as usize * 256 + bytes[1] as usize) % 31 != 0
    {
        return None;
    }
    let inflated = inflate_bounded(bytes, IDENTIFY_INFLATE_CAP).ok()?;
    let (kind, declared, content_offset) = loose::parse_header(&inflated.data).ok()?;
    let trailing = if inflated.complete {
        bytes.len().saturating_sub(inflated.consumed)
    } else {
        0
    };
    Some(json!({
        "schema_version": 1,
        "kind": "loose-object",
        "objectType": kind,
        "declaredSize": declared,
        "inflatedBytes": inflated.data.len().saturating_sub(content_offset),
        "probeBytes": inflated.data.len(),
        "decompressionComplete": inflated.complete,
        "trailingBytes": trailing,
        "byteLength": bytes.len(),
    }))
}
