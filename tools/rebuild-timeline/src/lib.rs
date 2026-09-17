use serde::Serialize;
use std::convert::TryFrom;
use wasm_bindgen::prelude::*;

const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_EVENTS: usize = 4096;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TimelineEvent {
    timestamp: i64,
    source: String,
    action: String,
    path: String,
    extra: serde_json::Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    schema_version: u8,
    truncated: bool,
    warnings: Vec<String>,
    result: serde_json::Value,
}

#[wasm_bindgen]
pub fn analyze(bytes: &[u8], options_json: &str) -> Result<String, JsError> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(JsError::new(&format!("input size {} exceeds limit {}", bytes.len(), MAX_INPUT_BYTES)));
    }
    let options: serde_json::Value = if options_json.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(options_json).map_err(|error| JsError::new(&error.to_string()))?
    };
    let mut envelope = Envelope {
        schema_version: 1,
        truncated: false,
        warnings: Vec::new(),
        result: serde_json::Value::Null,
    };
    envelope.result = rebuild(bytes, &options, &mut envelope);
    let json = serde_json::to_string(&envelope).map_err(|error| JsError::new(&error.to_string()))?;
    if json.len() > MAX_OUTPUT_BYTES {
        return Err(JsError::new(&format!("serialized output size {} exceeds limit {}", json.len(), MAX_OUTPUT_BYTES)));
    }
    Ok(json)
}

fn rebuild(bytes: &[u8], options: &serde_json::Value, envelope: &mut Envelope) -> serde_json::Value {
    let max_events = options.get("maxEvents").and_then(serde_json::Value::as_u64).unwrap_or(1024).min(MAX_EVENTS as u64) as usize;
    let mut events = Vec::new();
    events.extend(from_bodyfile(bytes, envelope));
    events.extend(from_artifact_json(options.get("artifacts"), envelope));
    events.sort_by_key(|event| event.timestamp);
    if events.len() > max_events {
        envelope.truncated = true;
        events.truncate(max_events);
    }
    serde_json::json!({
        "count": events.len(),
        "first": events.first().map(|event| event.timestamp),
        "last": events.last().map(|event| event.timestamp),
        "events": events,
    })
}

fn from_bodyfile(bytes: &[u8], envelope: &mut Envelope) -> Vec<TimelineEvent> {
    let text = String::from_utf8_lossy(bytes);
    let mut events = Vec::new();
    for line in text.lines() {
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        match bodyfile::Bodyfile3Line::try_from(line) {
            Ok(item) => {
                let path = item.get_name().to_string();
                push_time(&mut events, item.get_atime(), "bodyfile", "accessed", &path);
                push_time(&mut events, item.get_mtime(), "bodyfile", "modified", &path);
                push_time(&mut events, item.get_ctime(), "bodyfile", "changed", &path);
                push_time(&mut events, item.get_crtime(), "bodyfile", "created", &path);
            }
            Err(error) => {
                if looks_like_bodyfile(&text) {
                    envelope.warnings.push(error.to_string());
                }
            }
        }
    }
    events
}

fn looks_like_bodyfile(text: &str) -> bool {
    text.lines().any(|line| line.matches('|').count() >= 10)
}

fn push_time(events: &mut Vec<TimelineEvent>, timestamp: i64, source: &str, action: &str, path: &str) {
    if timestamp <= 0 {
        return;
    }
    events.push(TimelineEvent {
        timestamp,
        source: source.into(),
        action: action.into(),
        path: path.into(),
        extra: serde_json::json!({}),
    });
}

fn from_artifact_json(value: Option<&serde_json::Value>, envelope: &mut Envelope) -> Vec<TimelineEvent> {
    let Some(value) = value else {
        return Vec::new();
    };
    let artifacts = match value {
        serde_json::Value::Array(items) => items.clone(),
        serde_json::Value::String(text) => match serde_json::from_str::<serde_json::Value>(text) {
            Ok(serde_json::Value::Array(items)) => items,
            Ok(item) => vec![item],
            Err(error) => {
                envelope.warnings.push(error.to_string());
                return Vec::new();
            }
        },
        other => vec![other.clone()],
    };
    let mut events = Vec::new();
    for artifact in artifacts {
        events.extend(events_from_artifact(&artifact));
    }
    events
}

fn events_from_artifact(artifact: &serde_json::Value) -> Vec<TimelineEvent> {
    let kind = artifact.get("kind").and_then(serde_json::Value::as_str).unwrap_or("artifact");
    match kind {
        "prefetch" => artifact
            .get("lastRunTimes")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|value| value.as_i64())
            .map(|timestamp| TimelineEvent {
                timestamp,
                source: "prefetch".into(),
                action: "executed".into(),
                path: artifact.get("executable").and_then(serde_json::Value::as_str).unwrap_or("").into(),
                extra: serde_json::json!({ "runCount": artifact.get("runCount") }),
            })
            .collect(),
        "evtx" => artifact
            .get("records")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|record| {
                let timestamp = parse_timestamp(record.get("timestamp"))?;
                Some(TimelineEvent {
                    timestamp,
                    source: "evtx".into(),
                    action: "logged".into(),
                    path: record.get("eventRecordId").map(|id| id.to_string()).unwrap_or_default(),
                    extra: record.clone(),
                })
            })
            .collect(),
        "lnk" => ["created", "accessed", "written"]
            .into_iter()
            .filter_map(|action| {
                let timestamp = artifact.get(action).and_then(serde_json::Value::as_i64)?;
                Some(TimelineEvent {
                    timestamp,
                    source: "lnk".into(),
                    action: action.into(),
                    path: artifact.get("path").and_then(serde_json::Value::as_str).unwrap_or("").into(),
                    extra: serde_json::json!({ "name": artifact.get("name") }),
                })
            })
            .collect(),
        "hive" => artifact
            .get("keys")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|key| {
                let timestamp = key.get("lastWritten").and_then(serde_json::Value::as_i64)?;
                Some(TimelineEvent {
                    timestamp,
                    source: "hive".into(),
                    action: "keyWritten".into(),
                    path: key.get("name").and_then(serde_json::Value::as_str).unwrap_or("").into(),
                    extra: serde_json::json!({ "valueCount": key.get("valueCount") }),
                })
            })
            .collect(),
        _ => parse_timestamp(artifact.get("timestamp"))
            .map(|timestamp| TimelineEvent {
                timestamp,
                source: kind.into(),
                action: "observed".into(),
                path: artifact.get("path").and_then(serde_json::Value::as_str).unwrap_or("").into(),
                extra: artifact.clone(),
            })
            .into_iter()
            .collect(),
    }
}

fn parse_timestamp(value: Option<&serde_json::Value>) -> Option<i64> {
    let value = value?;
    if let Some(number) = value.as_i64() {
        return Some(number);
    }
    let text = value.as_str()?;
    if let Ok(number) = text.parse::<i64>() {
        return Some(number);
    }
    chrono_like(text)
}

fn chrono_like(text: &str) -> Option<i64> {
    let trimmed = text.trim();
    if trimmed.len() < 19 {
        return None;
    }
    None
}
