//! `pdf_stream_decode` — decode one stream object selected by object id and
//! return bounded decoded bytes as base64 inside JSON, for pulling embedded
//! JavaScript or file payloads for follow-up analysis. Filters lopdf cannot
//! decode are reported explicitly (`unsupported_filter`) rather than silently
//! returning raw data; decoded output is capped before base64 serialization.

use lopdf::{DecompressError, Document, Error, Object};
use serde::Deserialize;
use sha2::Digest;

use crate::{
    base64, clean, name_string, Fail, OpResult, MAX_OUTPUT_BYTES, MAX_STREAM_DECODE_BYTES,
    MAX_STRING_CHARS,
};

#[derive(Default, Deserialize)]
pub(crate) struct StreamOptions {
    /// Required object number.
    #[serde(default)]
    object_id: Option<u32>,
    #[serde(default)]
    generation: Option<u16>,
    #[serde(default)]
    max_output_bytes: Option<usize>,
}

/// Stream filters lopdf decodes. Anything else is reported by name.
const SUPPORTED_FILTERS: &[&[u8]] = &[
    b"FlateDecode",
    b"Fl",
    b"ASCII85Decode",
    b"A85",
    b"ASCIIHexDecode",
    b"AHx",
    b"LZWDecode",
    b"LZW",
    b"RunLengthDecode",
    b"RL",
    b"BrotliDecode",
];

pub(crate) fn run(document: &Document, options: &StreamOptions, _bytes: &[u8]) -> OpResult {
    let object_id = options.object_id.ok_or_else(|| Fail::new("missing_object_id"))?;
    let max_output = options
        .max_output_bytes
        .unwrap_or(MAX_STREAM_DECODE_BYTES)
        .clamp(1, MAX_STREAM_DECODE_BYTES);

    let found = document
        .objects
        .iter()
        .find(|(id, _)| id.0 == object_id && options.generation.map_or(true, |g| id.1 == g));
    let (id, object) = found.ok_or_else(|| {
        Fail::new("object_not_found")
            .with("object_id", serde_json::json!([object_id, options.generation.unwrap_or(0)]))
    })?;

    let stream = match object {
        Object::Stream(stream) => stream,
        _ => {
            return Err(Fail::new("not_a_stream")
                .with("object_id", serde_json::json!([id.0, id.1]))
                .with("kind", object.enum_variant()))
        }
    };

    let raw_filters = stream.filters().unwrap_or_default();
    let filters: Vec<String> = raw_filters
        .iter()
        .map(|name| name_string(name))
        .collect();
    let unsupported: Vec<String> = raw_filters
        .iter()
        .filter(|name| !SUPPORTED_FILTERS.contains(name))
        .map(|name| name_string(name))
        .collect();
    if !unsupported.is_empty() {
        return Err(Fail::new("unsupported_filter")
            .with("object_id", serde_json::json!([id.0, id.1]))
            .with("filters", serde_json::json!(filters))
            .with("unsupported_filters", serde_json::json!(unsupported)));
    }

    let decoded = match stream.decompressed_content_with_limit(max_output) {
        Ok(decoded) => decoded,
        Err(Error::Decompress(DecompressError::MemoryLimitExceeded { .. })) => {
            return Err(Fail::new("decoded_stream_too_large")
                .with("object_id", serde_json::json!([id.0, id.1]))
                .with("decoded_length_limit", max_output)
                .with("encoded_length", stream.content.len()));
        }
        Err(error) => {
            return Err(Fail::new("stream_decode_error")
                .with("object_id", serde_json::json!([id.0, id.1]))
                .with("detail", clean(&error.to_string(), MAX_STRING_CHARS)));
        }
    };

    let sha = sha2::Sha256::digest(&decoded);
    let mut encoded = base64(&decoded);
    let mut delivered_bytes = decoded.len();

    // The JSON output cap is the harder bound: a decoded stream up to 8 MiB
    // base64-expands past 4 MiB, so measure the serialized envelope once and
    // truncate the payload to fit, reporting delivered vs decoded length.
    let meta = |data_b64: &str, truncated: bool, delivered: usize| {
        serde_json::json!({
            "schema_version": 1,
            "object_id": [id.0, id.1],
            "type": stream.dict.get_type().ok().map(|name| name_string(name)),
            "subtype": stream.dict.get(b"Subtype").ok()
                .and_then(|value| value.as_name().ok())
                .map(|name| name_string(name)),
            "filters": filters,
            "encoded_length": stream.content.len(),
            "decoded_length": decoded.len(),
            "decoded_sha256": crate::hex(&sha),
            "delivered_bytes": delivered,
            "truncated": truncated,
            "data_base64": data_b64,
        })
    };
    let mut value = meta(&encoded, false, delivered_bytes);
    if serde_json::to_string(&value).map_or(usize::MAX, |j| j.len()) > MAX_OUTPUT_BYTES {
        let overhead = serde_json::to_string(&meta("", true, 0))
            .map(|j| j.len())
            .unwrap_or(512)
            + 64;
        let budget = MAX_OUTPUT_BYTES.saturating_sub(overhead);
        let chars = budget / 4 * 4;
        encoded.truncate(chars.min(encoded.len()));
        let padding = encoded.bytes().rev().take_while(|b| *b == b'=').count();
        delivered_bytes = encoded.len() / 4 * 3 - padding;
        value = meta(&encoded, true, delivered_bytes);
        if serde_json::to_string(&value).map_or(usize::MAX, |j| j.len()) > MAX_OUTPUT_BYTES {
            return Err(Fail::new("output_too_large"));
        }
    }
    Ok(value)
}
