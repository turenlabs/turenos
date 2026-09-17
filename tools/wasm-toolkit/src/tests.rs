//! Unit tests. Every fixture module is fabricated in test code through the
//! `wat`/`wast`/`wasm-encoder` crates themselves, so tests exercise the same
//! codecs the target wraps.

use super::*;
use serde_json::Value;

fn wat(text: &str) -> Vec<u8> {
    wat::parse_str(text).expect("fixture wat should compile")
}

fn json(text: String) -> Value {
    serde_json::from_str(&text).expect("output should be JSON")
}

fn error_code(text: String) -> String {
    json(text)["error"].as_str().unwrap_or_default().to_string()
}

const HELLO: &str = r#"(module
  (type $t (func (param i32) (result i32)))
  (import "env" "log" (func $log (param i32)))
  (memory (export "mem") 1 2)
  (global $g (export "g") (mut i32) (i32.const 7))
  (func $f (export "f") (type $t) (param i32) (result i32)
    local.get 0)
  (func $start)
  (start $start)
)"#;

#[test]
fn print_round_trip() {
    let module = wat(HELLO);
    let report = json(wasm_print(&module, "{}"));
    assert_eq!(report["encoding"], "module");
    assert_eq!(report["truncated"], false);
    let text = report["wat"].as_str().unwrap();
    assert!(text.contains("(module"));
    assert!(text.contains("local.get"));
    // The printed text must itself compile and analyze identically.
    let recompiled = wat_compile(text.as_bytes(), "{}").expect("printed wat compiles");
    let a = wasm_analyze(&module, "{}");
    let b = wasm_analyze(&recompiled, "{}");
    let a = json(a);
    let b = json(b);
    assert_eq!(a["functions"], b["functions"]);
    assert_eq!(a["features"], b["features"]);
}

#[test]
fn print_options() {
    let module = wat(HELLO);
    let skeleton = json(wasm_print(&module, r#"{"skeleton":true}"#));
    let text = skeleton["wat"].as_str().unwrap();
    assert!(text.contains("(module"));
    assert!(!text.contains("local.get"), "skeleton hides bodies: {text}");

    let folded = json(wasm_print(&module, r#"{"foldExpressions":true}"#));
    assert!(folded["wat"].as_str().unwrap().contains("(local.get"));
}

#[test]
fn print_truncation() {
    let module = wat(HELLO);
    let report = json(wasm_print(&module, r#"{"maxWatBytes":32}"#));
    assert_eq!(report["truncated"], true);
    assert!(report["wat_bytes"].as_u64().unwrap() <= 32);
}

#[test]
fn print_rejects_non_wasm() {
    assert_eq!(error_code(wasm_print(b"not wasm", "{}")), "not_a_wasm_module");
    assert_eq!(
        error_code(wasm_print(&vec![0u8; 40 * 1024 * 1024], "{}")),
        "input_too_large"
    );
}

#[test]
fn analyze_basic_module() {
    let module = wat(HELLO);
    let report = json(wasm_analyze(&module, "{}"));
    assert_eq!(report["schema_version"], 1);
    assert_eq!(report["encoding"], "module");
    assert_eq!(report["valid"], true);
    assert_eq!(report["valid_all_features"], true);
    assert_eq!(report["validation_error"], Value::Null);
    // $t plus the implicit types for $log's and $start's signatures.
    assert_eq!(report["types"]["count"], 3);
    assert_eq!(report["types"]["funcs"], 3);

    let imports = report["imports"].as_array().unwrap();
    assert_eq!(imports.len(), 1);
    assert_eq!(imports[0]["module"], "env");
    assert_eq!(imports[0]["name"], "log");
    assert_eq!(imports[0]["kind"], "func");
    assert!(imports[0]["signature"]
        .as_str()
        .unwrap()
        .contains("param i32"));

    let exports = report["exports"].as_array().unwrap();
    assert_eq!(exports.len(), 3);
    let f = exports
        .iter()
        .find(|e| e["name"] == "f")
        .expect("export f");
    assert_eq!(f["kind"], "func");
    assert!(f["signature"].as_str().unwrap().contains("result i32"));
    let mem = exports.iter().find(|e| e["name"] == "mem").unwrap();
    assert_eq!(mem["kind"], "memory");
    assert!(mem["detail"].as_str().unwrap().contains("pages[1..2]"));

    assert_eq!(report["functions"]["count"], 2);
    assert!(report["functions"]["code_bytes"].as_u64().unwrap() > 0);
    assert_eq!(report["start"], 2); // $start follows the import and $f
    assert_eq!(report["memories"][0]["min_pages"], 1);
    assert_eq!(report["memories"][0]["max_pages"], 2);
    assert_eq!(report["globals"][0]["content_type"], "i32");
    assert_eq!(report["globals"][0]["init"], "i32.const");
    assert_eq!(report["feature_detection"], "complete");
    // An MVP-ish module with mutable globals.
    let features = report["features"].as_array().unwrap();
    assert!(features.iter().any(|f| f == "mutable_global"));
    assert!(!features.iter().any(|f| f == "simd"));
    assert!(!features.iter().any(|f| f == "threads"));
}

#[test]
fn analyze_simd_bulk_memory() {
    let module = wat(r#"(module
      (memory 1)
      (func (param v128) (result v128)
        local.get 0
        v128.not)
      (func
        i32.const 0
        i32.const 0
        i32.const 4
        memory.copy)
    )"#);
    let report = json(wasm_analyze(&module, "{}"));
    assert_eq!(report["valid"], true);
    let features = report["features"].as_array().unwrap();
    assert!(features.iter().any(|f| f == "simd"), "{features:?}");
    assert!(features.iter().any(|f| f == "bulk_memory_opt"), "{features:?}");
}

#[test]
fn analyze_threads_and_tail_call() {
    let module = wat(r#"(module
      (memory 1 1 shared)
      (func $f (result i32)
        i32.const 0)
      (func (result i32)
        return_call $f)
    )"#);
    let report = json(wasm_analyze(&module, "{}"));
    assert_eq!(report["valid"], true);
    let features = report["features"].as_array().unwrap();
    assert!(features.iter().any(|f| f == "threads"), "{features:?}");
    assert!(features.iter().any(|f| f == "tail_call"), "{features:?}");
    assert_eq!(report["memories"][0]["shared"], true);
}

#[test]
fn analyze_exceptions() {
    // `throw`/`try_table` are the standardized exception-handling proposal.
    let module = wat(r#"(module
      (tag $e (param i32))
      (func
        i32.const 42
        throw $e)
    )"#);
    let report = json(wasm_analyze(&module, "{}"));
    assert_eq!(report["valid"], true);
    let features = report["features"].as_array().unwrap();
    assert!(features.iter().any(|f| f == "exceptions"), "{features:?}");
    assert_eq!(report["tags_total"], 1);
}

#[test]
fn analyze_reference_types_and_elements() {
    let module = wat(r#"(module
      (table 2 funcref)
      (table 1 externref)
      (func $f)
      (elem (i32.const 0) $f)
      (elem declare func $f)
      (elem funcref (ref.func $f))
    )"#);
    let report = json(wasm_analyze(&module, "{}"));
    assert_eq!(report["valid"], true);
    let features = report["features"].as_array().unwrap();
    assert!(features.iter().any(|f| f == "reference_types"), "{features:?}");
    assert_eq!(report["elements"]["count"], 3);
    assert_eq!(report["elements"]["active"], 1);
    assert_eq!(report["elements"]["declared"], 1);
    assert_eq!(report["elements"]["passive"], 1);
    assert_eq!(report["tables"][1]["element_type"], "externref");
}

#[test]
fn analyze_data_segments() {
    // `memory.init`/`data.drop` force emission of the data-count section.
    let module = wat(r#"(module
      (memory 1)
      (data (i32.const 0) "abcd")
      (data $d "xy")
      (func
        i32.const 0
        i32.const 0
        i32.const 2
        memory.init $d
        data.drop $d)
    )"#);
    let report = json(wasm_analyze(&module, "{}"));
    assert_eq!(report["valid"], true);
    assert_eq!(report["data"]["count"], 2);
    assert_eq!(report["data"]["active"], 1);
    assert_eq!(report["data"]["passive"], 1);
    assert_eq!(report["data"]["bytes_total"], 6);
    assert_eq!(report["data"]["declared_count"], 2);
    let features = report["features"].as_array().unwrap();
    assert!(features.iter().any(|f| f == "bulk_memory"), "{features:?}");
}

#[test]
fn analyze_malformed_inputs() {
    // Bad magic.
    assert_eq!(
        error_code(wasm_analyze(b"\x00asm\x02", "{}")),
        "not_a_wasm_module"
    );
    assert_eq!(error_code(wasm_analyze(&[], "{}")), "not_a_wasm_module");
    // Valid header, truncated section payload.
    let mut truncated = wat(HELLO);
    truncated.truncate(truncated.len() - 3);
    let report = json(wasm_analyze(&truncated, "{}"));
    assert_eq!(report["valid"], false);
    assert!(report["validation_error"].is_string());
    assert_eq!(report["feature_detection"], "skipped_invalid");
    // Invalid LEB in section id region.
    let bad = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0xff, 0xff];
    let report = json(wasm_analyze(&bad, "{}"));
    assert_eq!(report["valid"], false);
    // Corrupt body: declared function body size overruns the section.
    let bad = [
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // header
        0x01, 0x04, 0x01, 0x60, 0x00, 0x00, // type section: () -> ()
        0x03, 0x02, 0x01, 0x00, // function section: 1 func of type 0
        0x0a, 0x02, 0x01, 0x7f, // code section: body size 127 overruns
    ];
    let report = json(wasm_analyze(&bad, "{}"));
    assert_eq!(report["valid"], false);
}

#[test]
fn analyze_component() {
    let component = wat("(component (core module $m (func)))");
    let report = json(wasm_analyze(&component, "{}"));
    assert_eq!(report["encoding"], "component");
    assert_eq!(report["valid"], true);
    let c = &report["component"];
    assert_eq!(c["nested_modules"], 1);
    assert!(c["section_kinds"]
        .as_array()
        .unwrap()
        .iter()
        .any(|k| k == "module"));
    let features = report["features"].as_array().unwrap();
    assert!(features.iter().any(|f| f == "component_model"));
}

#[test]
fn analyze_max_items_and_determinism() {
    let module = wat(HELLO);
    let a = wasm_analyze(&module, "{}");
    let b = wasm_analyze(&module, "{}");
    assert_eq!(a, b, "analysis must be deterministic");
    let limited = json(wasm_analyze(&module, r#"{"maxItems":1}"#));
    assert_eq!(limited["exports"].as_array().unwrap().len(), 1);
    assert_eq!(limited["exports_total"], 3);
    assert_eq!(limited["truncated"], true);
}

#[test]
fn options_handling() {
    let module = wat(HELLO);
    assert_eq!(
        error_code(wasm_analyze(&module, "{not json")),
        "invalid_options"
    );
    assert_eq!(
        error_code(wasm_analyze(&module, &"x".repeat(5000))),
        "options_too_large"
    );
    // Empty and null options mean defaults.
    assert_eq!(json(wasm_analyze(&module, ""))["valid"], true);
    assert_eq!(json(wasm_analyze(&module, "null"))["valid"], true);
}

#[test]
fn metadata_producers() {
    let module = wat(HELLO);
    let mut producers = wasm_metadata::Producers::empty();
    producers.add("language", "rust", "");
    producers.add("processed-by", "turen-test", "1.2.3");
    let module = producers.add_to_wasm(&module).unwrap();

    let report = json(wasm_metadata(&module, "{}"));
    let producers = report["producers"].as_object().unwrap();
    assert_eq!(producers["language"][0]["name"], "rust");
    assert_eq!(producers["processed-by"][0]["name"], "turen-test");
    assert_eq!(producers["processed-by"][0]["version"], "1.2.3");
    let custom = report["custom_sections"].as_array().unwrap();
    assert!(custom
        .iter()
        .any(|s| s["name"] == "producers" && s["recognized"] == true));
}

#[test]
fn metadata_name_section() {
    use wasm_encoder::{Module, NameMap, NameSection};
    let mut names = NameSection::new();
    names.module("fixture-mod");
    let mut funcs = NameMap::new();
    funcs.append(0, "first");
    funcs.append(1, "second");
    names.functions(&funcs);
    let mut module = Module::new();
    module.section(&names);
    let bytes = module.finish();
    // A name-only module parses (no functions defined, names dangle - that's
    // fine for metadata inspection which never validates semantics).
    let report = json(wasm_metadata(&bytes, "{}"));
    let name_section = report["name_section"].as_object().unwrap();
    assert_eq!(name_section["module_name"], "fixture-mod");
    let function = name_section["subsections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["kind"] == "function")
        .unwrap();
    assert_eq!(function["entries"], 2);
}

#[test]
fn metadata_source_mapping_url() {
    use std::borrow::Cow;
    use wasm_encoder::{CustomSection, Module};
    let mut module = Module::new();
    module.section(&CustomSection {
        name: Cow::Borrowed("sourceMappingURL"),
        data: Cow::Borrowed(b"file:///tmp/module.wasm.map"),
    });
    let report = json(wasm_metadata(&module.finish(), "{}"));
    assert_eq!(report["source_mapping_url"], "file:///tmp/module.wasm.map");
}

#[test]
fn metadata_component_outline() {
    let component = wat(r#"(component
      (import "wasi:cli/run" (func $run))
      (export "run" (func $run))
    )"#);
    let report = json(wasm_metadata(&component, "{}"));
    assert_eq!(report["encoding"], "component");
    let outline = report["component"].as_object().unwrap();
    let imports = outline["imports"].as_array().unwrap();
    assert_eq!(imports[0]["name"], "wasi:cli/run");
    assert_eq!(imports[0]["kind"], "func");
    let exports = outline["exports"].as_array().unwrap();
    assert_eq!(exports[0]["name"], "run");
    assert_eq!(exports[0]["kind"], "func");
}

#[test]
fn metadata_no_sections() {
    // `wat` emits a `name` custom section for $-named items, so a bare
    // encoder-built module is the fixture with no metadata at all.
    let bare = wasm_encoder::Module::new().finish();
    let report = json(wasm_metadata(&bare, "{}"));
    assert_eq!(report["producers"], Value::Null);
    assert_eq!(report["source_mapping_url"], Value::Null);
    assert_eq!(report["name_section"], Value::Null);
    assert_eq!(report["component"], Value::Null);

    // Sanity: the wat fixture does carry a name section.
    let report = json(wasm_metadata(&wat(HELLO), "{}"));
    let name_section = report["name_section"].as_object().unwrap();
    assert!(name_section["named_total"].as_u64().unwrap() >= 3);
}

#[test]
fn wat_compile_happy_path() {
    let compiled = wat_compile(b"(module (func (export \"f\")))", "{}").unwrap();
    assert!(wasmparser::Parser::is_core_wasm(&compiled));
    let analysis = json(wasm_analyze(&compiled, "{}"));
    assert_eq!(analysis["valid"], true);
    assert_eq!(analysis["exports"][0]["name"], "f");
}

#[test]
fn wat_compile_component() {
    let compiled = wat_compile(b"(component)", "{}").unwrap();
    assert!(wasmparser::Parser::is_component(&compiled));
}

#[test]
fn wat_compile_parse_error_position() {
    let err = wat_compile::compile(b"(module\n  (func (").unwrap_err();
    let report = json(err);
    assert_eq!(report["error"], "wat_parse_error");
    assert!(report["line"].as_u64().unwrap() >= 2);
    assert!(report["column"].is_u64());
    assert!(report["offset"].is_u64());
}

#[test]
fn wat_compile_semantic_error() {
    // Unknown local reference fails during encode/name resolution.
    let err = wat_compile::compile(b"(module (func (local.get $missing)))").unwrap_err();
    let report = json(err);
    assert!(matches!(
        report["error"].as_str().unwrap(),
        "wat_parse_error" | "wat_encode_error"
    ));
}

#[test]
fn wat_compile_rejects_binary_and_utf8() {
    let err = wat_compile::compile(b"\x00asm\x01\x00\x00\x00").unwrap_err();
    assert_eq!(json(err)["error"], "expected_wat_text");
    let err = wat_compile::compile(b"\xff\xfe\x00").unwrap_err();
    assert_eq!(json(err)["error"], "invalid_utf8");
    let err = wat_compile::compile(b"").unwrap_err();
    assert_eq!(json(err)["error"], "empty_input");
}

#[test]
fn wat_compile_input_too_large() {
    let err = wat_compile::compile(&vec![b' '; 33 * 1024 * 1024]).unwrap_err();
    assert_eq!(json(err)["error"], "input_too_large");
}

#[test]
fn print_malformed_no_panic() {
    // Truncated and corrupted inputs surface as error JSON, never a trap.
    for cut in [b"\x00asm\x01".as_slice(), &[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x0a][..]] {
        let out = wasm_print(cut, "{}");
        let _ = json(out);
    }
}
