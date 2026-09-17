//! Unit tests run the public ops against hand-crafted RTF buffers with real
//! syntax: nested groups, `\'hh` escapes, `\uN` resolution, objdata with real
//! OLE magic, corrupt hex streams, unbalanced braces, obfuscation patterns,
//! ignorable groups, field instructions, and deep nesting.

use super::*;
use serde_json::Value;
use sha2::Digest;

fn parse(output: String) -> Value {
    serde_json::from_str(&output).expect("output must be JSON")
}

fn inspect(rtf: &str) -> Value {
    parse(rtf_inspect(rtf.as_bytes(), "{}"))
}

fn objects(rtf: &str) -> Value {
    parse(rtf_objects(rtf.as_bytes(), "{}"))
}

fn audit(rtf: &str) -> Value {
    parse(rtf_audit(rtf.as_bytes(), "{}"))
}

fn text(rtf: &str) -> Value {
    parse(rtf_text(rtf.as_bytes(), "{}"))
}

fn kinds(report: &Value) -> Vec<String> {
    report["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["kind"].as_str().unwrap().to_string())
        .collect()
}

const MINIMAL: &str = r"{\rtf1\ansi\deff0 Hello plain text.}";

#[test]
fn minimal_document() {
    let r = inspect(MINIMAL);
    assert_eq!(r["schema_version"], 1);
    assert_eq!(r["valid_rtf"], true);
    assert_eq!(r["rtf_version"], 1);
    assert_eq!(r["charset"], "ansi");
    assert_eq!(r["codepage"], 1252);
    assert_eq!(r["groups"]["total"], 1);
    assert_eq!(r["groups"]["max_depth"], 1);
    assert!(r["input_sha256"].as_str().unwrap().len() == 64);
}

#[test]
fn nested_groups_depth() {
    let r = inspect(r"{\rtf1{\a{\b{\c{\d deep}}}}}");
    assert_eq!(r["groups"]["max_depth"], 5);
    assert_eq!(r["groups"]["total"], 5);
}

#[test]
fn text_hex_escape_codepage() {
    // \'e9 is é in cp1252 (default \ansi page).
    let r = text(r"{\rtf1\ansi na\'efve r\'e9sum\'e9}");
    assert_eq!(r["text"], "na\u{ef}ve r\u{e9}sum\u{e9}");
    assert_eq!(r["truncated"], false);
}

#[test]
fn text_unicode_char_with_fallback() {
    // \u233 is é; the single-byte fallback '?' is skipped (default \uc1).
    let r = text(r"{\rtf1\ansi caf\u233?}");
    assert_eq!(r["text"], "caf\u{e9}");
}

#[test]
fn text_unicode_uc0_keeps_fallback() {
    let r = text(r"{\rtf1\ansi\uc0 caf\u233?}");
    assert_eq!(r["text"], "caf\u{e9}?");
}

#[test]
fn text_unicode_uc2_skips_two() {
    let r = text(r"{\rtf1\ansi\uc2 x\u233\'e9?y}");
    assert_eq!(r["text"], "x\u{e9}y");
}

#[test]
fn text_unicode_negative_and_surrogate() {
    // Negative \u wraps into the BMP; surrogate halves are invalid scalars.
    let r = text(r"{\rtf1\ansi a\u-251?b}");
    assert_eq!(r["text"], "a\u{FF05}b");
    let r2 = audit(r"{\rtf1\ansi x\u55357?y}");
    assert_eq!(r2["stats"]["unicode_anomalies"], 1);
    assert!(kinds(&r2).contains(&"unicode_anomaly".to_string()));
    let t2 = text(r"{\rtf1\ansi x\u55357?y}");
    assert!(t2["text"].as_str().unwrap().contains('\u{FFFD}'));
}

#[test]
fn text_paragraphs_and_controls() {
    let r = text(r"{\rtf1\ansi first\par second\line third\par\tab four}");
    assert_eq!(r["text"], "first\nsecond\nthird\n\tfour");
    assert_eq!(r["paragraphs"], 3);
}

#[test]
fn text_skips_destinations() {
    let r = text(
        r"{\rtf1\ansi{\fonttbl{\f0\froman Arial;}}{\colortbl;\red255\green0\blue0;}{\info{\title Secret}}body {\*\generator GenPro} text}",
    );
    let t = r["text"].as_str().unwrap();
    assert!(t.contains("body  text") || t.contains("body text"), "text: {t:?}");
    assert!(!t.contains("Arial"), "text: {t:?}");
    assert!(!t.contains("Secret"), "text: {t:?}");
    assert!(!t.contains("GenPro"), "text: {t:?}");
}

#[test]
fn font_table_parse() {
    let r = inspect(
        r"{\rtf1\ansi{\fonttbl{\f0\froman\fcharset0\fprq2{\*\panose 02020603050405020304}Times New Roman;}{\f1\fswiss\fcharset2 Arial;}}}",
    );
    assert_eq!(r["font_table"]["count"], 2);
    let fonts = r["font_table"]["fonts"].as_array().unwrap();
    assert_eq!(fonts[0]["index"], 0);
    assert_eq!(fonts[0]["family"], "roman");
    assert_eq!(fonts[0]["charset"], 0);
    assert_eq!(fonts[0]["pitch"], 2);
    assert_eq!(fonts[0]["name"], "Times New Roman");
    assert_eq!(fonts[1]["family"], "swiss");
    assert_eq!(fonts[1]["name"], "Arial");
    assert_eq!(r["panose"], "02020603050405020304");
}

#[test]
fn style_sheet_parse() {
    let r = inspect(
        r"{\rtf1\ansi{\stylesheet{\s0\sb240\sa60 Normal;}{\*\cs1\additive Default Paragraph Font;}{\s2\qc Heading 2;}}}",
    );
    assert_eq!(r["style_sheet"]["count"], 3);
    let styles = r["style_sheet"]["styles"].as_array().unwrap();
    assert_eq!(styles[0]["kind"], "paragraph");
    assert_eq!(styles[0]["name"], "Normal");
    assert_eq!(styles[1]["kind"], "character");
    assert_eq!(styles[1]["name"], "Default Paragraph Font");
    assert_eq!(styles[2]["name"], "Heading 2");
}

#[test]
fn color_table_parse() {
    let r = inspect(r"{\rtf1\ansi{\colortbl;\red255\green0\blue0;\red0\green128\blue255;}}");
    assert_eq!(r["color_table"]["count"], 3);
    let colors = r["color_table"]["colors"].as_array().unwrap();
    assert_eq!(colors[0]["r"], Value::Null); // auto color
    assert_eq!(colors[1]["r"], 255);
    assert_eq!(colors[2]["g"], 128);
}

#[test]
fn info_and_generator() {
    let r = inspect(
        r#"{\rtf1\ansi{\info{\title Quarterly Report}{\author J. Doe}{\creatim\yr2024\mo3\dy5\hr9\min30}{\nofpages7}{\version2}}{\*\generator Microsoft Word 16.0}}"#,
    );
    assert_eq!(r["info"]["title"], "Quarterly Report");
    assert_eq!(r["info"]["author"], "J. Doe");
    assert_eq!(r["info"]["creatim"], "2024-03-05 09:30:00");
    assert_eq!(r["info"]["nofpages"], "7");
    assert_eq!(r["generator"], "Microsoft Word 16.0");
}

#[test]
fn object_with_ole_objdata() {
    // Real OLE compound-file magic as the objdata payload.
    let ole = "d0cf11e0a6b11ae1";
    let rtf = format!(
        r"{{\rtf1\ansi{{\object\objemb\objw200\objh100{{\*\objclass Package}}{{\*\objdata {ole}}}}}}}"
    );
    let r = objects(&rtf);
    assert_eq!(r["object_count"], 1);
    let obj = &r["objects"][0];
    assert_eq!(obj["type"], "emb");
    assert_eq!(obj["objclass"], "Package");
    assert_eq!(obj["declared_w"], 200);
    assert_eq!(obj["declared_h"], 100);
    let od = &obj["objdata"];
    assert_eq!(od["present"], true);
    assert_eq!(od["decoded_bytes"], 8);
    assert_eq!(od["ole_magic"], true);
    assert_eq!(od["preview_hex"], ole);
    assert_eq!(od["bad_chars"], 0);
    assert_eq!(od["odd_hex"], false);
    // SHA-256 of the 8-byte OLE magic prefix.
    let digest = sha2::Sha256::digest(&[0xd0, 0xcf, 0x11, 0xe0, 0xa6, 0xb1, 0x1a, 0xe1]);
    assert_eq!(od["sha256"], hex(&digest));
    // Payload hex gated by the option.
    assert_eq!(od["payload_hex"], Value::Null);
    let r2 = parse(rtf_objects(rtf.as_bytes(), r#"{"include_payload_hex":true}"#));
    assert_eq!(r2["objects"][0]["objdata"]["payload_hex"], ole);
}

#[test]
fn object_result_span_and_pict() {
    let rtf = r"{\rtf1\ansi{\object\objemb{\*\objclass Word.Document.8}{\*\objdata d0cf11e0}{\result{\pict\wmetafile8 010203040506}}}}";
    let r = objects(rtf);
    let obj = &r["objects"][0];
    assert_eq!(obj["objclass"], "Word.Document.8");
    assert_eq!(obj["result"]["present"], true);
    assert_eq!(obj["result"]["contains_pict"], true);
    let a = audit(rtf);
    assert!(kinds(&a).contains(&"objdata_payload".to_string()));
    assert!(kinds(&a).contains(&"ole_compound_object".to_string()));
    assert!(kinds(&a).contains(&"suspicious_objclass".to_string()));
}

#[test]
fn objdata_corrupt_hex_stream() {
    // Odd length + non-hex characters are reported, never fatal.
    let rtf = r"{\rtf1\ansi{\object{\*\objdata d0cf11ezz5f}}}";
    let r = objects(rtf);
    let od = &r["objects"][0]["objdata"];
    assert_eq!(od["bad_chars"], 2); // 'z','z' are skipped
    assert_eq!(od["odd_hex"], true); // 9 hex digits
    assert_eq!(od["decoded_bytes"], 4);
    assert!(od["first_bad_offset"].as_u64().is_some());
    let a = audit(rtf);
    assert!(kinds(&a).contains(&"malformed_objdata".to_string()));
}

#[test]
fn audit_ole_package_finding() {
    let rtf = r"{\rtf1\ansi{\object{\*\objclass Package}{\*\objdata 4d5a}}}";
    let a = audit(rtf);
    let kinds = kinds(&a);
    assert!(kinds.contains(&"suspicious_objclass".to_string()));
    let f = a["findings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["kind"] == "suspicious_objclass")
        .unwrap();
    assert_eq!(f["severity"], "high");
}

#[test]
fn unbalanced_braces() {
    let a = audit(r"{\rtf1\ansi{\open{\open2 text}");
    assert_eq!(a["stats"]["unclosed_groups"], 2);
    assert!(kinds(&a).contains(&"unbalanced_braces".to_string()));
    let stray = audit(r"{\rtf1\ansi ok}}}");
    assert!(stray["stats"]["stray_closes"].as_u64().unwrap() >= 2);
    assert!(kinds(&stray).contains(&"stray_closing_brace".to_string()));
}

#[test]
fn trailing_data_flagged() {
    let a = audit(r"{\rtf1\ansi body}%%EOF-ish-trailer-garbage");
    assert!(a["stats"]["trailing_bytes"].as_u64().unwrap() > 0);
    assert!(kinds(&a).contains(&"trailing_data".to_string()));
}

#[test]
fn binary_blob_bin_control() {
    let a = audit("{\\rtf1\\ansi before\\bin4 \u{1}\u{2}\u{3}\u{4}after}");
    assert_eq!(a["stats"]["bin_blobs"], 1);
    assert_eq!(a["stats"]["bin_bytes"], 4);
    assert!(kinds(&a).contains(&"binary_blob".to_string()));
    // The binary bytes (which could contain braces) are skipped, not parsed.
    let a2 = audit("{\\rtf1\\ansi x\\bin6 {\'4z\\\\after}");
    assert_eq!(a2["stats"]["bin_bytes"], 6);
    let t = text("{\\rtf1\\ansi x\\bin6 {\'4z\\\\after}");
    assert_eq!(t["text"], "xafter");
}

#[test]
fn deep_nesting_flagged() {
    // Depth 10 crosses the >8 audit threshold.
    let mut rtf = String::from(r"{\rtf1");
    for _ in 0..9 {
        rtf.push('{');
    }
    rtf.push_str("x");
    for _ in 0..9 {
        rtf.push('}');
    }
    rtf.push('}');
    let a = audit(&rtf);
    assert_eq!(a["stats"]["max_depth"], 10);
    assert!(kinds(&a).contains(&"deep_nesting".to_string()));
}

#[test]
fn extreme_nesting_capped() {
    // 200-deep nesting: content past 64 is scanned but not interpreted.
    let mut rtf = String::from(r"{\rtf1");
    for _ in 0..199 {
        rtf.push('{');
    }
    rtf.push_str("deep\\par text");
    for _ in 0..199 {
        rtf.push('}');
    }
    rtf.push('}');
    let a = audit(&rtf);
    assert_eq!(a["stats"]["max_depth"], 200);
    let kinds = kinds(&a);
    assert!(kinds.contains(&"deep_nesting".to_string()));
    assert!(kinds.contains(&"extreme_nesting".to_string()));
    // Text inside the suppressed region is not extracted.
    let t = text(&rtf);
    assert!(!t["text"].as_str().unwrap().contains("deep"), "text: {:?}", t["text"]);
}

#[test]
fn hex_heavy_region_flagged() {
    // ≥32 consecutive \'hh escapes in body text.
    let mut rtf = String::from(r"{\rtf1\ansi ");
    for _ in 0..40 {
        rtf.push_str(r"\'4d");
    }
    rtf.push('}');
    let a = audit(&rtf);
    assert!(a["stats"]["max_hex_run"].as_u64().unwrap() >= 40);
    assert!(kinds(&a).contains(&"hex_heavy_region".to_string()));
}

#[test]
fn whitespace_fragmentation_flagged() {
    // "o b f u s c a t e d" — single characters split by spaces.
    let a = audit(r"{\rtf1\ansi o b f u s c a t e d}");
    assert!(kinds(&a).contains(&"fragmented_text".to_string()));
}

#[test]
fn single_letter_control_run_flagged() {
    let a = audit(r"{\rtf1\ansi\o\b\j\e\c\t\x\y\z body}");
    assert!(kinds(&a).contains(&"control_fragmentation".to_string()));
}

#[test]
fn ignorable_groups_skipped() {
    // {\*\...} destinations contribute no body text but are counted.
    let t = text(r"{\rtf1\ansi visible{\*\unknown comment data}more}");
    assert_eq!(t["text"], "visiblemore");
    let i = inspect(r"{\rtf1\ansi visible{\*\unknown comment data}more}");
    assert_eq!(i["groups"]["ignorable"], 1);
}

#[test]
fn field_instruction_flagged() {
    let rtf = r#"{\rtf1\ansi{\field{\*\fldinst HYPERLINK "http://evil.example/x"}{\fldrslt click me}}}"#;
    let i = inspect(rtf);
    assert_eq!(i["fields"]["count"], 1);
    assert_eq!(i["fields"]["items"][0]["keyword"], "HYPERLINK");
    assert_eq!(i["fields"]["items"][0]["url"], "http://evil.example/x");
    let a = audit(rtf);
    let kinds = kinds(&a);
    assert!(kinds.contains(&"field_external_ref".to_string()));
    // INCLUDETEXT is the highest-severity keyword.
    let inc = audit(r#"{\rtf1\ansi{\field{\*\fldinst INCLUDETEXT "\\\\host\\share\\f"}{\fldrslt x}}}"#);
    let f = inc["findings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["kind"] == "field_external_ref")
        .unwrap();
    assert_eq!(f["severity"], "high");
    // Field instructions are not body text; field results are.
    let t = text(rtf);
    assert_eq!(t["text"], "click me");
}

#[test]
fn file_table_flagged() {
    let rtf = r"{\rtf1\ansi{\*\filetbl{\file\fid1{\*\fname evil.exe}{\*\frelative C:\\temp}}body}}";
    let i = inspect(rtf);
    assert_eq!(i["file_table"]["count"], 1);
    assert_eq!(i["file_table"]["files"][0]["name"], "evil.exe");
    assert_eq!(i["file_table"]["files"][0]["path"], "C:\\temp");
    let a = audit(rtf);
    let kinds = kinds(&a);
    assert!(kinds.contains(&"file_table".to_string()));
    assert!(kinds.contains(&"embedded_file".to_string()));
}

#[test]
fn template_and_password_and_datastore() {
    let rtf = r#"{\rtf1\ansi{\*\template http://host/normal.dotm}{\*\password a4b3}{\*\datastore\msdef 0102}}"#;
    let i = inspect(rtf);
    assert_eq!(i["template"], "http://host/normal.dotm");
    assert_eq!(i["password_protection"], true);
    assert_eq!(i["data_stores"], 1);
    let a = audit(rtf);
    let kinds = kinds(&a);
    assert!(kinds.contains(&"template_path".to_string()));
    assert!(kinds.contains(&"password_protection".to_string()));
    assert!(kinds.contains(&"datastore".to_string()));
    let f = a["findings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["kind"] == "template_path")
        .unwrap();
    assert_eq!(f["severity"], "high");
}

#[test]
fn picture_summary() {
    let r = inspect(r"{\rtf1\ansi body{\pict\jpegblip\picw640\pich480\picwgoal1600\pichgoal1200 ffd8ffe0aa55}}");
    assert_eq!(r["pictures"]["count"], 1);
    let p = &r["pictures"]["items"][0];
    assert_eq!(p["type"], "jpegblip");
    assert_eq!(p["w"], 640);
    assert_eq!(p["h"], 480);
    assert_eq!(p["wgoal"], 1600);
    assert_eq!(p["hex_bytes"], 6);
    assert_eq!(p["data_bytes"], 6);
}

#[test]
fn mixed_encodings_flagged() {
    let a = audit(r"{\rtf1\ansi\ansicpg1252 text{\ansicpg1251 more}}");
    assert!(kinds(&a).contains(&"mixed_encodings".to_string()));
}

#[test]
fn histogram_top_sorted() {
    let r = inspect(r"{\rtf1\ansi a\par b\par c\pard d\par}");
    let top = r["control_words"]["top"].as_array().unwrap();
    assert_eq!(top[0]["name"], "par");
    assert_eq!(top[0]["count"], 3);
    assert!(r["control_words"]["distinct"].as_u64().unwrap() >= 4);
    // \rtf(1) \ansi(1) \par(3) \pard(1)
}

#[test]
fn malformed_hex_escape_recovered() {
    // \'zz is not hex: the escape is consumed, following bytes stay text.
    let t = text(r"{\rtf1\ansi a\'zzb}");
    let s = t["text"].as_str().unwrap();
    assert!(s.contains('a') && s.contains("zzb"), "text: {s:?}");
    let a = audit(r"{\rtf1\ansi a\'zzb}");
    assert!(kinds(&a).contains(&"malformed_hex_escape".to_string()));
}

#[test]
fn huge_control_word_name() {
    // A 200-letter control name is consumed cleanly and flagged.
    let long = "x".repeat(200);
    let rtf = format!(r"{{\rtf1\ansi\{long} body}}");
    let i = inspect(&rtf);
    assert_eq!(i["valid_rtf"], true);
    let a = audit(&rtf);
    assert!(kinds(&a).contains(&"overlong_control_name".to_string()));
}

#[test]
fn upr_prefers_ansi_text() {
    // {\upr{ansi-text}{\*\ud{unicode-text}}} shows the ANSI rendering.
    let t = text(r"{\rtf1\ansi {\upr{plain text}{\*\ud{unicode text}}}}");
    assert!(t["text"].as_str().unwrap().contains("plain text"));
    assert!(!t["text"].as_str().unwrap().contains("unicode text"));
}

#[test]
fn missing_header_is_finding_not_failure() {
    let a = audit("not even rtf");
    assert_eq!(a["valid_rtf"], false);
    assert!(kinds(&a).contains(&"missing_rtf_header".to_string()));
    let t = text("not even rtf");
    assert_eq!(t["schema_version"], 1);
}

#[test]
fn audit_severity_filter() {
    let rtf = r"{\rtf1\ansi{\object{\*\objclass Package}{\*\objdata 4d5a}}}";
    let a = parse(rtf_audit(
        rtf.as_bytes(),
        r#"{"min_severity":"high"}"#,
    ));
    assert!(a["findings"].as_array().unwrap().iter().all(|f| {
        matches!(f["severity"].as_str().unwrap(), "high")
    }));
    assert!(a["matched"].as_u64().unwrap() >= 1);
}

#[test]
fn audit_findings_cap() {
    let mut rtf = String::from(r"{\rtf1\ansi ");
    for _ in 0..40 {
        rtf.push_str(r"\'zz");
    }
    rtf.push('}');
    let a = parse(rtf_audit(rtf.as_bytes(), r#"{"max_findings":2}"#));
    assert_eq!(a["findings"].as_array().unwrap().len(), 2);
    assert!(a["finding_count"].as_u64().unwrap() >= 2);
}

#[test]
fn options_and_bounds() {
    // Invalid options shapes.
    assert_eq!(parse(rtf_inspect(b"x", "not json"))["error"], "invalid_options");
    assert_eq!(parse(rtf_inspect(b"x", "[1]"))["error"], "invalid_options");
    assert_eq!(parse(rtf_inspect(b"x", "42"))["error"], "invalid_options");
    // Empty input.
    assert_eq!(parse(rtf_inspect(b"", "{}"))["error"], "empty_input");
    // Options bound.
    let big = format!(r#"{{"pad":"{}"}}"#, "x".repeat(4096));
    assert_eq!(parse(rtf_inspect(b"x", &big))["error"], "options_too_large");
    // Input bound: 16 MiB cap.
    let over = vec![b'x'; MAX_INPUT_BYTES + 1];
    assert_eq!(parse(rtf_inspect(&over, "{}"))["error"], "input_too_large");
    assert_eq!(parse(rtf_objects(&over, "{}"))["error"], "input_too_large");
    assert_eq!(parse(rtf_audit(&over, "{}"))["error"], "input_too_large");
    assert_eq!(parse(rtf_text(&over, "{}"))["error"], "input_too_large");
}

#[test]
fn text_max_chars_option() {
    let r = parse(rtf_text(
        r"{\rtf1\ansi a very long body of text}".as_bytes(),
        r#"{"max_chars":7}"#,
    ));
    assert_eq!(r["chars"], 7);
    assert_eq!(r["truncated"], true);
}

#[test]
fn determinism() {
    let rtf = r"{\rtf1\ansi{\object{\*\objdata d0cf11e0}}body}";
    assert_eq!(rtf_inspect(rtf.as_bytes(), "{}"), rtf_inspect(rtf.as_bytes(), "{}"));
    assert_eq!(rtf_audit(rtf.as_bytes(), "{}"), rtf_audit(rtf.as_bytes(), "{}"));
}

#[test]
fn fuzzed_inputs_never_panic() {
    // Deterministic xorshift byte source; every output must be a
    // schema_version'd JSON body — never a panic or trap.
    let mut state = 0x9e3779b97f4a7c15u64;
    let mut next = move || {
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        state.wrapping_mul(0x2545F4914F6CDD1D)
    };
    let grammar: &[&[u8]] = &[b"{", b"}", b"\\", b"'", b"rtf", b"par", b"*", b"objdata", b"\n"];
    for i in 0..64 {
        let len = (next() % 512) as usize;
        let mut buf = Vec::with_capacity(len + 8);
        for _ in 0..len {
            if next() % 4 == 0 {
                buf.extend_from_slice(grammar[(next() as usize) % grammar.len()]);
            } else {
                buf.push((next() >> 32) as u8);
            }
        }
        for out in [
            rtf_inspect(&buf, "{}"),
            rtf_objects(&buf, "{}"),
            rtf_audit(&buf, "{}"),
            rtf_text(&buf, "{}"),
        ] {
            let v = parse(out);
            assert_eq!(v["schema_version"], 1, "input {i}");
        }
    }
}
