//! `pdf_objects` — bounded object table with type, stream, filter, and
//! suspicious-key metadata per object. Selection by `object_id`/`generation`
//! or filtering by `type` (`/Type` name) and `kind` (object variant).

use lopdf::{Document, Dictionary, Object, ObjectId};
use serde::Deserialize;
use std::collections::BTreeSet;

use crate::{
    clean, name_string, Fail, OpResult, MAX_KEY_LIST, MAX_RESULTS, MAX_SCAN_DEPTH, MAX_SCAN_NODES,
    MAX_STRING_CHARS, MAX_SUSPICIOUS_KEYS_PER_OBJECT,
};

#[derive(Default, Deserialize)]
pub(crate) struct ObjectsOptions {
    #[serde(default)]
    object_id: Option<u32>,
    #[serde(default)]
    generation: Option<u16>,
    /// Case-insensitive match against the object's `/Type` name.
    #[serde(default, rename = "type")]
    type_filter: Option<String>,
    /// Case-insensitive match against the object variant (for example
    /// `stream`, `dictionary`, `array`, `name`, `string`, `reference`).
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    max_results: Option<usize>,
}

/// Suspicious keys surfaced per object — mirrors `inspect.rs`, kept as a flat
/// name set so the object table can answer "which objects look dangerous".
const SUSPICIOUS: &[&[u8]] = &[
    b"JavaScript",
    b"JS",
    b"OpenAction",
    b"AA",
    b"Launch",
    b"URI",
    b"SubmitForm",
    b"RichMedia",
    b"EmbeddedFile",
    b"EmbeddedFiles",
    b"AcroForm",
    b"XFA",
    b"Names",
    b"Encrypt",
];

pub(crate) fn run(document: &Document, options: &ObjectsOptions, _bytes: &[u8]) -> OpResult {
    let max_results = options
        .max_results
        .unwrap_or(MAX_RESULTS)
        .clamp(1, MAX_RESULTS);
    let type_filter = options.type_filter.as_deref().map(|f| f.to_lowercase());
    let kind_filter = options.kind.as_deref().map(|f| f.to_lowercase());

    let mut selected: Vec<(ObjectId, &Object)> = Vec::new();
    let mut matched_total = 0usize;
    if let Some(object_id) = options.object_id {
        let generation = options.generation;
        let found = document
            .objects
            .iter()
            .find(|(id, _)| id.0 == object_id && generation.map_or(true, |g| id.1 == g));
        match found {
            Some((id, object)) => {
                selected.push((*id, object));
                matched_total = 1;
            }
            None => {
                return Err(Fail::new("object_not_found").with(
                    "object_id",
                    serde_json::json!([object_id, generation.unwrap_or(0)]),
                ))
            }
        }
    } else {
        for (id, object) in document.objects.iter() {
            if !matches_filters(object, &type_filter, &kind_filter) {
                continue;
            }
            matched_total += 1;
            if selected.len() < max_results {
                selected.push((*id, object));
            }
        }
    }

    let mut rows = Vec::new();
    let mut suspicious_cap_hit = false;
    for (id, object) in selected.iter().take(max_results) {
        let (type_name, subtype, keys, stream_length, filters) = describe(object);
        let mut suspicious = BTreeSet::new();
        let mut budget = MAX_SCAN_NODES;
        collect_suspicious(object, 0, &mut budget, &mut suspicious);
        if suspicious.len() > MAX_SUSPICIOUS_KEYS_PER_OBJECT {
            suspicious_cap_hit = true;
        }
        let suspicious: Vec<String> = suspicious
            .into_iter()
            .take(MAX_SUSPICIOUS_KEYS_PER_OBJECT)
            .collect();
        rows.push(serde_json::json!({
            "object_id": [id.0, id.1],
            "kind": object.enum_variant(),
            "type": type_name,
            "subtype": subtype,
            "stream": matches!(object, Object::Stream(_)),
            "stream_length": stream_length,
            "filters": filters,
            "keys": keys,
            "suspicious_keys": suspicious,
        }));
    }

    let total = document.objects.len();
    Ok(serde_json::json!({
        "schema_version": 1,
        "object_count": total,
        "returned": rows.len(),
        "matched": matched_total,
        "objects": rows,
        "truncated": matched_total > rows.len() || suspicious_cap_hit,
    }))
}

fn matches_filters(
    object: &Object,
    type_filter: &Option<String>,
    kind_filter: &Option<String>,
) -> bool {
    if let Some(kind) = kind_filter {
        if object.enum_variant().to_lowercase() != *kind {
            return false;
        }
    }
    if let Some(want) = type_filter {
        let dict = match object {
            Object::Dictionary(dict) => Some(dict),
            Object::Stream(stream) => Some(&stream.dict),
            _ => None,
        };
        let type_name = dict.and_then(|d| d.get_type().ok());
        match type_name {
            Some(name) if String::from_utf8_lossy(name).to_lowercase() == *want => {}
            _ => return false,
        }
    }
    true
}

fn describe(
    object: &Object,
) -> (
    Option<String>,
    Option<String>,
    Vec<String>,
    Option<usize>,
    Vec<String>,
) {
    let dict: Option<&Dictionary> = match object {
        Object::Dictionary(dict) => Some(dict),
        Object::Stream(stream) => Some(&stream.dict),
        _ => None,
    };
    let name_of = |key: &[u8]| -> Option<String> {
        dict.and_then(|d| d.get(key).ok())
            .and_then(|value| value.as_name().ok())
            .map(|name| clean(&String::from_utf8_lossy(name), MAX_STRING_CHARS))
    };
    let keys = dict
        .map(|d| {
            d.iter()
                .take(MAX_KEY_LIST)
                .map(|(key, _)| name_string(key))
                .collect()
        })
        .unwrap_or_default();
    let (stream_length, filters) = match object {
        Object::Stream(stream) => (
            Some(stream.content.len()),
            stream
                .filters()
                .map(|filters| {
                    filters
                        .iter()
                        .take(MAX_KEY_LIST)
                        .map(|filter| name_string(filter))
                        .collect()
                })
                .unwrap_or_default(),
        ),
        _ => (None, Vec::new()),
    };
    (name_of(b"Type"), name_of(b"Subtype"), keys, stream_length, filters)
}

/// Bounded DFS collecting suspicious key names inside one object; references
/// are never followed.
fn collect_suspicious(
    object: &Object,
    depth: usize,
    budget: &mut usize,
    out: &mut BTreeSet<String>,
) {
    if depth > MAX_SCAN_DEPTH || *budget == 0 || out.len() >= MAX_SUSPICIOUS_KEYS_PER_OBJECT {
        return;
    }
    *budget -= 1;
    let dict = match object {
        Object::Dictionary(dict) => Some(dict),
        Object::Stream(stream) => Some(&stream.dict),
        _ => None,
    };
    if let Some(dict) = dict {
        for (key, value) in dict.iter() {
            if *budget == 0 || out.len() >= MAX_SUSPICIOUS_KEYS_PER_OBJECT {
                return;
            }
            *budget -= 1;
            if SUSPICIOUS.contains(&key.as_slice()) {
                out.insert(name_string(key));
            }
            collect_suspicious(value, depth + 1, budget, out);
        }
        return;
    }
    if let Object::Array(items) = object {
        for item in items.iter() {
            if *budget == 0 || out.len() >= MAX_SUSPICIOUS_KEYS_PER_OBJECT {
                return;
            }
            collect_suspicious(item, depth + 1, budget, out);
        }
    }
}
