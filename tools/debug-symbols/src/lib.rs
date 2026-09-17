use std::io::Cursor;

use object::{Object, ObjectSection, ObjectSymbol};
use pdb::FallibleIterator;
use serde::Deserialize;
use wasm_bindgen::prelude::*;

const MAX_INPUT_BYTES: usize = 64 * 1024 * 1024;
const MAX_RECORDS: usize = 4096;
const MAX_NAME_BYTES: usize = 4096;

#[derive(Debug, Default, Deserialize)]
struct Options {
    #[serde(default)]
    demangle: bool,
    #[serde(default)]
    source_paths: bool,
    #[serde(default)]
    max_records: Option<usize>,
}

#[wasm_bindgen]
pub fn inspect(bytes: &[u8], options_json: &str) -> String {
    if bytes.len() > MAX_INPUT_BYTES {
        return error_json("input_too_large");
    }
    let options = match serde_json::from_str::<Options>(options_json) {
        Ok(options) => options,
        Err(_) => return error_json("invalid_options"),
    };
    let max_records = options.max_records.unwrap_or(MAX_RECORDS).min(MAX_RECORDS);
    if bytes.starts_with(b"Microsoft C/C++ MSF 7.00") {
        return inspect_pdb(bytes, &options, max_records);
    }
    inspect_object(bytes, &options, max_records)
}

fn inspect_object(bytes: &[u8], options: &Options, max_records: usize) -> String {
    let file = match object::File::parse(bytes) {
        Ok(file) => file,
        Err(_) => return error_json("unsupported_debug_container"),
    };
    let sections = file
        .sections()
        .filter_map(|section| {
            let name = section.name().ok()?.to_string();
            if !name.starts_with(".debug_") && !name.starts_with("__debug_") {
                return None;
            }
            Some(serde_json::json!({
                "name": truncate(&name),
                "size": section.size(),
            }))
        })
        .take(max_records)
        .collect::<Vec<_>>();
    let symbols = file
        .symbols()
        .filter_map(|symbol| {
            let name = symbol.name().ok()?;
            if name.is_empty() {
                return None;
            }
            let name = truncate(name);
            Some(serde_json::json!({
                "name": name,
                "display_name": if options.demangle { demangle(&name) } else { name.clone() },
                "address": symbol.address().to_string(),
                "size": symbol.size().to_string(),
                "kind": format!("{:?}", symbol.kind()),
                "defined": symbol.is_definition(),
            }))
        })
        .take(max_records)
        .collect::<Vec<_>>();
    serde_json::json!({
        "schema_version": 1,
        "format": format!("{:?}", file.format()),
        "debug_sections": sections,
        "symbols": symbols,
        "source_paths_included": options.source_paths,
        "truncated": file.sections().count() > max_records || file.symbols().count() > max_records,
        "warnings": [],
    })
    .to_string()
}

fn inspect_pdb(bytes: &[u8], options: &Options, max_records: usize) -> String {
    let mut pdb = match pdb::PDB::open(Cursor::new(bytes)) {
        Ok(pdb) => pdb,
        Err(_) => return error_json("invalid_pdb"),
    };
    let symbols = match pdb.global_symbols() {
        Ok(symbols) => symbols,
        Err(_) => return error_json("pdb_symbols_unavailable"),
    };
    let mut iterator = symbols.iter();
    let mut records = Vec::new();
    while records.len() < max_records {
        let symbol = match iterator.next() {
            Ok(Some(symbol)) => symbol,
            Ok(None) => break,
            Err(_) => return error_json("invalid_pdb_symbol_stream"),
        };
        let Ok(data) = symbol.parse() else { continue };
        if let pdb::SymbolData::Public(public) = data {
            let raw_name = public.name.to_string();
            let name = truncate(raw_name.as_ref());
            records.push(serde_json::json!({
                "name": name,
                "display_name": if options.demangle { demangle(&name) } else { name.clone() },
                "offset": public.offset.offset.to_string(),
                "section": public.offset.section,
                "kind": "public",
            }));
        }
    }
    serde_json::json!({
        "schema_version": 1,
        "format": "pdb",
        "symbols": records,
        "source_paths_included": options.source_paths,
        "truncated": records.len() == max_records,
        "warnings": [],
    })
    .to_string()
}

fn demangle(name: &str) -> String {
    if let Ok(value) = cpp_demangle::Symbol::new(name) {
        if let Ok(value) = value.demangle() {
            return value;
        }
    }
    if let Ok(value) = msvc_demangler::demangle(name, msvc_demangler::DemangleFlags::llvm()) {
        return value;
    }
    rustc_demangle::demangle(name).to_string()
}

fn truncate(value: &str) -> String {
    value.chars().take(MAX_NAME_BYTES).collect()
}

fn error_json(error: &str) -> String {
    serde_json::json!({ "schema_version": 1, "error": error, "complete": false }).to_string()
}
