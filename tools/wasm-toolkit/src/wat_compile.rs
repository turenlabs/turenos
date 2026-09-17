//! `wat_compile`: bounded `.wat` text -> validated wasm binary.
//!
//! The text is lexed, parsed, and encoded with `wast`, then the produced
//! binary is validated with `wasmparser` under all known features before it is
//! returned. Errors carry 1-indexed `line`/`column` plus the byte `offset`.

use crate::{error_json, error_json_detail, MAX_COMPILED_BYTES, MAX_WAT_INPUT_BYTES};
use wasmparser::{Validator, WasmFeatures};

pub(crate) fn compile(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.is_empty() {
        return Err(error_json("empty_input"));
    }
    if bytes.len() > MAX_WAT_INPUT_BYTES {
        return Err(error_json("input_too_large"));
    }
    let text = std::str::from_utf8(bytes).map_err(|error| {
        error_json_detail(
            "invalid_utf8",
            serde_json::json!({
                "message": error.to_string(),
                "offset": error.valid_up_to(),
            }),
        )
    })?;
    if wat::Detect::from_bytes(text.as_bytes()) == wat::Detect::WasmBinary {
        return Err(error_json("expected_wat_text"));
    }

    let buffer = wast::parser::ParseBuffer::new(text)
        .map_err(|error| wast_error("wat_parse_error", &error, text))?;
    let mut ast = wast::parser::parse::<wast::Wat>(&buffer)
        .map_err(|error| wast_error("wat_parse_error", &error, text))?;
    let wasm = ast
        .encode()
        .map_err(|error| wast_error("wat_encode_error", &error, text))?;

    if wasm.len() > MAX_COMPILED_BYTES {
        return Err(error_json("output_too_large"));
    }
    // `wast` only emits well-formed binaries, but validate anyway so a
    // toolchain regression can never leak an unvalidated artifact.
    if let Err(error) = Validator::new_with_features(WasmFeatures::all()).validate_all(&wasm) {
        return Err(error_json_detail(
            "wat_validation_failed",
            serde_json::json!({ "message": error.to_string() }),
        ));
    }
    Ok(wasm)
}

fn wast_error(code: &str, error: &wast::Error, text: &str) -> String {
    let (line, column) = error.span().linecol_in(text);
    error_json_detail(
        code,
        serde_json::json!({
            "message": error.message(),
            "line": line + 1,
            "column": column + 1,
            "offset": error.span().offset(),
        }),
    )
}
