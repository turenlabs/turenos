//! Unit tests build synthetic PDFs in-memory with lopdf's writer, then run the
//! public ops against the produced bytes. No fixtures, no mocks.

use super::*;
use lopdf::xref::XrefType;
use lopdf::{dictionary, Object, SaveOptions, Stream, StringFormat};
use serde_json::Value;

fn base_doc(version: &str) -> Document {
    let mut document = Document::with_version(version);
    document.reference_table.cross_reference_type = XrefType::CrossReferenceTable;
    document
}

fn save(document: &mut Document) -> Vec<u8> {
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).expect("save synthetic pdf");
    bytes
}

fn save_with_options(document: &mut Document, options: SaveOptions) -> Vec<u8> {
    let mut bytes = Vec::new();
    document
        .save_with_options(&mut bytes, options)
        .expect("save synthetic pdf with options");
    bytes
}

fn set_max_id(document: &mut Document) {
    document.max_id = document.objects.keys().map(|id| id.0).max().unwrap_or(0);
}

/// Minimal well-formed one-page document whose content stream shows `text`.
fn one_page_pdf(text: &str) -> Vec<u8> {
    let mut document = base_doc("1.4");
    let content = format!("BT /F1 12 Tf 100 700 Td ({text}) Tj ET");
    let content = Stream::new(dictionary! {}, content.into_bytes());
    document.objects.insert(
        (1, 0),
        Object::Dictionary(dictionary! {
            "Type" => "Catalog",
            "Pages" => Object::Reference((2, 0)),
        }),
    );
    document.objects.insert(
        (2, 0),
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference((3, 0))],
            "Count" => 1,
        }),
    );
    document.objects.insert(
        (3, 0),
        Object::Dictionary(dictionary! {
            "Type" => "Page",
            "Parent" => Object::Reference((2, 0)),
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Contents" => Object::Reference((4, 0)),
            "Resources" => dictionary! {
                "Font" => dictionary! { "F1" => Object::Reference((5, 0)) },
            },
        }),
    );
    document.objects.insert((4, 0), Object::Stream(content));
    document.objects.insert(
        (5, 0),
        Object::Dictionary(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
        }),
    );
    document.objects.insert(
        (6, 0),
        Object::Dictionary(dictionary! {
            "Producer" => Object::string_literal(b"turen-test".to_vec()),
            "Creator" => Object::string_literal(b"pdf-inspect-tests".to_vec()),
            "CreationDate" => Object::string_literal(b"D:20260101000000Z".to_vec()),
        }),
    );
    set_max_id(&mut document);
    document.trailer.set("Root", Object::Reference((1, 0)));
    document.trailer.set("Info", Object::Reference((6, 0)));
    save(&mut document)
}

/// Document whose catalog auto-opens a JavaScript action and declares a
/// JavaScript name tree plus an embedded-files name tree.
fn malicious_pdf() -> Vec<u8> {
    let mut document = base_doc("1.5");
    document.objects.insert(
        (1, 0),
        Object::Dictionary(dictionary! {
            "Type" => "Catalog",
            "Pages" => Object::Reference((2, 0)),
            "OpenAction" => Object::Reference((7, 0)),
            "Names" => dictionary! {
                "JavaScript" => dictionary! {
                    "Names" => vec![
                        Object::string_literal(b"payload".to_vec()),
                        Object::Reference((8, 0)),
                    ],
                },
                "EmbeddedFiles" => dictionary! {
                    "Names" => vec![
                        Object::string_literal(b"evil.exe".to_vec()),
                        Object::Reference((9, 0)),
                    ],
                },
            },
            "AcroForm" => dictionary! { "XFA" => Object::Reference((10, 0)) },
        }),
    );
    document.objects.insert(
        (2, 0),
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference((3, 0))],
            "Count" => 1,
        }),
    );
    document.objects.insert(
        (3, 0),
        Object::Dictionary(dictionary! {
            "Type" => "Page",
            "Parent" => Object::Reference((2, 0)),
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "AA" => dictionary! {
                "O" => Object::Reference((11, 0)),
            },
            "Annots" => vec![Object::Reference((12, 0))],
        }),
    );
    // 7: JavaScript action run on open
    document.objects.insert(
        (7, 0),
        Object::Dictionary(dictionary! {
            "Type" => "Action",
            "S" => "JavaScript",
            "JS" => Object::string_literal(b"app.alert('x')".to_vec()),
        }),
    );
    // 8: JavaScript name-tree target
    document.objects.insert(
        (8, 0),
        Object::Dictionary(dictionary! {
            "S" => "JavaScript",
            "JS" => Object::string_literal(b"evil()".to_vec()),
        }),
    );
    // 9: embedded file spec pointing at a stream
    document.objects.insert(
        (9, 0),
        Object::Dictionary(dictionary! {
            "Type" => "Filespec",
            "F" => Object::string_literal(b"evil.exe".to_vec()),
            "EF" => dictionary! { "F" => Object::Reference((13, 0)) },
        }),
    );
    // 10: XFA payload (represented as a plain stream here)
    let xfa = Stream::new(dictionary! { "Type" => "XFA" }, b"<xdp/>".to_vec());
    document.objects.insert((10, 0), Object::Stream(xfa));
    // 11: launch action triggered by page-open /AA
    document.objects.insert(
        (11, 0),
        Object::Dictionary(dictionary! {
            "Type" => "Action",
            "S" => "Launch",
            "F" => Object::string_literal(b"cmd.exe".to_vec()),
        }),
    );
    // 12: link annotation with external URI
    document.objects.insert(
        (12, 0),
        Object::Dictionary(dictionary! {
            "Type" => "Annot",
            "Subtype" => "Link",
            "A" => dictionary! {
                "S" => "URI",
                "URI" => Object::string_literal(b"https://evil.example/payload".to_vec()),
            },
        }),
    );
    // 14: benign GoTo action — exercises the generic action_type code
    document.objects.insert(
        (14, 0),
        Object::Dictionary(dictionary! {
            "Type" => "Action",
            "S" => "GoTo",
            "D" => vec![Object::Reference((3, 0)), "Fit".into()],
        }),
    );
    // 15: form submission action
    document.objects.insert(
        (15, 0),
        Object::Dictionary(dictionary! {
            "Type" => "Action",
            "S" => "SubmitForm",
            "F" => Object::string_literal(b"https://collector.example/collect".to_vec()),
        }),
    );
    // 16: rich media annotation
    document.objects.insert(
        (16, 0),
        Object::Dictionary(dictionary! {
            "Type" => "Annot",
            "Subtype" => "RichMedia",
        }),
    );
    // 13: embedded file stream
    let embedded = Stream::new(
        dictionary! { "Type" => "EmbeddedFile" },
        b"MZpayload".to_vec(),
    );
    document.objects.insert((13, 0), Object::Stream(embedded));
    set_max_id(&mut document);
    document.trailer.set("Root", Object::Reference((1, 0)));
    save(&mut document)
}

fn codes(report: &Value) -> Vec<String> {
    report["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|finding| finding["code"].as_str().unwrap().to_string())
        .collect()
}

fn inspect_ok(bytes: &[u8], options: &str) -> Value {
    let json = pdf_inspect(bytes, options);
    let report: Value = serde_json::from_str(&json).unwrap();
    assert!(
        report.get("error").is_none(),
        "expected success, got {json}"
    );
    report
}



#[test]
fn inspect_reports_structure() {
    let bytes = one_page_pdf("Hello Turen");
    let report = inspect_ok(&bytes, "");
    assert_eq!(report["version"], "1.4");
    assert_eq!(report["page_count"], 1);
    assert_eq!(report["encrypted"], false);
    assert_eq!(report["decrypted_on_load"], false);
    assert_eq!(report["linearized"], false);
    assert_eq!(report["xref_type"], "table");
    assert!(report["object_count"].as_u64().unwrap() >= 6);
    assert_eq!(report["input_sha256"].as_str().unwrap().len(), 64);
    assert_eq!(report["info"]["producer"], "turen-test");
    assert_eq!(report["info"]["creator"], "pdf-inspect-tests");
    assert_eq!(report["info"]["creation_date"], "D:20260101000000Z");
    let catalog_keys: Vec<&str> = report["catalog_keys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|key| key.as_str().unwrap())
        .collect();
    assert!(catalog_keys.contains(&"Pages"));
    assert!(report["trailer_keys"].as_array().unwrap().len() >= 2);
    assert!(report["findings"].as_array().unwrap().is_empty());
}

#[test]
fn inspect_flags_suspicious_features() {
    let bytes = malicious_pdf();
    let report = inspect_ok(&bytes, "{}");
    let found = codes(&report);
    for expected in [
        "javascript",
        "open_action",
        "additional_actions",
        "launch_action",
        "uri_action",
        "embedded_file",
        "acroform",
        "xfa",
        "names_dictionary",
        "action_type",
        "external_url",
        "submit_form",
        "rich_media",
    ] {
        assert!(found.contains(&expected.to_string()), "missing {expected}");
    }
    // The /JS key under the action carries the script; the catalog OpenAction
    // reference resolves through object (1,0).
    let open = report["findings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|finding| finding["code"] == "open_action")
        .unwrap();
    assert_eq!(open["object"], serde_json::json!([1, 0]));
    assert!(report["urls"]
        .as_array()
        .unwrap()
        .iter()
        .any(|url| url.as_str().unwrap().contains("evil.example")));
    let uri = report["findings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|finding| finding["code"] == "external_url")
        .unwrap();
    assert!(uri["detail"].as_str().unwrap().contains("https://evil.example"));
}

#[test]
fn inspect_findings_cap_marks_truncated() {
    let bytes = malicious_pdf();
    let report = inspect_ok(&bytes, r#"{"max_findings": 2}"#);
    assert_eq!(report["findings"].as_array().unwrap().len(), 2);
    assert!(report["findings_total"].as_u64().unwrap() > 2);
    assert_eq!(report["truncated"], true);
}

#[test]
fn inspect_reports_encrypted_marker_without_decrypting() {
    let mut document = base_doc("1.4");
    document.objects.insert(
        (1, 0),
        Object::Dictionary(dictionary! {
            "Type" => "Catalog",
            "Pages" => Object::Reference((2, 0)),
        }),
    );
    document.objects.insert(
        (2, 0),
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => Vec::<Object>::new(),
            "Count" => 0,
        }),
    );
    document.objects.insert(
        (8, 0),
        Object::Dictionary(dictionary! {
            "Filter" => "Standard",
            "V" => 1,
            "R" => 2,
            "Length" => 40,
            "P" => -4,
            "O" => Object::String(vec![7u8; 32], StringFormat::Literal),
            "U" => Object::String(vec![9u8; 32], StringFormat::Literal),
        }),
    );
    set_max_id(&mut document);
    document.trailer.set("Root", Object::Reference((1, 0)));
    document.trailer.set("Encrypt", Object::Reference((8, 0)));
    document
        .trailer
        .set("ID", vec![Object::string_literal(b"0123456789abcdef".to_vec())]);
    let bytes = save(&mut document);

    let report = inspect_ok(&bytes, "{}");
    assert_eq!(report["encrypted"], true);
    assert_eq!(report["decrypted_on_load"], false);
    assert!(codes(&report).contains(&"encrypted".to_string()));
    assert!(report["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|warning| warning.as_str().unwrap().contains("password")));
}

#[test]
fn inspect_reports_object_streams_and_xref_stream() {
    let mut document = base_doc("1.5");
    document.objects.insert(
        (1, 0),
        Object::Dictionary(dictionary! {
            "Type" => "Catalog",
            "Pages" => Object::Reference((2, 0)),
        }),
    );
    document.objects.insert(
        (2, 0),
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => Vec::<Object>::new(),
            "Count" => 0,
        }),
    );
    document.objects.insert(
        (9, 0),
        Object::Dictionary(dictionary! {
            "Producer" => Object::string_literal(b"packed".to_vec()),
        }),
    );
    set_max_id(&mut document);
    document.trailer.set("Root", Object::Reference((1, 0)));
    document.trailer.set("Info", Object::Reference((9, 0)));
    let bytes = save_with_options(
        &mut document,
        SaveOptions {
            use_object_streams: true,
            use_xref_streams: true,
            ..SaveOptions::default()
        },
    );
    let report = inspect_ok(&bytes, "{}");
    assert_eq!(report["xref_type"], "stream");
    assert!(report["object_stream_count"].as_u64().unwrap() >= 1);
    assert!(report["compressed_object_count"].as_u64().unwrap() >= 1);
    assert!(codes(&report).contains(&"object_streams".to_string()));
}

#[test]
fn inspect_handles_malformed_input() {
    // Non-PDF garbage fails closed at header parsing.
    let bad: Value = serde_json::from_str(&pdf_inspect(b"not a pdf", "{}")).unwrap();
    assert_eq!(bad["error"], "invalid_pdf");

    // Corrupted %PDF header fails closed too.
    let mut corrupt = one_page_pdf("x");
    corrupt[1] = b'X';
    let bad: Value = serde_json::from_str(&pdf_inspect(&corrupt, "{}")).unwrap();
    assert_eq!(bad["error"], "invalid_pdf");

    let empty: Value = serde_json::from_str(&pdf_inspect(&[], "{}")).unwrap();
    assert_eq!(empty["error"], "empty_input");

    // A truncated document either loads (xref reconstruction scans for
    // objects) or reports invalid_pdf — it must never trap and always returns
    // a schema_version'd JSON body.
    let whole = one_page_pdf("x");
    let truncated = whole[..whole.len() / 2].to_vec();
    let report: Value = serde_json::from_str(&pdf_inspect(&truncated, "{}")).unwrap();
    assert_eq!(report["schema_version"], 1);
}

#[test]
fn inspect_survives_cyclic_references() {
    let mut document = base_doc("1.4");
    document.objects.insert(
        (1, 0),
        Object::Dictionary(dictionary! {
            "Type" => "Catalog",
            "Pages" => Object::Reference((2, 0)),
        }),
    );
    // Page tree that points at itself plus two mutually referencing dicts.
    document.objects.insert(
        (2, 0),
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference((2, 0))],
            "Count" => 1,
        }),
    );
    document.objects.insert(
        (10, 0),
        Object::Dictionary(dictionary! {
            "See" => Object::Reference((11, 0)),
        }),
    );
    document.objects.insert(
        (11, 0),
        Object::Dictionary(dictionary! {
            "Back" => Object::Reference((10, 0)),
        }),
    );
    set_max_id(&mut document);
    document.trailer.set("Root", Object::Reference((1, 0)));
    let bytes = save(&mut document);
    let report = inspect_ok(&bytes, "{}");
    assert_eq!(report["schema_version"], 1);
    assert_eq!(report["page_count"], 0);
}

#[test]
fn objects_lists_and_filters() {
    let bytes = one_page_pdf("Hello");
    let json = pdf_objects(&bytes, "{}");
    let report: Value = serde_json::from_str(&json).unwrap();
    assert!(report["object_count"].as_u64().unwrap() >= 6);
    let kinds: Vec<&str> = report["objects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["kind"].as_str().unwrap())
        .collect();
    assert!(kinds.contains(&"Stream"));
    assert!(kinds.contains(&"Dictionary"));

    let fonts = pdf_objects(&bytes, r#"{"type": "font"}"#);
    let fonts: Value = serde_json::from_str(&fonts).unwrap();
    assert_eq!(fonts["matched"], 1);
    assert_eq!(fonts["objects"][0]["type"], "Font");
    assert_eq!(fonts["objects"][0]["subtype"], "Type1");

    let streams = pdf_objects(&bytes, r#"{"kind": "stream"}"#);
    let streams: Value = serde_json::from_str(&streams).unwrap();
    assert_eq!(streams["matched"], 1);
    assert_eq!(streams["objects"][0]["stream"], true);
    assert!(streams["objects"][0]["stream_length"].as_u64().unwrap() > 0);

    let one = pdf_objects(&bytes, r#"{"object_id": 5}"#);
    let one: Value = serde_json::from_str(&one).unwrap();
    assert_eq!(one["returned"], 1);
    assert_eq!(one["objects"][0]["object_id"], serde_json::json!([5, 0]));

    let capped = pdf_objects(&bytes, r#"{"max_results": 2}"#);
    let capped: Value = serde_json::from_str(&capped).unwrap();
    assert_eq!(capped["returned"], 2);
    assert_eq!(capped["truncated"], true);
    assert!(capped["matched"].as_u64().unwrap() > 2);

    let missing = pdf_objects(&bytes, r#"{"object_id": 99}"#);
    let missing: Value = serde_json::from_str(&missing).unwrap();
    assert_eq!(missing["error"], "object_not_found");
}

#[test]
fn objects_report_suspicious_keys() {
    let bytes = malicious_pdf();
    let json = pdf_objects(&bytes, r#"{"object_id": 1}"#);
    let report: Value = serde_json::from_str(&json).unwrap();
    let keys: Vec<&str> = report["objects"][0]["suspicious_keys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|key| key.as_str().unwrap())
        .collect();
    for expected in ["OpenAction", "Names", "AcroForm", "JavaScript", "EmbeddedFiles", "XFA"] {
        assert!(keys.contains(&expected), "missing suspicious key {expected}");
    }
}

#[test]
fn stream_decode_roundtrips_filters() {
    // Large enough and repetitive that `Stream::compress` actually emits
    // FlateDecode (lopdf skips compression when it would not shrink).
    let payload = b"function evil() { return 1; }".repeat(12);

    // FlateDecode via lopdf's compressor.
    let mut flated = Stream::new(dictionary! {}, payload.clone());
    flated.compress().expect("flate compress");

    // ASCIIHex: hex digits terminated by '>'.
    let mut ahex_content = crate::hex(&payload).into_bytes();
    ahex_content.push(b'>');
    let ahex = Stream::new(dictionary! { "Filter" => "ASCIIHexDecode" }, ahex_content);

    // RunLength: literal runs of at most 128 bytes each + EOD marker.
    let mut rl_content = Vec::new();
    for chunk in payload.chunks(128) {
        rl_content.push((chunk.len() - 1) as u8);
        rl_content.extend_from_slice(chunk);
    }
    rl_content.push(0x80);
    let rl = Stream::new(dictionary! { "Filter" => "RunLengthDecode" }, rl_content);

    // ASCII85 encoded with the local test encoder below.
    let a85 = Stream::new(
        dictionary! { "Filter" => "ASCII85Decode" },
        ascii85_encode(&payload),
    );

    // LZW via weezl (test-only dev dependency, same version lopdf uses).
    let lzw_bytes = lzw_encode(&payload);
    let lzw = Stream::new(dictionary! { "Filter" => "LZWDecode" }, lzw_bytes);

    let streams = [flated, ahex, rl, a85, lzw];
    for (index, stream) in streams.into_iter().enumerate() {
        let mut document = base_doc("1.4");
        let id = (4 + index as u32, 0);
        document.objects.insert(
            (1, 0),
            Object::Dictionary(dictionary! {
                "Type" => "Catalog",
                "Pages" => Object::Reference((2, 0)),
            }),
        );
        document.objects.insert(
            (2, 0),
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => Vec::<Object>::new(),
                "Count" => 0,
            }),
        );
        document.objects.insert(id, Object::Stream(stream));
        set_max_id(&mut document);
        document.trailer.set("Root", Object::Reference((1, 0)));
        let bytes = save(&mut document);

        let json = pdf_stream_decode(&bytes, &format!(r#"{{"object_id": {}}}"#, id.0));
        let report: Value = serde_json::from_str(&json).unwrap();
        assert!(report.get("error").is_none(), "stream {id:?} failed: {json}");
        assert_eq!(report["decoded_length"], payload.len() as u64);
        assert_eq!(b64_decode(report["data_base64"].as_str().unwrap()), payload);
    }
}

#[test]
fn stream_decode_filter_chain_and_raw() {
    // Repetitive payload so `Stream::compress` actually emits FlateDecode.
    let payload = b"chain decoded payload ".repeat(16);
    let mut flated = Stream::new(dictionary! {}, payload.clone());
    flated.compress().expect("flate");
    let inner = flated.content.clone();
    let mut chained = crate::hex(&inner).into_bytes();
    chained.push(b'>');
    let chain = Stream::new(
        dictionary! { "Filter" => vec!["ASCIIHexDecode".into(), "FlateDecode".into()] },
        chained,
    );

    let raw = Stream::new(dictionary! {}, payload.clone());

    let mut document = base_doc("1.4");
    document.objects.insert(
        (1, 0),
        Object::Dictionary(dictionary! {
            "Type" => "Catalog",
            "Pages" => Object::Reference((2, 0)),
        }),
    );
    document.objects.insert(
        (2, 0),
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => Vec::<Object>::new(),
            "Count" => 0,
        }),
    );
    document.objects.insert((4, 0), Object::Stream(chain));
    document.objects.insert((5, 0), Object::Stream(raw));
    set_max_id(&mut document);
    document.trailer.set("Root", Object::Reference((1, 0)));
    let bytes = save(&mut document);

    let report: Value =
        serde_json::from_str(&pdf_stream_decode(&bytes, r#"{"object_id": 4}"#)).unwrap();
    assert_eq!(b64_decode(report["data_base64"].as_str().unwrap()), payload);
    let filters: Vec<&str> = report["filters"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f.as_str().unwrap())
        .collect();
    assert_eq!(filters, vec!["ASCIIHexDecode", "FlateDecode"]);

    let raw: Value =
        serde_json::from_str(&pdf_stream_decode(&bytes, r#"{"object_id": 5}"#)).unwrap();
    assert_eq!(raw["filters"].as_array().unwrap().len(), 0);
    assert_eq!(b64_decode(raw["data_base64"].as_str().unwrap()), payload);
}

#[test]
fn stream_decode_reports_unsupported_filter() {
    let mut document = base_doc("1.4");
    document.objects.insert(
        (1, 0),
        Object::Dictionary(dictionary! {
            "Type" => "Catalog",
            "Pages" => Object::Reference((2, 0)),
        }),
    );
    document.objects.insert(
        (2, 0),
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => Vec::<Object>::new(),
            "Count" => 0,
        }),
    );
    document.objects.insert(
        (4, 0),
        Object::Stream(Stream::new(
            dictionary! { "Filter" => "DCTDecode" },
            b"not really jpeg".to_vec(),
        )),
    );
    set_max_id(&mut document);
    document.trailer.set("Root", Object::Reference((1, 0)));
    let bytes = save(&mut document);

    let report: Value =
        serde_json::from_str(&pdf_stream_decode(&bytes, r#"{"object_id": 4}"#)).unwrap();
    assert_eq!(report["error"], "unsupported_filter");
    assert_eq!(report["unsupported_filters"][0], "DCTDecode");
}

#[test]
fn stream_decode_bounds_and_selection() {
    let payload = vec![b'x'; 64];
    let mut document = base_doc("1.4");
    document.objects.insert(
        (1, 0),
        Object::Dictionary(dictionary! {
            "Type" => "Catalog",
            "Pages" => Object::Reference((2, 0)),
        }),
    );
    document.objects.insert(
        (2, 0),
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => Vec::<Object>::new(),
            "Count" => 0,
        }),
    );
    document.objects.insert((4, 0), Object::Stream(Stream::new(dictionary! {}, payload)));
    set_max_id(&mut document);
    document.trailer.set("Root", Object::Reference((1, 0)));
    let bytes = save(&mut document);

    let missing: Value = serde_json::from_str(&pdf_stream_decode(&bytes, "{}")).unwrap();
    assert_eq!(missing["error"], "missing_object_id");

    let not_stream: Value =
        serde_json::from_str(&pdf_stream_decode(&bytes, r#"{"object_id": 1}"#)).unwrap();
    assert_eq!(not_stream["error"], "not_a_stream");

    let unknown: Value =
        serde_json::from_str(&pdf_stream_decode(&bytes, r#"{"object_id": 77}"#)).unwrap();
    assert_eq!(unknown["error"], "object_not_found");

    let too_large: Value = serde_json::from_str(&pdf_stream_decode(
        &bytes,
        r#"{"object_id": 4, "max_output_bytes": 8}"#,
    ))
    .unwrap();
    assert_eq!(too_large["error"], "decoded_stream_too_large");

    let wrong_gen: Value = serde_json::from_str(&pdf_stream_decode(
        &bytes,
        r#"{"object_id": 4, "generation": 3}"#,
    ))
    .unwrap();
    assert_eq!(wrong_gen["error"], "object_not_found");
}

#[test]
fn text_extracts_and_bounds() {
    let bytes = one_page_pdf("Hello Turen");
    let report: Value = serde_json::from_str(&pdf_text(&bytes, "{}")).unwrap();
    assert!(report["text"].as_str().unwrap().contains("Hello Turen"));
    assert_eq!(report["page_count"], 1);
    assert_eq!(report["pages_processed"], 1);
    assert_eq!(report["truncated"], false);

    let cut: Value = serde_json::from_str(&pdf_text(&bytes, r#"{"max_chars": 5}"#)).unwrap();
    assert!(cut["text"].as_str().unwrap().len() <= 5);
    assert_eq!(cut["truncated"], true);

    let later: Value =
        serde_json::from_str(&pdf_text(&bytes, r#"{"start_page": 99}"#)).unwrap();
    assert_eq!(later["pages_processed"], 0);
    assert_eq!(later["text"], "");
}

#[test]
fn rejects_oversized_and_bad_options() {
    let bytes = one_page_pdf("Hello");
    let huge = vec![0u8; MAX_INPUT_BYTES + 1];
    for op in [pdf_inspect as fn(&[u8], &str) -> String, pdf_objects, pdf_text] {
        let report: Value = serde_json::from_str(&op(&huge, "{}")).unwrap();
        assert_eq!(report["error"], "input_too_large");
    }
    let report: Value = serde_json::from_str(&pdf_stream_decode(&huge, "{}")).unwrap();
    assert_eq!(report["error"], "input_too_large");

    let big_options = format!("{{\"pad\":\"{}\"}}", "x".repeat(MAX_OPTIONS_BYTES));
    let report: Value = serde_json::from_str(&pdf_inspect(&bytes, &big_options)).unwrap();
    assert_eq!(report["error"], "options_too_large");

    for bad in ["not json", "[1]", "42"] {
        let report: Value = serde_json::from_str(&pdf_inspect(&bytes, bad)).unwrap();
        assert_eq!(report["error"], "invalid_options", "input {bad}");
    }

    let report: Value = serde_json::from_str(&pdf_inspect(&[], "{}")).unwrap();
    assert_eq!(report["error"], "empty_input");
}

#[test]
fn deterministic_output() {
    let bytes = malicious_pdf();
    assert_eq!(pdf_inspect(&bytes, "{}"), pdf_inspect(&bytes, "{}"));
    assert_eq!(pdf_objects(&bytes, "{}"), pdf_objects(&bytes, "{}"));
    assert_eq!(pdf_text(&bytes, "{}"), pdf_text(&bytes, "{}"));
}

fn ascii85_encode(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < data.len() {
        let remaining = data.len() - i;
        let take = remaining.min(4);
        let mut group = [0u8; 4];
        group[..take].copy_from_slice(&data[i..i + take]);
        let value = u32::from_be_bytes(group);
        if take == 4 && value == 0 {
            out.push(b'z');
        } else {
            let mut encoded = [0u8; 5];
            let mut v = value;
            for slot in encoded.iter_mut().rev() {
                *slot = (v % 85) as u8 + b'!';
                v /= 85;
            }
            out.extend_from_slice(&encoded[..take + 1]);
        }
        i += 4;
    }
    out.extend_from_slice(b"~>");
    out
}

fn lzw_encode(data: &[u8]) -> Vec<u8> {
    use weezl::{encode::Encoder, BitOrder};
    let mut encoder = Encoder::with_tiff_size_switch(BitOrder::Msb, 8);
    let result = encoder.encode(data).expect("lzw encode");
    result
}

fn b64_decode(text: &str) -> Vec<u8> {
    fn value(byte: u8) -> u8 {
        match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => 0,
        }
    }
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    for chunk in bytes.chunks(4) {
        if chunk.len() < 4 {
            break;
        }
        let pad = chunk.iter().filter(|b| **b == b'=').count();
        let n = ((value(chunk[0]) as u32) << 18)
            | ((value(chunk[1]) as u32) << 12)
            | ((value(chunk[2]) as u32) << 6)
            | value(chunk[3]) as u32;
        out.push((n >> 16) as u8);
        if pad < 2 {
            out.push((n >> 8) as u8);
        }
        if pad < 1 {
            out.push(n as u8);
        }
    }
    out
}

#[test]
fn debug_chain() {
    let payload = b"chain decoded payload".to_vec();
    let mut flated = Stream::new(dictionary! {}, payload.clone());
    flated.compress().expect("flate");
    eprintln!("flated dict {:?} content len {}", flated.dict, flated.content.len());
    let inner = flated.content.clone();
    let mut chained = crate::hex(&inner).into_bytes();
    chained.push(b'>');
    let chain = Stream::new(
        dictionary! { "Filter" => vec!["ASCIIHexDecode".into(), "FlateDecode".into()] },
        chained,
    );
    eprintln!("chain dict {:?} content len {}", chain.dict, chain.content.len());
    eprintln!("filters: {:?}", chain.filters());
    eprintln!("direct decode: {:?}", chain.decompressed_content_with_limit(1024).map(|v| String::from_utf8_lossy(&v).to_string()));

    let mut document = base_doc("1.4");
    document.objects.insert((1, 0), Object::Dictionary(dictionary! {"Type" => "Catalog", "Pages" => Object::Reference((2,0))}));
    document.objects.insert((2, 0), Object::Dictionary(dictionary! {"Type" => "Pages", "Kids" => Vec::<Object>::new(), "Count" => 0}));
    document.objects.insert((4, 0), Object::Stream(chain));
    set_max_id(&mut document);
    document.trailer.set("Root", Object::Reference((1,0)));
    let bytes = save(&mut document);
    let doc2 = Document::load_mem(&bytes).unwrap();
    let s2 = doc2.objects.get(&(4,0)).unwrap().as_stream().unwrap();
    eprintln!("loaded dict {:?} content len {} filters {:?}", s2.dict, s2.content.len(), s2.filters());
    eprintln!("loaded decode: {:?}", s2.decompressed_content_with_limit(1024).map(|v| String::from_utf8_lossy(&v).to_string()));
}
