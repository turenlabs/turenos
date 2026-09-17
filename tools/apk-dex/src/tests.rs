//! Unit tests: every operation against fixtures built byte-for-byte in
//! fixtures.rs, plus malformed/truncated/oversized/determinism coverage.

use serde_json::Value;

use crate::fixtures::*;
use crate::{apk_inspect, axml_decode, dex_inspect, MAX_INPUT_BYTES, MAX_OPTIONS_BYTES};

const OPTS: &str = "{}";

fn ok(text: &str) -> Value {
    let value: Value = serde_json::from_str(text).expect("valid json");
    assert_eq!(value["schema_version"], 1, "{text}");
    assert!(value.get("error").is_none(), "{text}");
    value
}

fn err(text: &str) -> String {
    let value: Value = serde_json::from_str(text).expect("valid json");
    assert_eq!(value["schema_version"], 1, "{text}");
    value["error"]
        .as_str()
        .unwrap_or_else(|| panic!("error code: {text}"))
        .to_string()
}

// ---------------------------------------------------------------------------
// axml_decode
// ---------------------------------------------------------------------------

#[test]
fn axml_decodes_manifest() {
    let report = ok(&axml_decode(&axml_fixture(), OPTS));
    assert_eq!(report["kind"], "axml");
    assert_eq!(report["elements"], 4);
    assert_eq!(report["attributes"], 5);
    let xml = report["xml"].as_str().unwrap();
    assert!(xml.contains(r#"<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app" android:versionCode="33">"#), "{xml}");
    assert!(xml.contains(r#"<uses-sdk android:minSdkVersion="21">"#), "{xml}");
    assert!(xml.contains(r#"<activity android:name=".MainActivity" android:exported="true">"#), "{xml}");
    assert!(xml.contains("</manifest>"), "{xml}");
    assert_eq!(report["namespaces"][0]["prefix"], "android");
    assert_eq!(report["namespaces"][0]["uri"], "http://schemas.android.com/apk/res/android");
    assert_eq!(report["string_pool"]["count"], 13);
    assert_eq!(report["string_pool"]["utf8"], true);
    assert_eq!(report["truncated"], false);
}

#[test]
fn axml_decodes_non_manifest_root_and_cdata() {
    const NO: u32 = 0xffff_ffff;
    let strings = ["LinearLayout", "TextView", "text", "Hello & <world>"];
    let mut body = string_pool_chunk(&strings);
    start_element(&mut body, NO, 0, &[]);
    start_element(&mut body, NO, 1, &[(NO, 2, 3, 0x03, 3)]);
    // CDATA chunk: data_idx then typed value.
    let mut cdata = Vec::new();
    w32(&mut cdata, 3);
    w16(&mut cdata, 8);
    cdata.push(0);
    cdata.push(0x03);
    w32(&mut cdata, 3);
    node_ext(&mut body, 0x0104, &cdata);
    end_element(&mut body, NO, 1);
    end_element(&mut body, NO, 0);
    let mut doc = Vec::new();
    chunk_header(&mut doc, 0x0003, 8, (8 + body.len()) as u32);
    doc.extend_from_slice(&body);

    let report = ok(&axml_decode(&doc, OPTS));
    let xml = report["xml"].as_str().unwrap();
    assert!(xml.contains("<LinearLayout>"), "{xml}");
    assert!(xml.contains(r#"<TextView text="Hello &amp; &lt;world&gt;">"#), "{xml}");
    assert!(xml.contains("Hello &amp; &lt;world&gt;"), "{xml}");
}

#[test]
fn axml_typed_values() {
    const NO: u32 = 0xffff_ffff;
    let strings = ["el", "dim", "frac", "col", "ref", "flt"];
    let mut body = string_pool_chunk(&strings);
    start_element(
        &mut body,
        NO,
        0,
        &[
            (NO, 1, NO, 0x05, (16 << 8) | (3 << 4) | 1), // dimension 16dip
            (NO, 2, NO, 0x06, 0x4000_0000),              // fraction 50% (0.5 x 2^23 mantissa, radix 0)
            (NO, 3, NO, 0x1c, 0x80ff_0000),              // color argb8
            (NO, 4, NO, 0x01, 0x7f01_0001),              // reference
            (NO, 5, NO, 0x04, f32::to_bits(2.5)),        // float
        ],
    );
    end_element(&mut body, NO, 0);
    let mut doc = Vec::new();
    chunk_header(&mut doc, 0x0003, 8, (8 + body.len()) as u32);
    doc.extend_from_slice(&body);

    let report = ok(&axml_decode(&doc, OPTS));
    let xml = report["xml"].as_str().unwrap();
    assert!(xml.contains(r#"dim="16dip""#), "{xml}");
    assert!(xml.contains(r#"frac="50%""#), "{xml}");
    assert!(xml.contains(r##"col="#80ff0000""##), "{xml}");
    assert!(xml.contains(r#"ref="@0x7f010001""#), "{xml}");
    assert!(xml.contains(r#"flt="2.5""#), "{xml}");
}

#[test]
fn axml_rejects_bad_magic_and_truncation() {
    assert_eq!(err(&axml_decode(b"not-xml-at-all", OPTS)), "bad_magic");
    assert_eq!(err(&axml_decode(&[0x03, 0x00], OPTS)), "truncated");
    assert_eq!(err(&axml_decode(&[], OPTS)), "too_small");
    // Truncated string pool: declared size overruns document.
    let mut bad = axml_fixture();
    let _ = bad.pop();
    let report = axml_decode(&bad[..bad.len() - 30], OPTS);
    // Either an error doc or a partial report with warnings — never a panic.
    let value: Value = serde_json::from_str(&report).unwrap();
    assert_eq!(value["schema_version"], 1);
}

#[test]
fn axml_corrupt_pool_offsets_dont_panic() {
    let mut doc = axml_fixture();
    // String pool chunk starts at offset 8; offset table at 8+28.
    // Set every string offset to 0xfffffff0.
    for i in 0..13 {
        let at = 8 + 28 + i * 4;
        doc[at..at + 4].copy_from_slice(&0xffff_fff0u32.to_le_bytes());
    }
    let report = ok(&axml_decode(&doc, OPTS));
    let warnings = report["warnings"].as_array().unwrap();
    assert!(warnings.iter().any(|w| w == "string_offset_out_of_range"), "{report}");
}

#[test]
fn axml_xml_cap() {
    let report = ok(&axml_decode(&axml_fixture(), r#"{"maxXmlBytes": 120}"#));
    assert_eq!(report["xml_truncated"], true);
    assert!(report["xml"].as_str().unwrap().len() <= 160);
}

#[test]
fn axml_determinism() {
    let a = axml_decode(&axml_fixture(), OPTS);
    let b = axml_decode(&axml_fixture(), OPTS);
    assert_eq!(a, b);
}

// ---------------------------------------------------------------------------
// dex_inspect
// ---------------------------------------------------------------------------

#[test]
fn dex_reports_header_tables_and_classes() {
    let report = ok(&dex_inspect(&dex_fixture(), OPTS));
    assert_eq!(report["kind"], "dex");
    assert_eq!(report["header"]["version"], "035");
    assert_eq!(report["header"]["string_ids"], 18);
    assert_eq!(report["header"]["class_defs"], 2);
    assert_eq!(report["header"]["endian_tag"], "0x12345678");
    assert_eq!(report["counts"]["strings"], 18);
    assert_eq!(report["counts"]["methods"], 4);

    let classes = report["classes"].as_array().unwrap();
    assert_eq!(classes.len(), 2);
    assert_eq!(classes[0]["name"], "Lcom/example/app/MainActivity;");
    assert_eq!(classes[0]["superclass"], "Landroid/app/Activity;");
    assert_eq!(classes[0]["source_file"], "MainActivity.java");
    assert_eq!(classes[0]["methods"], 2);
    assert_eq!(classes[1]["native_methods"], 1);
    assert_eq!(report["stats"]["native_methods"], 1);

    let protos = report["protos"].as_array().unwrap();
    assert_eq!(protos[1]["params"][0], "Landroid/os/Bundle;");
    assert_eq!(protos[1]["return_type"], "V");

    let strings = report["strings"].as_array().unwrap();
    assert_eq!(strings.len(), 18);
    assert_eq!(strings[0]["value"], "Lcom/example/app/MainActivity;");

    let kinds: Vec<&str> = report["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["kind"].as_str().unwrap())
        .collect();
    for expected in ["reflection", "crypto", "su_binary", "dynamic_loading", "exec", "native"] {
        assert!(kinds.contains(&expected), "missing {expected} in {kinds:?}");
    }
    assert!(report["map"].as_array().unwrap().len() >= 10);
}

#[test]
fn dex_malformed_inputs() {
    assert_eq!(err(&dex_inspect(b"\x00", OPTS)), "too_small");
    assert_eq!(err(&dex_inspect(b"not a dex file at all", OPTS)), "bad_magic");
    assert_eq!(err(&dex_inspect(b"dex\n035\0", OPTS)), "truncated_header");

    // Table offset past EOF.
    let mut bad = dex_fixture();
    bad[60..64].copy_from_slice(&0x00ff_ff00u32.to_le_bytes()); // string_ids_off
    assert_eq!(err(&dex_inspect(&bad, OPTS)), "table_out_of_bounds");

    // Bad endian tag.
    let mut bad2 = dex_fixture();
    bad2[40..44].copy_from_slice(&0x7856_3412u32.to_le_bytes());
    assert_eq!(err(&dex_inspect(&bad2, OPTS)), "unsupported_endian");

    // Corrupt string data offset: out-of-range pointer per entry.
    let mut bad3 = dex_fixture();
    bad3[0x70..0x74].copy_from_slice(&0xffff_fff0u32.to_le_bytes());
    let report = ok(&dex_inspect(&bad3, OPTS));
    let warnings = report["warnings"].as_array().unwrap();
    assert!(warnings.iter().any(|w| w == "string_data_out_of_range"), "{report}");
}

#[test]
fn dex_limits_and_determinism() {
    let report = ok(&dex_inspect(&dex_fixture(), r#"{"limit": 5}"#));
    assert_eq!(report["strings"].as_array().unwrap().len(), 5);
    assert_eq!(report["truncated"], true);
    let a = dex_inspect(&dex_fixture(), OPTS);
    let b = dex_inspect(&dex_fixture(), OPTS);
    assert_eq!(a, b);
    let no_strings = ok(&dex_inspect(&dex_fixture(), r#"{"includeStrings": false}"#));
    assert_eq!(no_strings["strings"].as_array().unwrap().len(), 0);
    assert_eq!(no_strings["counts"]["strings"], 18);
}

#[test]
fn dex_via_apk_input() {
    let apk = apk_fixture();
    let report = ok(&dex_inspect(&apk, OPTS));
    assert_eq!(report["counts"]["classes"], 2);
    let report2 = ok(&dex_inspect(&apk, r#"{"dexIndex": 2}"#));
    assert_eq!(report2["counts"]["classes"], 2);
    assert_eq!(err(&dex_inspect(&apk, r#"{"dexIndex": 7}"#)), "dex_not_found");
}

// ---------------------------------------------------------------------------
// apk_inspect
// ---------------------------------------------------------------------------

#[test]
fn apk_lists_entries_decodes_manifest_and_dex() {
    let report = ok(&apk_inspect(&apk_fixture(), OPTS));
    assert_eq!(report["kind"], "apk");
    assert_eq!(report["zip"]["entry_count"], 6);
    let names: Vec<&str> = report["zip"]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"AndroidManifest.xml"));
    assert!(names.contains(&"classes.dex"));
    assert!(names.contains(&"META-INF/CERT.RSA"));
    // The manifest entry is deflated in the fixture.
    let manifest_entry = report["zip"]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["name"] == "AndroidManifest.xml")
        .unwrap();
    assert_eq!(manifest_entry["method_name"], "deflated");

    assert_eq!(report["manifest"]["present"], true);
    assert_eq!(report["manifest"]["decoded"], true);
    let xml = report["manifest"]["xml"].as_str().unwrap();
    assert!(xml.contains(r#"package="com.example.app""#), "{xml}");

    let dex = report["dex_files"].as_array().unwrap();
    assert_eq!(dex.len(), 2);
    assert_eq!(dex[0]["name"], "classes.dex");
    assert_eq!(dex[0]["dex_version"], "035");
    assert_eq!(dex[0]["sha256"].as_str().unwrap().len(), 64);

    let packages = report["resources_arsc"]["packages"].as_array().unwrap();
    assert_eq!(packages[0]["name"], "com.example.app");
    assert_eq!(packages[0]["id"], "0x7f");

    assert_eq!(report["signing"]["v1_signed"], true);
    assert_eq!(report["signing"]["v2_block"], false);
    let v1 = report["signing"]["v1_entries"].as_array().unwrap();
    assert!(v1.iter().any(|e| e == "META-INF/CERT.RSA"));
}

#[test]
fn apk_detects_v2_signing_block() {
    let report = ok(&apk_inspect(&apk_signed_fixture(), OPTS));
    assert_eq!(report["signing"]["v2_block"], true);
    let schemes = report["signing"]["schemes"].as_array().unwrap();
    assert_eq!(schemes[0]["id"], "0x7109871a");
    assert_eq!(schemes[0]["name"], "v2");
}

#[test]
fn apk_dex_details_option() {
    let report = ok(&apk_inspect(&apk_fixture(), r#"{"dexDetails": true}"#));
    let dex = report["dex_files"].as_array().unwrap();
    assert_eq!(dex[0]["dex"]["counts"]["classes"], 2);
    let kinds: Vec<&str> = dex[0]["dex"]["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["kind"].as_str().unwrap())
        .collect();
    assert!(kinds.contains(&"crypto"));
}

#[test]
fn apk_malformed_inputs() {
    assert_eq!(err(&apk_inspect(b"not a zip", OPTS)), "bad_magic");
    assert_eq!(err(&apk_inspect(b"PK\x03\x04", OPTS)), "missing_eocd");
    // Valid zip signature then garbage.
    let mut bad = vec![0x50, 0x4b, 0x03, 0x04];
    bad.extend_from_slice(&[0u8; 64]);
    let code = err(&apk_inspect(&bad, OPTS));
    assert!(matches!(code.as_str(), "missing_eocd" | "malformed_eocd" | "zip_parse_failed"), "{code}");
}

#[test]
fn apk_determinism() {
    let a = apk_inspect(&apk_fixture(), OPTS);
    let b = apk_inspect(&apk_fixture(), OPTS);
    assert_eq!(a, b);
}

// ---------------------------------------------------------------------------
// shared limits
// ---------------------------------------------------------------------------

#[test]
fn input_and_options_limits() {
    let huge = vec![0u8; MAX_INPUT_BYTES + 1];
    assert_eq!(err(&axml_decode(&huge, OPTS)), "input_too_large");
    assert_eq!(err(&dex_inspect(&huge, OPTS)), "input_too_large");
    assert_eq!(err(&apk_inspect(&huge, OPTS)), "input_too_large");

    let big_opts = format!(r#"{{"pad":"{}"}}"#, "x".repeat(MAX_OPTIONS_BYTES));
    assert_eq!(err(&axml_decode(&axml_fixture(), &big_opts)), "options_too_large");
    assert_eq!(err(&dex_inspect(&dex_fixture(), &big_opts)), "options_too_large");
    assert_eq!(err(&apk_inspect(&apk_fixture(), &big_opts)), "options_too_large");

    assert_eq!(err(&axml_decode(&axml_fixture(), "{oops")), "options_invalid");
    assert_eq!(err(&dex_inspect(&dex_fixture(), "[1]")), "options_invalid");
    assert_eq!(err(&apk_inspect(&apk_fixture(), "42")), "options_invalid");
}
