//! `rtf_objects` — embedded OLE object enumeration. Each `{\object}` group
//! reports its objclass, declared dimensions, `\objdata` decode summary
//! (decoded size, SHA-256, first-16-bytes preview, OLE compound-magic
//! detection, decode errors), and `{\result}` rendering-data presence. Full
//! payload hex is returned only when the decoded payload is ≤ 64 KiB and the
//! caller passes `include_payload_hex`.

use serde::Deserialize;
use serde_json::json;

use crate::rtf::Doc;
use crate::{hex, OpResult, MAX_INLINE_PAYLOAD_BYTES, MAX_RESULTS};

const DEFAULT_MAX_RESULTS: usize = 1024;

#[derive(Default, Deserialize)]
pub(crate) struct ObjectsOptions {
    #[serde(default)]
    max_results: Option<usize>,
    #[serde(default)]
    include_payload_hex: Option<bool>,
}

pub(crate) fn run(doc: &Doc, options: &ObjectsOptions, _bytes: &[u8]) -> OpResult {
    let max_results = options
        .max_results
        .unwrap_or(DEFAULT_MAX_RESULTS)
        .clamp(1, MAX_RESULTS);
    let include_payload = options.include_payload_hex.unwrap_or(false);

    let mut rows = Vec::new();
    for (index, o) in doc.objects.iter().take(max_results).enumerate() {
        let objdata = match o.objdata.as_ref() {
            Some(od) => {
                let payload_hex = if include_payload
                    && od.keep_complete
                    && od.keep.len() <= MAX_INLINE_PAYLOAD_BYTES
                {
                    serde_json::Value::String(hex(&od.keep))
                } else {
                    serde_json::Value::Null
                };
                json!({
                    "present": true,
                    "hex_chars": od.hex_chars,
                    "decoded_bytes": od.decoded_bytes,
                    "sha256": od.sha256,
                    "preview_hex": od.preview_hex,
                    "ole_magic": od.ole_magic,
                    "bad_chars": od.bad_chars,
                    "first_bad_offset": od.first_bad_offset,
                    "odd_hex": od.odd_hex,
                    "payload_retained": od.keep_complete,
                    "payload_hex": payload_hex,
                })
            }
            None => json!({ "present": false }),
        };
        let result = match o.result {
            Some((start, end)) => json!({
                "present": true,
                "offset": start,
                "end": end,
                "bytes": end.saturating_sub(start),
                "contains_pict": doc
                    .picts
                    .iter()
                    .any(|p| p.offset >= start && p.offset < end),
            }),
            None => json!({ "present": false }),
        };
        rows.push(json!({
            "index": index,
            "offset": o.offset,
            "end": o.end,
            "type": o.objtype,
            "update": o.update,
            "declared_w": o.w,
            "declared_h": o.h,
            "scale_x": o.scalex,
            "scale_y": o.scaley,
            "objclass": o.objclass,
            "objdata": objdata,
            "result": result,
        }));
    }

    Ok(json!({
        "schema_version": 1,
        "object_count": doc.objects_total,
        "returned": rows.len(),
        "objects": rows,
        "warnings": doc.warnings,
        "truncated": doc.objects.len() < doc.objects_total || rows.len() < doc.objects.len(),
    }))
}
