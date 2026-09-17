use super::*;

// ---------------------------------------------------------------------------
// Fixture construction: sourcemaps are fabricated in test code with a small
// VLQ encoder so every decoded value is known exactly.
// ---------------------------------------------------------------------------

const B64_CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Encode one base64-VLQ value (sign bit in the LSB, 5 data bits per char,
/// continuation bit 0x20). "AAAA" for the segment [0,0,0,0] is the classic
/// identity mapping at generated (0,0) -> source 0 line 0 column 0.
fn vlq_value(value: i64) -> String {
    let mut rest = if value < 0 {
        ((-value) << 1) | 1
    } else {
        value << 1
    };
    let mut out = String::new();
    loop {
        let mut digit = (rest & 31) as usize;
        rest >>= 5;
        if rest > 0 {
            digit |= 32;
        }
        out.push(B64_CHARS[digit] as char);
        if rest == 0 {
            break;
        }
    }
    out
}

fn vlq_segment(fields: &[i64]) -> String {
    fields.iter().map(|value| vlq_value(*value)).collect()
}

/// One canonical regular map.
///
/// Generated positions (0-indexed, minified side):
///   (0,0)  -> alpha.js (0,0)   name "alphaFn"
///   (0,10) -> alpha.js (0,10)
///   (0,20) -> beta.js  (5,2)   name "betaFn"
///   (2,0)  -> alpha.js (1,0)
///   (2,5)  -> unmapped (source-less) token
/// Line 1 has no segments at all.
fn fixture_map() -> Vec<u8> {
    let mappings = format!(
        "{},{},{};;{},{}",
        vlq_segment(&[0, 0, 0, 0, 0]),      // (0,0)   -> src0 (0,0),  name 0
        vlq_segment(&[10, 0, 0, 10]),       // (0,10)  -> src0 (0,10)
        vlq_segment(&[10, 1, 5, -8, 1]),    // (0,20)  -> src1 (5,2),  name 1
        vlq_segment(&[0, -1, -4, -2]),      // (2,0)   -> src0 (1,0)
        vlq_segment(&[5]),                  // (2,5)   -> unmapped
    );
    assert_eq!(mappings, "AAAAA,UAAU,UCKRC;;ADJF,K");
    format!(
        r#"{{"version":3,"file":"bundle.min.js","sourceRoot":"webpack://demo","sources":["./src/alpha.js","./src/beta.js"],"sourcesContent":["const alpha = 1;\n","const beta = 2;\n"],"names":["alphaFn","betaFn"],"mappings":"{mappings}","ignoreList":[1],"x_google_ignoreList":[0],"debugId":"3fa48559-0000-4000-a000-000000000000"}}"#
    )
    .into_bytes()
}

/// Index map whose sections all embed their maps.
///   section @(0,0): sources ["a.js"], names ["aFn"], token (0,0)->a.js(0,0)
///   section @(5,10): sources ["b.js"], sourcesContent ["B!"], token (0,0)->b.js(0,0)
fn index_map_embedded() -> Vec<u8> {
    let inner_a = format!(
        r#"{{"version":3,"sources":["a.js"],"names":["aFn"],"mappings":"{}"}}"#,
        vlq_segment(&[0, 0, 0, 0, 0])
    );
    let inner_b = format!(
        r#"{{"version":3,"sources":["b.js"],"sourcesContent":["B!"],"mappings":"{}"}}"#,
        vlq_segment(&[0, 0, 0, 0])
    );
    format!(
        r#"{{"version":3,"file":"bundle.min.js","sections":[{{"offset":{{"line":0,"column":0}},"map":{inner_a}}},{{"offset":{{"line":5,"column":10}},"map":{inner_b}}}]}}"#
    )
    .into_bytes()
}

/// Index map whose second section is only an external URL reference.
fn index_map_external() -> Vec<u8> {
    let inner = format!(
        r#"{{"version":3,"sources":["a.js"],"mappings":"{}"}}"#,
        vlq_segment(&[0, 0, 0, 0])
    );
    format!(
        r#"{{"version":3,"sections":[{{"offset":{{"line":0,"column":0}},"map":{inner}}},{{"offset":{{"line":9,"column":0}},"url":"https://cdn.example.com/part2.js.map"}}]}}"#
    )
    .into_bytes()
}

/// Metro/Hermes map: `x_facebook_sources` carries per-source scope mappings.
fn hermes_map() -> Vec<u8> {
    format!(
        r#"{{"version":3,"file":"bundle.js","sources":["input.js"],"names":[],"mappings":"{}","x_facebook_sources":[[{{"names":["<global>"],"mappings":"{}"}}]]}}"#,
        vlq_segment(&[0, 0, 0, 0]),
        vlq_segment(&[0, 0, 0, 0])
    )
    .into_bytes()
}

fn parse(text: &str) -> Value {
    serde_json::from_str(text).expect("output is JSON")
}

fn code(text: &str) -> String {
    parse(text)["error"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

fn error_text(result: Result<Vec<u8>, String>) -> String {
    result.expect_err("expected error document")
}

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

#[test]
fn inspect_regular_reports_summary() {
    let report = parse(&sourcemap_inspect(&fixture_map(), "{}"));
    assert_eq!(report["schema_version"], 1);
    assert_eq!(report["kind"], "regular");
    assert_eq!(report["version"], 3);
    assert_eq!(report["file"], "bundle.min.js");
    assert_eq!(report["source_root"], "webpack://demo");
    assert_eq!(report["debug_id"], "3fa48559-0000-4000-a000-000000000000");
    assert_eq!(report["sources_count"], 2);
    assert_eq!(report["names_count"], 2);
    assert_eq!(report["mappings_count"], 5);
    assert_eq!(report["ignore_list"], json!([1]));
    assert_eq!(report["ignore_list_present"], true);
    assert_eq!(report["x_google_ignore_list_present"], true);
    assert_eq!(report["truncated"], false);

    let sources = report["sources"].as_array().unwrap();
    assert_eq!(sources.len(), 2);
    assert_eq!(sources[0]["source"], "webpack://demo/./src/alpha.js");
    assert_eq!(sources[0]["has_content"], true);
    assert_eq!(sources[0]["content_bytes"], 17);
    assert_eq!(sources[0]["content_sha256"].as_str().unwrap().len(), 64);
    assert_eq!(sources[0]["ignored"], false);
    assert_eq!(sources[1]["ignored"], true);
    // Contents must never be inlined in the listing.
    assert!(sources[0].get("content").is_none());
}

#[test]
fn inspect_handles_null_sources_content() {
    let map = format!(
        r#"{{"version":3,"sources":["a.js","b.js"],"sourcesContent":["A",null],"mappings":"{}"}}"#,
        vlq_segment(&[0, 0, 0, 0])
    );
    let report = parse(&sourcemap_inspect(map.as_bytes(), "{}"));
    let sources = report["sources"].as_array().unwrap();
    assert_eq!(sources[0]["has_content"], true);
    assert_eq!(sources[0]["content_bytes"], 1);
    assert_eq!(sources[1]["has_content"], false);
    assert_eq!(sources[1]["content_bytes"], Value::Null);
    assert_eq!(sources[1]["content_sha256"], Value::Null);
}

#[test]
fn inspect_index_reports_sections() {
    let report = parse(&sourcemap_inspect(&index_map_embedded(), "{}"));
    assert_eq!(report["kind"], "index");
    assert_eq!(report["sections_count"], 2);
    assert_eq!(report["unresolved_sections"], 0);
    let sections = report["sections"].as_array().unwrap();
    assert_eq!(sections[0]["offset"], json!({"line": 0, "column": 0}));
    assert_eq!(sections[0]["embedded"], true);
    assert_eq!(sections[0]["embedded_kind"], "regular");
    assert_eq!(sections[0]["sources_count"], 1);
    assert_eq!(sections[0]["mappings_count"], 1);
    assert_eq!(sections[1]["offset"], json!({"line": 5, "column": 10}));
    // Regular-only fields stay null on index maps.
    assert_eq!(report["sources_count"], Value::Null);
    assert_eq!(report["mappings_count"], Value::Null);
}

#[test]
fn inspect_index_marks_unresolved_sections() {
    let report = parse(&sourcemap_inspect(&index_map_external(), "{}"));
    assert_eq!(report["kind"], "index");
    assert_eq!(report["unresolved_sections"], 1);
    let sections = report["sections"].as_array().unwrap();
    assert_eq!(sections[1]["embedded"], false);
    assert_eq!(sections[1]["url"], "https://cdn.example.com/part2.js.map");
    assert!(!report["warnings"].as_array().unwrap().is_empty());
}

#[test]
fn inspect_hermes_kind() {
    let report = parse(&sourcemap_inspect(&hermes_map(), "{}"));
    assert_eq!(report["kind"], "hermes");
    assert_eq!(report["x_facebook_sources_present"], true);
    assert_eq!(report["sources_count"], 1);
    assert_eq!(report["mappings_count"], 1);
}

#[test]
fn inspect_caps_sources_list() {
    let mut map = String::from(r#"{"version":3,"sources":["#);
    for index in 0..20 {
        if index > 0 {
            map.push(',');
        }
        map.push_str(&format!("\"s{index}.js\""));
    }
    map.push_str(&format!(r#"],"mappings":"{}"}}"#, vlq_segment(&[0, 0, 0, 0])));
    let report = parse(&sourcemap_inspect(
        map.as_bytes(),
        r#"{"maxSources":5}"#,
    ));
    assert_eq!(report["sources"].as_array().unwrap().len(), 5);
    assert_eq!(report["sources_count"], 20);
    assert_eq!(report["truncated"], true);
}

#[test]
fn inspect_minimal_and_headerless_maps() {
    // No mappings, no sources: still a valid regular map.
    let report = parse(&sourcemap_inspect(br#"{"version":3}"#, "{}"));
    assert_eq!(report["kind"], "regular");
    assert_eq!(report["mappings_count"], 0);
    assert_eq!(report["sources_count"], 0);

    // Anti-XSSI garbage header is stripped like upstream.
    let mut prefixed = b")]}'\n".to_vec();
    prefixed.extend_from_slice(&fixture_map());
    let report = parse(&sourcemap_inspect(&prefixed, "{}"));
    assert_eq!(report["kind"], "regular");
    assert_eq!(report["mappings_count"], 5);
}

// ---------------------------------------------------------------------------
// lookup
// ---------------------------------------------------------------------------

#[test]
fn lookup_exact_hit() {
    let report = parse(&sourcemap_lookup(&fixture_map(), r#"{"line":0,"column":0}"#));
    assert_eq!(report["found"], true);
    let token = &report["token"];
    assert_eq!(token["generated"], json!({"line": 0, "column": 0}));
    assert_eq!(token["mapped"], true);
    assert_eq!(token["source"], "webpack://demo/./src/alpha.js");
    assert_eq!(token["source_index"], 0);
    assert_eq!(token["original"], json!({"line": 0, "column": 0}));
    assert_eq!(token["name"], "alphaFn");
    assert_eq!(token["is_range"], false);
}

#[test]
fn lookup_nearest_between_mappings() {
    // Between (0,0) and (0,10) the greatest lower bound is (0,0).
    let report = parse(&sourcemap_lookup(&fixture_map(), r#"{"line":0,"column":5}"#));
    assert_eq!(report["found"], true);
    assert_eq!(report["token"]["generated"], json!({"line": 0, "column": 0}));
    assert_eq!(report["token"]["original"], json!({"line": 0, "column": 0}));

    // Past the last segment of the line clamps to the final token.
    let report = parse(&sourcemap_lookup(&fixture_map(), r#"{"line":0,"column":999}"#));
    assert_eq!(report["token"]["source"], "webpack://demo/./src/beta.js");
    assert_eq!(report["token"]["name"], "betaFn");

    // A generated line with no segments resolves to the previous line's tail.
    let report = parse(&sourcemap_lookup(&fixture_map(), r#"{"line":1,"column":0}"#));
    assert_eq!(report["found"], true);
    assert_eq!(report["token"]["generated"], json!({"line": 0, "column": 20}));
}

#[test]
fn lookup_unmapped_token() {
    let report = parse(&sourcemap_lookup(&fixture_map(), r#"{"line":2,"column":5}"#));
    assert_eq!(report["found"], true);
    assert_eq!(report["token"]["mapped"], false);
    assert_eq!(report["token"]["source"], Value::Null);
    assert_eq!(report["token"]["original"], Value::Null);
}

#[test]
fn lookup_miss_empty_map() {
    let map = br#"{"version":3,"sources":[],"mappings":""}"#;
    let report = parse(&sourcemap_lookup(map, r#"{"line":0,"column":0}"#));
    assert_eq!(report["found"], false);
    assert!(report.get("error").is_none());
}

#[test]
fn lookup_index_map() {
    let map = index_map_embedded();
    let report = parse(&sourcemap_lookup(&map, r#"{"line":0,"column":0}"#));
    assert_eq!(report["token"]["source"], "a.js");
    assert_eq!(report["token"]["name"], "aFn");

    // Second section offsets line 5 column 10.
    let report = parse(&sourcemap_lookup(&map, r#"{"line":5,"column":10}"#));
    assert_eq!(report["token"]["source"], "b.js");
    assert_eq!(report["token"]["generated"], json!({"line": 5, "column": 10}));
}

#[test]
fn lookup_index_external_section_misses() {
    let report = parse(&sourcemap_lookup(&index_map_external(), r#"{"line":9,"column":0}"#));
    assert_eq!(report["found"], false);
    assert!(!report["warnings"].as_array().unwrap().is_empty());
}

#[test]
fn lookup_hermes_map() {
    let report = parse(&sourcemap_lookup(&hermes_map(), r#"{"line":0,"column":0}"#));
    assert_eq!(report["found"], true);
    assert_eq!(report["token"]["source"], "input.js");
}

#[test]
fn lookup_range_mappings() {
    // "AQAA" decodes to bitfield [1,0,...]: first segment is a range token.
    let map = format!(
        r#"{{"version":3,"sources":["a.js"],"names":["f"],"mappings":"{}","rangeMappings":"B"}}"#,
        vlq_segment(&[0, 0, 0, 0, 0])
    );
    let report = parse(&sourcemap_lookup(map.as_bytes(), r#"{"line":0,"column":7}"#));
    assert_eq!(report["found"], true);
    assert_eq!(report["token"]["is_range"], true);
    // Range token offsets the reported original column by the query column.
    assert_eq!(report["token"]["original"], json!({"line": 0, "column": 7}));
}

#[test]
fn lookup_requires_line_and_column() {
    assert_eq!(
        code(&sourcemap_lookup(&fixture_map(), r#"{"column":0}"#)),
        "missing_option"
    );
    assert_eq!(
        code(&sourcemap_lookup(&fixture_map(), r#"{"line":0}"#)),
        "missing_option"
    );
}

// ---------------------------------------------------------------------------
// reverse_lookup
// ---------------------------------------------------------------------------

#[test]
fn reverse_lookup_exact_and_suffix_sources() {
    let map = fixture_map();

    // Exact resolved name.
    let report = parse(&sourcemap_reverse_lookup(
        &map,
        r#"{"source":"webpack://demo/./src/alpha.js","line":0}"#,
    ));
    assert_eq!(report["found"], true);
    assert_eq!(report["position_count"], 2);
    assert_eq!(
        report["positions"],
        json!([
            {"line": 0, "column": 0, "name": "alphaFn", "is_range": false},
            {"line": 0, "column": 10, "name": null, "is_range": false}
        ])
    );

    // Path-suffix resolution reaches the same source.
    let report = parse(&sourcemap_reverse_lookup(
        &map,
        r#"{"source":"src/alpha.js","line":0}"#,
    ));
    assert_eq!(report["matched_sources"], json!(["webpack://demo/./src/alpha.js"]));
    assert_eq!(report["position_count"], 2);

    // Basename-only also resolves via the / boundary rule.
    let report = parse(&sourcemap_reverse_lookup(
        &map,
        r#"{"source":"alpha.js","line":1,"column":0}"#,
    ));
    assert_eq!(report["positions"], json!([{"line": 2, "column": 0, "name": null, "is_range": false}]));
}

#[test]
fn reverse_lookup_column_filter_and_index() {
    let map = fixture_map();
    let report = parse(&sourcemap_reverse_lookup(
        &map,
        r#"{"source":"src/alpha.js","line":0,"column":10}"#,
    ));
    assert_eq!(report["position_count"], 1);
    assert_eq!(report["positions"][0]["column"], 10);

    let report = parse(&sourcemap_reverse_lookup(
        &map,
        r#"{"sourceIndex":1,"line":5,"column":2}"#,
    ));
    assert_eq!(report["positions"], json!([{"line": 0, "column": 20, "name": "betaFn", "is_range": false}]));
}

#[test]
fn reverse_lookup_misses() {
    let map = fixture_map();
    // Unknown source string resolves to nothing.
    let report = parse(&sourcemap_reverse_lookup(
        &map,
        r#"{"source":"gamma.js","line":0}"#,
    ));
    assert_eq!(report["found"], false);
    assert_eq!(report["matched_sources"], json!([]));
    assert_eq!(report["position_count"], 0);

    // Valid source, unmapped line.
    let report = parse(&sourcemap_reverse_lookup(
        &map,
        r#"{"source":"alpha.js","line":99}"#,
    ));
    assert_eq!(report["found"], false);
    assert_eq!(report["position_count"], 0);
    assert_eq!(report["scanned_tokens"], 5);
}

#[test]
fn reverse_lookup_index_flattens_first() {
    let report = parse(&sourcemap_reverse_lookup(
        &index_map_embedded(),
        r#"{"source":"b.js","line":0,"column":0}"#,
    ));
    assert_eq!(report["found"], true);
    assert_eq!(report["positions"], json!([{"line": 5, "column": 10, "name": null, "is_range": false}]));
}

#[test]
fn reverse_lookup_index_unresolved_errors() {
    assert_eq!(
        code(&sourcemap_reverse_lookup(
            &index_map_external(),
            r#"{"source":"a.js","line":0}"#,
        )),
        "unresolved_sections"
    );
}

#[test]
fn reverse_lookup_caps_positions() {
    // Eight segments on line 0, all sourced from a.js(0,0).
    let segments: Vec<String> = (0..8)
        .map(|index| vlq_segment(&[if index == 0 { 0 } else { 4 }, 0, 0, 0]))
        .collect();
    let map = format!(
        r#"{{"version":3,"sources":["a.js"],"mappings":"{}"}}"#,
        segments.join(",")
    );
    let report = parse(&sourcemap_reverse_lookup(
        map.as_bytes(),
        r#"{"source":"a.js","line":0,"maxPositions":3}"#,
    ));
    assert_eq!(report["position_count"], 3);
    assert_eq!(report["match_count"], 8);
    assert_eq!(report["truncated"], true);
}

#[test]
fn reverse_lookup_option_validation() {
    let map = fixture_map();
    assert_eq!(
        code(&sourcemap_reverse_lookup(&map, r#"{"source":"a.js"}"#)),
        "missing_option"
    );
    assert_eq!(
        code(&sourcemap_reverse_lookup(&map, r#"{"line":0}"#)),
        "missing_option"
    );
    assert_eq!(
        code(&sourcemap_reverse_lookup(
            &map,
            r#"{"sourceIndex":99,"line":0}"#,
        )),
        "source_not_found"
    );
    // sourceIndex wins over a non-matching source string.
    let report = parse(&sourcemap_reverse_lookup(
        &map,
        r#"{"sourceIndex":1,"source":"alpha.js","line":5,"column":2}"#,
    ));
    assert_eq!(report["found"], true);
}

// ---------------------------------------------------------------------------
// source extraction
// ---------------------------------------------------------------------------

#[test]
fn source_by_index_and_path() {
    let map = fixture_map();
    let bytes = source_impl(
        &map,
        &SourceOptionsIn {
            index: Some(0),
            path: None,
        },
    )
    .expect("extract by index");
    assert_eq!(bytes, b"const alpha = 1;\n");

    let bytes = source_impl(
        &map,
        &SourceOptionsIn {
            index: None,
            path: Some("beta.js".into()),
        },
    )
    .expect("extract by suffix path");
    assert_eq!(bytes, b"const beta = 2;\n");

    // index takes precedence when both are given.
    let bytes = source_impl(
        &map,
        &SourceOptionsIn {
            index: Some(1),
            path: Some("alpha.js".into()),
        },
    )
    .expect("index precedence");
    assert_eq!(bytes, b"const beta = 2;\n");
}

#[test]
fn source_errors() {
    let map = fixture_map();
    assert_eq!(
        code(&error_text(source_impl(
            &map,
            &SourceOptionsIn {
                index: Some(9),
                path: None
            }
        ))),
        "source_not_found"
    );
    assert_eq!(
        code(&error_text(source_impl(
            &map,
            &SourceOptionsIn {
                index: None,
                path: Some("nope.js".into())
            }
        ))),
        "source_not_found"
    );
    assert_eq!(
        code(&error_text(source_impl(
            &map,
            &SourceOptionsIn {
                index: None,
                path: None
            }
        ))),
        "missing_option"
    );

    // A source without embedded content.
    let map = br#"{"version":3,"sources":["a.js"],"sourcesContent":[null],"mappings":"AAAA"}"#;
    assert_eq!(
        code(&error_text(source_impl(
            map,
            &SourceOptionsIn {
                index: Some(0),
                path: None
            }
        ))),
        "no_source_content"
    );
}

#[test]
fn source_over_limit() {
    let big = "x".repeat(MAX_SOURCE_BYTES + 1);
    let map = format!(
        r#"{{"version":3,"sources":["big.js"],"sourcesContent":["{big}"],"mappings":"AAAA"}}"#
    );
    assert!(map.len() <= MAX_INPUT_BYTES);
    assert_eq!(
        code(&error_text(source_impl(
            map.as_bytes(),
            &SourceOptionsIn {
                index: Some(0),
                path: None
            }
        ))),
        "source_too_large"
    );
}

#[test]
fn source_from_index_map_uses_flattened_indexes() {
    let bytes = source_impl(
        &index_map_embedded(),
        &SourceOptionsIn {
            index: None,
            path: Some("b.js".into()),
        },
    )
    .expect("flattened source");
    assert_eq!(bytes, b"B!");
}

// ---------------------------------------------------------------------------
// flatten
// ---------------------------------------------------------------------------

#[test]
fn flatten_index_map() {
    let flattened = flatten_impl(&index_map_embedded()).expect("flatten");
    let reparsed = SourceMap::from_slice(&flattened).expect("flattened map parses");
    assert_eq!(reparsed.get_token_count(), 2);
    assert_eq!(reparsed.get_source_count(), 2);
    let token = reparsed.lookup_token(5, 10).expect("token in section two");
    assert_eq!(token.get_source(), Some("b.js"));
    assert_eq!(token.get_src(), (0, 0));
    // Re-encoded output is a regular v3 JSON document.
    let doc: Value = serde_json::from_slice(&flattened).unwrap();
    assert_eq!(doc["version"], 3);
    assert!(doc.get("sections").is_none());
}

#[test]
fn flatten_regular_map_normalizes() {
    let flattened = flatten_impl(&fixture_map()).expect("flatten regular");
    let reparsed = SourceMap::from_slice(&flattened).expect("parses");
    assert_eq!(reparsed.get_token_count(), 5);
    assert_eq!(reparsed.get_source_count(), 2);
}

#[test]
fn flatten_external_section_errors() {
    assert_eq!(
        code(&error_text(flatten_impl(&index_map_external()))),
        "unresolved_sections"
    );
}

#[test]
fn flatten_hermes_drops_scope_metadata() {
    let flattened = flatten_impl(&hermes_map()).expect("flatten hermes");
    let doc: Value = serde_json::from_slice(&flattened).unwrap();
    assert_eq!(doc["version"], 3);
    assert!(doc.get("x_facebook_sources").is_none());
}

// ---------------------------------------------------------------------------
// Malformed inputs, limits, determinism
// ---------------------------------------------------------------------------

#[test]
fn malformed_inputs_return_error_documents() {
    let cases: Vec<(Vec<u8>, &str)> = vec![
        (b"".to_vec(), "invalid_json"),
        (b"not json".to_vec(), "invalid_json"),
        (b"[]".to_vec(), "invalid_json"),
        (b"42".to_vec(), "invalid_json"),
        (br#"{"version":3,"sources":["a"],"mappings":"AAAA,AAA"}"#.to_vec(), "invalid_mappings"), // 3-field segment
        (br#"{"version":3,"sources":["a"],"mappings":"AAAAg"}"#.to_vec(), "invalid_mappings"),  // dangling continuation
        (br#"{"version":3,"sources":["a"],"names":[],"mappings":"AAAAA"}"#.to_vec(), "bad_name_reference"),
        (br#"{"version":3,"sources":[],"mappings":"AACA"}"#.to_vec(), "bad_source_reference"),
        (br#"{"version":3,"sources":["a"],"mappings":"AAAA","rangeMappings":"!!!"}"#.to_vec(), "invalid_mappings"),
        // serde_json accepts non-UTF-8 bytes inside strings; the VLQ parser
        // then rejects them as invalid base64 digits.
        (b"{\"version\":3,\"mappings\":\"\xde\xad\"}".to_vec(), "invalid_mappings"),
    ];
    for (input, expected) in cases {
        assert_eq!(
            code(&sourcemap_inspect(&input, "{}")),
            expected,
            "input {input:?}"
        );
        assert_eq!(
            code(&sourcemap_lookup(&input, r#"{"line":0,"column":0}"#)),
            expected
        );
        assert_eq!(
            code(&error_text(source_impl(
                &input,
                &SourceOptionsIn {
                    index: Some(0),
                    path: None
                }
            ))),
            expected
        );
        assert_eq!(code(&error_text(flatten_impl(&input))), expected);
    }
}

#[test]
fn deeply_nested_input_fails_without_panic() {
    let mut input = vec![b'['; 10_000];
    input.extend(std::iter::repeat(b']').take(10_000));
    for result in [
        sourcemap_inspect(&input, "{}"),
        sourcemap_lookup(&input, r#"{"line":0,"column":0}"#),
    ] {
        let parsed = parse(&result);
        assert_eq!(parsed["schema_version"], 1);
        assert!(parsed["error"].is_string());
    }
}

#[test]
fn vlq_overflow_is_bounded_error() {
    // A long run of continuation digits overflows i64 accumulation; the
    // outcome is an error document (code differs between checked and
    // wrapping builds, but it is never a crash or a silent success).
    let map = format!(
        r#"{{"version":3,"sources":["a"],"mappings":"{}"}}"#,
        "9".repeat(64)
    );
    let parsed = parse(&sourcemap_inspect(map.as_bytes(), "{}"));
    assert_eq!(parsed["schema_version"], 1);
    assert!(parsed["error"].is_string());

    // Zero-value continuations hit the VLQ shift overflow deterministically.
    let map = format!(
        r#"{{"version":3,"sources":["a"],"mappings":"{}"}}"#,
        "g".repeat(64)
    );
    assert_eq!(code(&sourcemap_inspect(map.as_bytes(), "{}")), "invalid_mappings");
}

#[test]
fn input_and_options_limits() {
    let over_input = vec![0u8; MAX_INPUT_BYTES + 1];
    assert_eq!(code(&sourcemap_inspect(&over_input, "{}")), "input_too_large");
    assert_eq!(
        code(&sourcemap_lookup(&over_input, "{}")),
        "input_too_large"
    );
    let big_options = format!("{{\"pad\":\"{}\"}}", " ".repeat(MAX_OPTIONS_BYTES));
    assert_eq!(
        code(&sourcemap_inspect(&fixture_map(), &big_options)),
        "options_too_large"
    );
    assert_eq!(
        code(&sourcemap_lookup(&fixture_map(), &big_options)),
        "options_too_large"
    );
    // At-limit options still parse.
    let ok_options = format!("{{\"pad\":\"{}\"}}", " ".repeat(MAX_OPTIONS_BYTES - 16));
    let report = parse(&sourcemap_inspect(&fixture_map(), &ok_options));
    assert_eq!(report["schema_version"], 1);
}

#[test]
fn options_edge_cases() {
    let map = fixture_map();
    for bad in ["{", "not json", "[1]", "42", "\"x\"", "null", "{\"line\":-1}", "{\"line\":\"x\"}"] {
        assert_eq!(
            code(&sourcemap_lookup(&map, bad)),
            "options_invalid",
            "options {bad:?}"
        );
    }
    for ok in ["", "   ", "{}", "{\"futureOption\":123}"] {
        let report = parse(&sourcemap_inspect(&map, ok));
        assert_eq!(report["schema_version"], 1, "options {ok:?}");
        assert!(report.get("error").is_none());
    }
    // Whitespace-only and empty options behave like {}.
    assert_eq!(
        sourcemap_lookup(&map, ""),
        sourcemap_lookup(&map, r#"{}"#)
    );
}

#[test]
fn empty_options_valid_for_every_op() {
    let map = fixture_map();
    assert_eq!(parse(&sourcemap_inspect(&map, "{}"))["kind"], "regular");
    assert!(parse(&sourcemap_lookup(&map, "{}"))["error"].is_string());
    assert!(parse(&sourcemap_reverse_lookup(&map, "{}"))["error"].is_string());
    assert!(source_impl(
        &map,
        &SourceOptionsIn {
            index: None,
            path: None
        }
    )
    .is_err());
    assert!(flatten_impl(&map).is_ok());
}

#[test]
fn deterministic_outputs() {
    for map in [fixture_map(), index_map_embedded(), index_map_external(), hermes_map()] {
        assert_eq!(
            sourcemap_inspect(&map, "{}"),
            sourcemap_inspect(&map, "{}")
        );
        assert_eq!(
            sourcemap_lookup(&map, r#"{"line":0,"column":0}"#),
            sourcemap_lookup(&map, r#"{"line":0,"column":0}"#)
        );
        assert_eq!(
            sourcemap_reverse_lookup(&map, r#"{"line":0,"column":0,"source":"a.js"}"#),
            sourcemap_reverse_lookup(&map, r#"{"line":0,"column":0,"source":"a.js"}"#)
        );
        assert_eq!(flatten_impl(&map).ok(), flatten_impl(&map).ok());
    }
}

#[test]
fn upstream_doc_example_decodes() {
    // The example embedded in the crate's own documentation.
    let input: &[u8] = br#"{
        "version":3,
        "sources":["coolstuff.js"],
        "names":["x","alert"],
        "mappings":"AAAA,GAAIA,GAAI,EACR,IAAIA,GAAK,EAAG,CACVC,MAAM"
    }"#;
    let report = parse(&sourcemap_lookup(input, r#"{"line":0,"column":0}"#));
    assert_eq!(report["found"], true);
    assert_eq!(report["token"]["source"], "coolstuff.js");
    let report = parse(&sourcemap_inspect(input, "{}"));
    assert_eq!(report["sources_count"], 1);
    assert_eq!(report["names_count"], 2);
}

