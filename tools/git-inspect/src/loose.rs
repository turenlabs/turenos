//! Loose object decode: one zlib stream containing `type SP size NUL content`.
//! The object's identity is the SHA-1 over the full inflated bytes; the
//! declared size is cross-checked against the produced bytes.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::object;
use crate::zlib::inflate_bounded;
use crate::{hex_encode, Report, MAX_OBJECT_BYTES, MAX_PREVIEW_BYTES};

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct DecodeOptions {
    #[serde(alias = "max_preview_bytes")]
    max_preview_bytes: Option<usize>,
}

impl DecodeOptions {
    fn preview_limit(&self) -> usize {
        self.max_preview_bytes
            .unwrap_or(8192)
            .min(MAX_PREVIEW_BYTES)
    }
}

/// Parse an inflated `type SP size NUL` header, returning (type, declared
/// size, content offset). Loose-object headers are small; search only the
/// first 64 bytes. Shared with `identify` for loose-object classification.
pub(crate) fn parse_header(data: &[u8]) -> Result<(String, u64, usize), &'static str> {
    let window = data.len().min(64);
    let nul = data[..window]
        .iter()
        .position(|b| *b == 0)
        .ok_or("not_loose_object")?;
    let space = data[..nul]
        .iter()
        .position(|b| *b == b' ')
        .ok_or("not_loose_object")?;
    let kind = std::str::from_utf8(&data[..space])
        .ok()
        .filter(|k| !k.is_empty() && k.len() <= 16 && k.bytes().all(|b| b.is_ascii_alphanumeric()))
        .ok_or("not_loose_object")?;
    let size = std::str::from_utf8(&data[space + 1..nul])
        .ok()
        .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|s| s.parse::<u64>().ok())
        .ok_or("not_loose_object")?;
    Ok((kind.to_string(), size, nul + 1))
}

/// `git_object_decode`: inflate a loose object and report its structured
/// fields plus the recomputed object id.
pub(crate) fn decode(
    bytes: &[u8],
    options: &DecodeOptions,
    report: &mut Report,
) -> Result<Value, &'static str> {
    // A zlib stream starts with a deflate CMF/FLG pair whose check bits hold.
    if bytes.len() < 2
        || bytes[0] & 0x0f != 8
        || (bytes[0] as usize * 256 + bytes[1] as usize) % 31 != 0
    {
        return Err("not_loose_object");
    }
    let inflated = inflate_bounded(bytes, MAX_OBJECT_BYTES)?;
    let (kind, declared, content_offset) = parse_header(&inflated.data)?;
    let content = &inflated.data[content_offset.min(inflated.data.len())..];
    let size_matches = content.len() as u64 == declared;
    if !size_matches {
        report.warnings.push(format!(
            "declared size {declared} differs from inflated content {}",
            content.len()
        ));
    }
    if !inflated.complete {
        report.truncated = true;
        report.warnings.push(format!(
            "object exceeds {} byte limit; content truncated",
            MAX_OBJECT_BYTES
        ));
    }
    let trailing = if inflated.complete {
        bytes.len() - inflated.consumed
    } else {
        0
    };
    if trailing > 0 {
        report
            .warnings
            .push(format!("{trailing} trailing bytes after zlib stream"));
    }
    let details = object::describe(&kind, content, options.preview_limit(), report);
    Ok(json!({
        "schema_version": 1,
        "kind": "loose-object",
        "type": kind,
        "declaredSize": declared,
        "contentBytes": content.len(),
        "sizeMatchesDeclared": size_matches,
        "inflatedBytes": inflated.data.len(),
        "decompressionComplete": inflated.complete,
        "sha1": hex_encode(&crate::sha1_bytes(&inflated.data)),
        "trailingBytes": trailing,
        "content": details,
        "warnings": report.warnings,
        "truncated": report.truncated,
    }))
}
