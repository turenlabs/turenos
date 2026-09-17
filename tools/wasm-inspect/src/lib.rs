use serde::Serialize;
use wasm_bindgen::prelude::*;
use wasmparser::{Parser, Payload, Validator};

const MAX_INPUT_BYTES: usize = 16 * 1024 * 1024;
const MAX_SECTIONS: usize = 4096;
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Serialize)]
struct Report {
    schema_version: u32,
    input_bytes: usize,
    valid: bool,
    encoding: &'static str,
    sections: Vec<Section>,
    warnings: Vec<String>,
    truncated: bool,
}

#[derive(Serialize)]
struct Section {
    id: u8,
    start: usize,
    end: usize,
    name: Option<String>,
}

#[wasm_bindgen]
pub fn wasm_inspect(bytes: &[u8], options_json: &str) -> String {
    if bytes.len() > MAX_INPUT_BYTES {
        return error("input_too_large");
    }

    let max_sections = serde_json::from_str::<serde_json::Value>(options_json)
        .ok()
        .and_then(|value| value.get("maxSections").and_then(serde_json::Value::as_u64))
        .map(|value| (value as usize).min(MAX_SECTIONS))
        .unwrap_or(MAX_SECTIONS);
    let encoding = if wasmparser::Parser::is_component(bytes) {
        "component"
    } else if wasmparser::Parser::is_core_wasm(bytes) {
        "module"
    } else {
        "unknown"
    };

    let mut report = Report {
        schema_version: 1,
        input_bytes: bytes.len(),
        valid: false,
        encoding,
        sections: Vec::new(),
        warnings: Vec::new(),
        truncated: false,
    };
    if encoding == "unknown" {
        report.warnings.push("not_a_wasm_module".to_string());
        return serialize(report);
    }

    if let Err(error) = Validator::new().validate_all(bytes) {
        report.warnings.push(format!("validation_failed: {error}"));
        return serialize(report);
    }
    report.valid = true;

    for payload in Parser::new(0).parse_all(bytes) {
        let payload = match payload {
            Ok(payload) => payload,
            Err(error) => {
                report.warnings.push(format!("parse_failed: {error}"));
                break;
            }
        };
        let Some((id, range)) = payload.as_section() else {
            continue;
        };
        if report.sections.len() >= max_sections {
            report.truncated = true;
            break;
        }
        let name = match payload {
            Payload::CustomSection(section) => Some(section.name().to_string()),
            _ => None,
        };
        report.sections.push(Section {
            id,
            start: range.start,
            end: range.end,
            name,
        });
    }

    serialize(report)
}

fn error(code: &str) -> String {
    serde_json::json!({ "schema_version": 1, "error": code }).to_string()
}

fn serialize(report: Report) -> String {
    let output = serde_json::to_string(&report).unwrap_or_else(|_| error("serialization_failed"));
    if output.len() <= MAX_OUTPUT_BYTES {
        return output;
    }
    serde_json::json!({
        "schema_version": 1,
        "input_bytes": report.input_bytes,
        "valid": report.valid,
        "encoding": report.encoding,
        "sections": [],
        "warnings": ["output_too_large"],
        "truncated": true,
    })
    .to_string()
}
