//! Bounded plist decoding (binary `bplist00` or XML)
//! through the `plist` crate's streaming event reader. Events are consumed
//! iteratively — the parser never materializes a recursive `Value` tree — so
//! hostile nesting cannot overflow the call stack; depth caps replace
//! subtrees with explicit markers and per-container item caps omit the
//! remainder while keeping the parsed prefix.

use serde::Deserialize;
use std::io::Cursor;

use crate::{
    clean, clamp_limit, hex_preview, sha256_hex, Envelope, Fail, MAX_PLIST_DEPTH,
    MAX_PLIST_EVENTS, MAX_PLIST_ITEMS, MAX_STRING_CHARS,
};

#[derive(Deserialize, Default)]
pub(crate) struct PlistOptions {
    pub(crate) max_depth: Option<u64>,
    pub(crate) max_items: Option<u64>,
    pub(crate) max_string_chars: Option<u64>,
}

#[derive(Default)]
struct Counts {
    dictionaries: u64,
    arrays: u64,
    strings: u64,
    integers: u64,
    reals: u64,
    booleans: u64,
    dates: u64,
    datas: u64,
    uids: u64,
}

impl Counts {
    fn total(&self) -> u64 {
        self.dictionaries
            + self.arrays
            + self.strings
            + self.integers
            + self.reals
            + self.booleans
            + self.dates
            + self.datas
            + self.uids
    }
}

/// One open container on the explicit conversion stack. `pruned` marks a
/// frame whose entire subtree is replaced by a depth-cap marker — events are
/// still consumed to stay in sync, but nothing is stored.
enum Frame {
    Array {
        items: Vec<serde_json::Value>,
        expected: Option<u64>,
        pruned: bool,
        omitted: u64,
    },
    Dict {
        map: serde_json::Map<String, serde_json::Value>,
        pending_key: Option<String>,
        expected: Option<u64>,
        pruned: bool,
        omitted: u64,
    },
}

impl Frame {
    fn pruned(&self) -> bool {
        match self {
            Frame::Array { pruned, .. } | Frame::Dict { pruned, .. } => *pruned,
        }
    }

}

/// The wire format sniffed before parsing; mirrors `Reader`'s detection.
pub(crate) fn looks_like_xml_plist(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(512)];
    let head = match head {
        [0xef, 0xbb, 0xbf, rest @ ..] => rest,
        [0xfe, 0xff, ..] | [0xff, 0xfe, ..] => &head[2..],
        _ => head,
    };
    let mut head = head;
    while let Some((&first, rest)) = head.split_first() {
        if first.is_ascii_whitespace() {
            head = rest;
        } else {
            break;
        }
    }
    head.starts_with(b"<") && contains_plist_tag(head)
}

fn contains_plist_tag(head: &[u8]) -> bool {
    head.windows(6).any(|w| w == b"<plist") || head.starts_with(b"<?xml")
}

fn detect_format(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"bplist") { "binary" } else { "xml" }
}

/// Bounded decode of an embedded plist blob (used by `ds_store` for
/// `bwsp`/`lsvp`/`lsvP`/`icvp` values). Returns the root JSON value under a
/// tighter 16-level / 256-item cap so nested documents stay small.
pub(crate) fn embedded_plist(bytes: &[u8]) -> Option<serde_json::Value> {
    if bytes.len() > 4 * 1024 * 1024 {
        return None;
    }
    let options = PlistOptions {
        max_depth: Some(16),
        max_items: Some(256),
        max_string_chars: Some(512),
    };
    let mut envelope = Envelope::new("plist");
    let report = run(bytes, &options, &mut envelope).ok()?;
    report.get("root").cloned()
}

pub(crate) fn run(
    bytes: &[u8],
    options: &PlistOptions,
    envelope: &mut Envelope,
) -> Result<serde_json::Value, Fail> {
    let max_depth = clamp_limit(options.max_depth, MAX_PLIST_DEPTH, MAX_PLIST_DEPTH);
    let max_items = clamp_limit(options.max_items, MAX_PLIST_ITEMS, MAX_PLIST_ITEMS);
    let max_string = clamp_limit(options.max_string_chars, MAX_STRING_CHARS, MAX_STRING_CHARS);

    // Only the two real encodings are accepted: binary `bplist` and XML
    // `<plist`. Anything else is rejected up front so arbitrary text is not
    // reported as a bare-string plist.
    if !bytes.starts_with(b"bplist") && !looks_like_xml_plist(bytes) {
        return Err(Fail::new("invalid_plist"));
    }

    let mut reader = plist::stream::Reader::new(Cursor::new(bytes));
    let mut stack: Vec<Frame> = Vec::new();
    let mut counts = Counts::default();
    let mut root: Option<serde_json::Value> = None;
    let mut events: u64 = 0;
    let mut depth_seen: usize = 0;
    let mut strings_truncated: u64 = 0;
    let mut items_omitted: u64 = 0;

    loop {
        events += 1;
        if events > MAX_PLIST_EVENTS {
            envelope.truncated = true;
            envelope
                .warn(format!("event stream truncated at {MAX_PLIST_EVENTS} events"));
            break;
        }
        let event = match reader.next() {
            Some(Ok(event)) => event,
            Some(Err(_)) if root.is_none() && stack.is_empty() => {
                return Err(Fail::new("invalid_plist"));
            }
            Some(Err(error)) => {
                envelope.truncated = true;
                envelope.warn(format!("event stream ended early: {error}"));
                break;
            }
            None => break,
        };

        use plist::stream::Event as Ev;
        match event {
            Ev::StartArray(expected) | Ev::StartDictionary(expected) => {
                let is_dict = matches!(event, Ev::StartDictionary(_));
                if is_dict {
                    counts.dictionaries += 1;
                } else {
                    counts.arrays += 1;
                }
                let depth = stack.len();
                depth_seen = depth_seen.max(depth + 1);
                // Prune when this container exceeds the depth cap or sits
                // inside an already-pruned subtree.
                let prune = stack.last().map(|f| f.pruned()).unwrap_or(false)
                    || depth >= max_depth;
                if prune && !stack.last().map(|f| f.pruned()).unwrap_or(false) {
                    envelope.truncated = true;
                    envelope.warn(format!("depth capped at {max_depth}"));
                }
                stack.push(if is_dict {
                    Frame::Dict {
                        map: serde_json::Map::new(),
                        pending_key: None,
                        expected,
                        pruned: prune,
                        omitted: 0,
                    }
                } else {
                    Frame::Array {
                        items: Vec::new(),
                        expected,
                        pruned: prune,
                        omitted: 0,
                    }
                });
            }
            Ev::EndCollection => {
                let frame = match stack.pop() {
                    Some(frame) => frame,
                    None => {
                        envelope.warn("unbalanced EndCollection event".to_string());
                        continue;
                    }
                };
                let (mut value, expected, emitted, pruned, omitted) = match frame {
                    Frame::Array {
                        items,
                        expected,
                        pruned,
                        omitted,
                    } => {
                        let emitted = items.len();
                        (
                            serde_json::Value::Array(items),
                            expected,
                            emitted,
                            pruned,
                            omitted,
                        )
                    }
                    Frame::Dict {
                        map,
                        expected,
                        pruned,
                        omitted,
                        ..
                    } => {
                        let emitted = map.len();
                        (
                            serde_json::Value::Object(map),
                            expected,
                            emitted,
                            pruned,
                            omitted,
                        )
                    }
                };
                let mut dropped = omitted;
                if let Some(expected) = expected {
                    dropped = dropped.saturating_add(expected.saturating_sub(emitted as u64));
                }
                if dropped > 0 {
                    items_omitted = items_omitted.saturating_add(dropped);
                }
                if pruned {
                    value = serde_json::json!({
                        "$type": "truncated",
                        "reason": "depth_limit",
                        "children": emitted,
                    });
                }
                match stack.last_mut() {
                    Some(parent) => push_child(parent, value, max_items),
                    None => root = Some(value),
                }
            }
            scalar => {
                let value = scalar_json(&scalar, &mut counts, max_string, &mut strings_truncated);
                match stack.last_mut() {
                    Some(parent) => push_child(parent, value, max_items),
                    None => {
                        if root.is_none() {
                            root = Some(value);
                        } else {
                            envelope.warn("trailing top-level event".to_string());
                        }
                    }
                }
            }
        }

        if root.is_some() && stack.is_empty() {
            if let Some(Ok(_)) = reader.next() {
                envelope.truncated = true;
                envelope.warn("trailing data after plist root".to_string());
            }
            break;
        }
    }

    if strings_truncated > 0 {
        envelope.warn(format!("{strings_truncated} string values truncated"));
    }
    if items_omitted > 0 {
        envelope.truncated = true;
        envelope.warn(format!("{items_omitted} container items omitted by item cap"));
    }
    match root {
        Some(root) if stack.is_empty() => Ok(serde_json::json!({
            "kind": "plist",
            "encoding": detect_format(bytes),
            "node_counts": {
                "total": counts.total(),
                "dictionaries": counts.dictionaries,
                "arrays": counts.arrays,
                "strings": counts.strings,
                "integers": counts.integers,
                "reals": counts.reals,
                "booleans": counts.booleans,
                "dates": counts.dates,
                "datas": counts.datas,
                "uids": counts.uids,
            },
            "max_depth_seen": depth_seen,
            "events_read": events,
            "root": root,
        })),
        _ => Err(Fail::new("invalid_plist")),
    }
}

/// Route a completed value into the open container, honoring the
/// dictionary key/value alternation and the per-container item cap.
fn push_child(frame: &mut Frame, value: serde_json::Value, max_items: usize) {
    match frame {
        Frame::Array {
            items,
            pruned,
            omitted,
            ..
        } => {
            if *pruned {
                return;
            }
            if items.len() >= max_items {
                *omitted = omitted.saturating_add(1);
                return;
            }
            items.push(value);
        }
        Frame::Dict {
            map,
            pending_key,
            pruned,
            omitted,
            ..
        } => {
            if *pruned {
                // Keep key/value alternation consistent while discarding.
                if pending_key.is_none() {
                    *pending_key = Some(String::new());
                } else {
                    *pending_key = None;
                }
                return;
            }
            match pending_key.take() {
                None => {
                    // Scalars inside a dict arrive as keys only when they are
                    // strings; a non-string key means a malformed stream —
                    // stash it so the value still lands somewhere bounded.
                    let key = match &value {
                        serde_json::Value::String(text) => text.clone(),
                        other => format!("<non-string key:{}>", other),
                    };
                    *pending_key = Some(key);
                }
                Some(key) => {
                    if map.len() >= max_items {
                        *omitted = omitted.saturating_add(1);
                    } else {
                        map.insert(key, value);
                    }
                }
            }
        }
    }
}

fn scalar_json(
    event: &plist::stream::Event<'_>,
    counts: &mut Counts,
    max_string: usize,
    strings_truncated: &mut u64,
) -> serde_json::Value {
    use plist::stream::Event as Ev;
    match event {
        Ev::Boolean(v) => {
            counts.booleans += 1;
            serde_json::Value::Bool(*v)
        }
        Ev::Integer(v) => {
            counts.integers += 1;
            if let Some(v) = v.as_signed() {
                serde_json::Value::from(v)
            } else if let Some(v) = v.as_unsigned() {
                serde_json::Value::from(v)
            } else {
                serde_json::json!({ "$type": "integer", "value": "overflow" })
            }
        }
        Ev::Real(v) => {
            counts.reals += 1;
            if v.is_finite() {
                serde_json::Value::from(*v)
            } else {
                serde_json::json!({
                    "$type": "real",
                    "value": if v.is_nan() { "nan" } else if v.is_sign_positive() { "inf" } else { "-inf" },
                })
            }
        }
        Ev::String(text) => {
            counts.strings += 1;
            let shortened = clean(text, max_string);
            if shortened.len() < text.len() {
                *strings_truncated += 1;
            }
            serde_json::Value::String(shortened)
        }
        Ev::Data(data) => {
            counts.datas += 1;
            serde_json::json!({
                "$type": "data",
                "length": data.len(),
                "sha256": sha256_hex(data),
                "preview": hex_preview(data),
            })
        }
        Ev::Date(date) => {
            counts.dates += 1;
            serde_json::json!({ "$type": "date", "value": date.to_xml_format() })
        }
        Ev::Uid(uid) => {
            counts.uids += 1;
            serde_json::json!({ "$type": "uid", "value": uid.get() })
        }
        _ => serde_json::Value::Null,
    }
}
