//! End-to-end unit tests: fixtures are constructed in `fixtures.rs` as raw
//! DER/container bytes and pushed through the same public functions the WASM
//! exports expose.

use serde_json::Value;

use crate::fixtures::*;
use crate::{
    cert_inspect, crl_inspect, macho_codesign, pe_authenticode, pkcs7_inspect,
    MAX_INPUT_BYTES, MAX_OPTIONS_BYTES,
};

fn json(output: &str) -> Value {
    serde_json::from_str(output).expect("output is valid json")
}

fn ok(output: &str) -> Value {
    let value = json(output);
    assert!(value.get("error").is_none(), "unexpected error: {output}");
    value
}

fn err(output: &str) -> String {
    let value = json(output);
    assert_eq!(value["schema_version"], 1);
    value["error"].as_str().expect("error code").to_string()
}

fn signer_cert() -> Vec<u8> {
    cert_der("Test Signer", "Test Signer", &[0x01, 0x02, 0x03], false, true, &[])
}

// ---------- cert_inspect ----------

#[test]
fn cert_der_fields() {
    let der = signer_cert();
    let report = ok(&cert_inspect(&der, "{}"));
    assert_eq!(report["count"], 1);
    let cert = &report["certificates"][0];
    assert_eq!(cert["subject"], "CN=Test Signer, O=Turen Test");
    assert_eq!(cert["issuer"], "CN=Test Signer, O=Turen Test");
    assert_eq!(cert["serial_hex"], "010203");
    assert_eq!(cert["serial_decimal"], "66051");
    assert_eq!(cert["version"], 3);
    assert_eq!(cert["validity"]["not_before"]["unix"], 1735689600i64);
    assert_eq!(cert["validity"]["not_after"]["unix"], 2051222400i64);
    assert_eq!(
        cert["signature_algorithm"]["name"],
        "sha256WithRSAEncryption"
    );
    assert_eq!(cert["public_key"]["algorithm"], "rsaEncryption");
    assert_eq!(cert["public_key"]["size_bits"], 512);
    assert_eq!(cert["is_ca"], false);
    assert_eq!(cert["extended_key_usage"]["code_signing"], true);
    assert_eq!(cert["subject_key_identifier"], "1111111111111111111111111111111111111111");
    assert_eq!(cert["authority_key_identifier"], "1111111111111111111111111111111111111111");
    assert_eq!(cert["fingerprint_sha256"], crate::sha256_hex(&der));
    assert_eq!(report["truncated"], false);
}

#[test]
fn cert_sans_and_ca() {
    let der = cert_der(
        "CA",
        "CA",
        &[0x7f],
        true,
        false,
        &["a.example.com", "b.example.com"],
    );
    let report = ok(&cert_inspect(&der, "{}"));
    let cert = &report["certificates"][0];
    assert_eq!(cert["is_ca"], true);
    assert_eq!(cert["basic_constraints"]["ca"], true);
    assert_eq!(cert["basic_constraints"]["critical"], true);
    let sans = &cert["subject_alt_names"];
    assert_eq!(sans["dns_names"][0], "a.example.com");
    assert_eq!(sans["dns_names"][1], "b.example.com");
    assert!(cert["extended_key_usage"].is_null());
    let usages = cert["key_usage"]["usages"].as_array().unwrap();
    assert!(usages.iter().any(|u| u == "digital_signature"));
    assert!(usages.iter().any(|u| u == "key_cert_sign"));
}

#[test]
fn cert_pem_bundle_two() {
    let first = pem("CERTIFICATE", &signer_cert());
    let second = pem(
        "CERTIFICATE",
        &cert_der("Second", "Second", &[0x05], false, false, &[]),
    );
    let mut bundle = first;
    bundle.extend_from_slice(&second);
    let report = ok(&cert_inspect(&bundle, "{}"));
    assert_eq!(report["count"], 2);
    assert_eq!(report["certificates"][0]["subject"], "CN=Test Signer, O=Turen Test");
    assert_eq!(report["certificates"][1]["subject"], "CN=Second, O=Turen Test");
}

#[test]
fn cert_pem_skips_non_certificate_labels() {
    let mut bundle = pem("PRIVATE KEY", &[0x30, 0x03, 0x02, 0x01, 0x00]);
    bundle.extend_from_slice(&pem("CERTIFICATE", &signer_cert()));
    let report = ok(&cert_inspect(&bundle, "{}"));
    assert_eq!(report["count"], 1);
    assert!(!report["warnings"].as_array().unwrap().is_empty());
}

#[test]
fn cert_malformed_der() {
    assert_eq!(err(&cert_inspect(&[0x30, 0x10, 0xff, 0x00], "{}")), "cert_parse_error");
}

#[test]
fn cert_truncated_der() {
    let der = signer_cert();
    assert_eq!(err(&cert_inspect(&der[..der.len() / 2], "{}")), "cert_parse_error");
}

#[test]
fn cert_empty_input() {
    assert_eq!(err(&cert_inspect(&[], "{}")), "empty_input");
}

#[test]
fn cert_max_items_truncates_bundle() {
    let mut bundle = pem("CERTIFICATE", &signer_cert());
    bundle.extend_from_slice(&pem(
        "CERTIFICATE",
        &cert_der("B", "B", &[2], false, false, &[]),
    ));
    bundle.extend_from_slice(&pem(
        "CERTIFICATE",
        &cert_der("C", "C", &[3], false, false, &[]),
    ));
    let report = ok(&cert_inspect(&bundle, "{\"maxItems\":1}"));
    assert_eq!(report["count"], 1);
    assert_eq!(report["truncated"], true);
}

// ---------- pkcs7_inspect ----------

#[test]
fn pkcs7_attached_with_cert_and_matching_digest() {
    let cms = cms_der(&CmsOpts {
        certs: vec![signer_cert()],
        ..Default::default()
    });
    let report = ok(&pkcs7_inspect(&cms, "{}"));
    assert_eq!(report["content_type_name"], "signedData");
    let signed = &report["signed_data"];
    assert_eq!(signed["digest_algorithms"][0]["name"], "sha256");
    assert_eq!(signed["encapsulated_content"]["attached"], true);
    assert_eq!(signed["encapsulated_content"]["content_type_name"], "data");
    assert_eq!(signed["certificates"].as_array().unwrap().len(), 1);
    assert_eq!(
        signed["certificates"][0]["subject"],
        "CN=Test Signer, O=Turen Test"
    );
    assert_eq!(signed["signer_count"], 1);
    let signer = &signed["signer_infos"][0];
    assert_eq!(signer["sid"]["kind"], "issuer_and_serial_number");
    assert_eq!(signer["sid"]["issuer"], "O=Turen Test,CN=Test Issuer");
    assert_eq!(signer["sid"]["serial_hex"], "2a");
    assert_eq!(signer["digest_algorithm"]["name"], "sha256");
    assert_eq!(signer["signature_algorithm"]["name"], "sha256WithRSAEncryption");
    assert_eq!(signer["message_digest_matches_content"], true);
    assert_eq!(signer["signing_time"], "250601000000Z");
    assert_eq!(signer["countersignatures"], 0);
}

#[test]
fn pkcs7_detached_content() {
    let cms = cms_der(&CmsOpts {
        content: None,
        ..Default::default()
    });
    let report = ok(&pkcs7_inspect(&cms, "{}"));
    let signed = &report["signed_data"];
    assert_eq!(signed["encapsulated_content"]["attached"], false);
    assert!(signed["encapsulated_content"]["content_sha256"].is_null());
    assert!(signed["signer_infos"][0]["message_digest_matches_content"].is_null());
}

#[test]
fn pkcs7_digest_mismatch() {
    let cms = cms_der(&CmsOpts {
        message_digest_ok: false,
        ..Default::default()
    });
    let report = ok(&pkcs7_inspect(&cms, "{}"));
    assert_eq!(
        report["signed_data"]["signer_infos"][0]["message_digest_matches_content"],
        false
    );
}

#[test]
fn pkcs7_countersignature_and_page_hash() {
    let cms = cms_der(&CmsOpts {
        countersignature: true,
        page_hash_attr: true,
        ..Default::default()
    });
    let report = ok(&pkcs7_inspect(&cms, "{}"));
    let signer = &report["signed_data"]["signer_infos"][0];
    assert_eq!(signer["countersignatures"], 1);
    let page_hashes = signer["page_hash_oids"].as_array().unwrap();
    assert!(page_hashes.iter().any(|oid| oid == "1.3.6.1.4.1.311.2.3.2"));
}

#[test]
fn pkcs7_pem_input() {
    let cms = cms_der(&CmsOpts::default());
    let report = ok(&pkcs7_inspect(&pem("PKCS7", &cms), "{}"));
    assert_eq!(report["content_type_name"], "signedData");
}

#[test]
fn pkcs7_malformed() {
    assert_eq!(err(&pkcs7_inspect(&[0x30, 0x80, 0x01], "{}")), "invalid_content_info");
    assert_eq!(err(&pkcs7_inspect(b"not der at all", "{}")), "invalid_content_info");
}

// ---------- crl_inspect ----------

#[test]
fn crl_revocations() {
    let der = crl_der("Test CA", &[&[0x0a], &[0x0b], &[0x0c]]);
    let report = ok(&crl_inspect(&der, "{}"));
    assert_eq!(report["issuer"], "CN=Test CA, O=Turen Test");
    assert_eq!(report["this_update"]["unix"], 1735689600i64);
    assert_eq!(report["next_update"]["unix"], 1767225600i64);
    assert_eq!(report["crl_number_hex"], "07");
    assert_eq!(report["revoked_count"], 3);
    let revoked = report["revoked"].as_array().unwrap();
    assert_eq!(revoked.len(), 3);
    assert_eq!(revoked[0]["serial_hex"], "0a");
    assert_eq!(revoked[2]["serial_hex"], "0c");
    assert!(revoked[0]["reason_code"].as_str().unwrap().contains("ompro"));
    let exts = report["extensions"].as_array().unwrap();
    assert!(exts.iter().any(|e| e["name"] == "cRLNumber"));
}

#[test]
fn crl_pem_input() {
    let der = crl_der("Test CA", &[&[0x2a]]);
    let report = ok(&crl_inspect(&pem("X509 CRL", &der), "{}"));
    assert_eq!(report["revoked_count"], 1);
}

#[test]
fn crl_rejects_certificate() {
    assert_eq!(err(&crl_inspect(&signer_cert(), "{}")), "crl_parse_error");
}

// ---------- pe_authenticode ----------

#[test]
fn pe_signed_authenticode() {
    let cms = cms_der(&CmsOpts {
        econtent_type: OID_SPC_INDIRECT_DATA,
        content: Some(spc_indirect_data_der()),
        certs: vec![signer_cert()],
        page_hash_attr: true,
        ..Default::default()
    });
    let pe = pe_image(Some(&cms), Some(&signer_cert()));
    let report = ok(&pe_authenticode(&pe, "{}"));
    assert_eq!(report["pe"]["machine"], "x86_64");
    assert_eq!(report["pe"]["bits"], 64);
    assert_eq!(report["signed"], true);
    assert_eq!(report["signed_blobs"], 1);
    let certs = report["win_certificates"].as_array().unwrap();
    assert_eq!(certs.len(), 2);
    assert_eq!(certs[0]["certificate_type_name"], "pkcs_signed_data");
    assert_eq!(certs[1]["certificate_type_name"], "x509");
    let table = &report["certificate_table"];
    assert_eq!(table["offset"], "0x400");
    assert_eq!(table["entries"], 2);
    let pkcs7 = &report["pkcs7"];
    assert_eq!(pkcs7["content_type_name"], "signedData");
    assert_eq!(
        pkcs7["signed_data"]["encapsulated_content"]["content_type_name"],
        "spcIndirectDataContext"
    );
    let spc = &report["spc_indirect_data"];
    assert_eq!(spc["present"], true);
    assert_eq!(spc["data_type_name"], "spcPeImageData");
    assert_eq!(spc["hash_algorithm"]["name"], "sha256");
    assert_eq!(spc["digest"], "55".repeat(32));
    assert_eq!(report["page_hashes_present"], true);
}

#[test]
fn pe_unsigned() {
    let pe = pe_image(None, None);
    let report = ok(&pe_authenticode(&pe, "{}"));
    assert_eq!(report["signed"], false);
    assert!(report["pkcs7"].is_null());
    assert!(report["spc_indirect_data"].is_null());
    assert_eq!(report["page_hashes_present"], false);
}

#[test]
fn pe_not_pe() {
    assert_eq!(err(&pe_authenticode(b"not a pe file", "{}")), "pe_parse_error");
}

#[test]
fn pe_certificate_table_out_of_bounds_warns() {
    let cms = cms_der(&CmsOpts::default());
    let mut pe = pe_image(Some(&cms), None);
    // Inflate the directory size beyond EOF.
    let dir = 0x98 + 0x70 + 4 * 8;
    pe[dir + 4..dir + 8].copy_from_slice(&0x10_0000u32.to_le_bytes());
    let report = ok(&pe_authenticode(&pe, "{}"));
    assert!(report["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|w| w.as_str().unwrap().contains("past end of input")));
}

// ---------- macho_codesign ----------

const ENTITLEMENTS_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>com.example.test</key><true/></dict></plist>"#;

fn signed_superblob() -> Vec<u8> {
    let cms = cms_der(&CmsOpts {
        certs: vec![signer_cert()],
        ..Default::default()
    });
    superblob(&[
        (0, code_directory("com.turen.test", "TEAMID99")),
        (2, blob(CSMAGIC_REQUIREMENTS, &[])),
        (5, blob(CSMAGIC_ENTITLEMENT, ENTITLEMENTS_XML.as_bytes())),
        (0x10000, blob(CSMAGIC_BLOBWRAPPER, &cms)),
    ])
}

#[test]
fn macho_signed_full() {
    let macho = macho_with_signature(&signed_superblob());
    let report = ok(&macho_codesign(&macho, "{}"));
    assert_eq!(report["format"], "mach-o");
    assert_eq!(report["signed"], true);
    let arch = &report["arches"][0];
    assert_eq!(arch["arch"], "aarch64");
    assert_eq!(arch["bits"], 64);
    let cs = &arch["code_signature"];
    assert_eq!(cs["superblob"]["index_count"], 4);
    assert_eq!(cs["slots"].as_array().unwrap().len(), 4);
    let cd = &cs["code_directory"];
    assert_eq!(cd["hash_type_name"], "sha256");
    assert_eq!(cd["hash_size"], 32);
    assert_eq!(cd["page_size"], 4096);
    assert_eq!(cd["n_special_slots"], 1);
    assert_eq!(cd["n_code_slots"], 2);
    assert_eq!(cd["code_limit"], 0x1000);
    assert_eq!(cd["ident"], "com.turen.test");
    assert_eq!(cd["team_id"], "TEAMID99");
    assert!(cd["flag_names"].as_array().unwrap().iter().any(|f| f == "adhoc"));
    assert_eq!(cs["requirements"]["present"], true);
    let ent = &cs["entitlements"];
    assert_eq!(ent["present"], true);
    assert!(ent["xml"].as_str().unwrap().contains("com.example.test"));
    assert_eq!(ent["sha256"], crate::sha256_hex(ENTITLEMENTS_XML.as_bytes()));
    let cms = &cs["cms"];
    assert_eq!(cms["content_type_name"], "signedData");
    assert_eq!(cms["signed_data"]["signer_count"], 1);
}

#[test]
fn macho_entitlements_xml_opt_out() {
    let macho = macho_with_signature(&signed_superblob());
    let report = ok(&macho_codesign(&macho, "{\"includeEntitlementsXml\":false}"));
    let ent = &report["arches"][0]["code_signature"]["entitlements"];
    assert_eq!(ent["present"], true);
    assert!(ent["xml"].is_null());
}

#[test]
fn macho_unsigned() {
    let mut bytes = vec![0u8; 0x40];
    bytes[0..4].copy_from_slice(&0xfeedfacfu32.to_le_bytes());
    bytes[4..8].copy_from_slice(&0x0100_000cu32.to_le_bytes());
    bytes[12..16].copy_from_slice(&2u32.to_le_bytes());
    let report = ok(&macho_codesign(&bytes, "{}"));
    assert_eq!(report["signed"], false);
    assert!(report["arches"][0]["code_signature"].is_null());
}

#[test]
fn macho_not_macho() {
    assert_eq!(err(&macho_codesign(b"not mach-o", "{}")), "macho_parse_error");
}

#[test]
fn macho_signature_out_of_bounds() {
    let mut macho = macho_with_signature(&signed_superblob());
    // Corrupt datasize so the region exceeds the file.
    macho[44..48].copy_from_slice(&0x7fff_ffffu32.to_le_bytes());
    let report = ok(&macho_codesign(&macho, "{}"));
    assert_eq!(report["signed"], true); // code_signature object exists
    assert_eq!(
        report["arches"][0]["code_signature"]["error"],
        "code_signature_out_of_bounds"
    );
}

#[test]
fn macho_bad_superblob_magic() {
    let mut fake = Vec::new();
    fake.extend_from_slice(&0xdead_beefu32.to_be_bytes());
    fake.extend_from_slice(&12u32.to_be_bytes());
    fake.extend_from_slice(&0u32.to_be_bytes());
    let macho = macho_with_signature(&fake);
    let report = ok(&macho_codesign(&macho, "{}"));
    assert_eq!(
        report["arches"][0]["code_signature"]["error"],
        "unexpected_superblob_magic"
    );
}

// ---------- cross-cutting limits ----------

#[test]
fn input_too_large() {
    let bytes = vec![0u8; MAX_INPUT_BYTES + 1];
    assert_eq!(err(&cert_inspect(&bytes, "{}")), "input_too_large");
    assert_eq!(err(&pkcs7_inspect(&bytes, "{}")), "input_too_large");
    assert_eq!(err(&crl_inspect(&bytes, "{}")), "input_too_large");
    assert_eq!(err(&pe_authenticode(&bytes, "{}")), "input_too_large");
    assert_eq!(err(&macho_codesign(&bytes, "{}")), "input_too_large");
}

#[test]
fn options_too_large() {
    let options = format!("{{\"pad\":\"{}\"}}", "x".repeat(MAX_OPTIONS_BYTES));
    assert_eq!(err(&cert_inspect(&signer_cert(), &options)), "options_too_large");
}

#[test]
fn invalid_options() {
    assert_eq!(err(&cert_inspect(&signer_cert(), "{oops")), "invalid_options");
}

/// Prints base64 fixtures for `test/verify.mjs`. Regenerate with:
/// `DUMP_FIXTURES=1 cargo test -- --nocapture dump_fixtures`
#[test]
fn dump_fixtures() {
    if std::env::var("DUMP_FIXTURES").is_err() {
        return;
    }
    let cms = cms_der(&CmsOpts {
        certs: vec![signer_cert()],
        ..Default::default()
    });
    let cms_spc = cms_der(&CmsOpts {
        econtent_type: OID_SPC_INDIRECT_DATA,
        content: Some(spc_indirect_data_der()),
        certs: vec![signer_cert()],
        countersignature: true,
        page_hash_attr: true,
        ..Default::default()
    });
    let superblob = signed_superblob();
    let unsigned_macho = {
        let mut bytes = vec![0u8; 0x40];
        bytes[0..4].copy_from_slice(&0xfeedfacfu32.to_le_bytes());
        bytes[4..8].copy_from_slice(&0x0100_000cu32.to_le_bytes());
        bytes[12..16].copy_from_slice(&2u32.to_le_bytes());
        bytes
    };
    for (name, bytes) in [
        ("CERT", signer_cert()),
        ("CERT2", cert_der("Second", "Second", &[0x05], false, false, &[])),
        ("CRL", crl_der("Test CA", &[&[0x0a], &[0x0b], &[0x0c]])),
        ("CMS", cms),
        ("CMS_SPC", cms_spc.clone()),
        ("PE_SIGNED", pe_image(Some(&cms_spc), None)),
        ("PE_UNSIGNED", pe_image(None, None)),
        ("MACHO_SIGNED", macho_with_signature(&superblob)),
        ("MACHO_UNSIGNED", unsigned_macho),
        ("ENTITLEMENTS_XML", ENTITLEMENTS_XML.as_bytes().to_vec()),
    ] {
        println!("@@FIXTURE {name} {}", base64(&bytes));
    }
}

#[test]
fn deterministic_output() {
    let der = signer_cert();
    assert_eq!(cert_inspect(&der, "{}"), cert_inspect(&der, "{}"));
    let cms = cms_der(&CmsOpts {
        certs: vec![signer_cert()],
        countersignature: true,
        ..Default::default()
    });
    assert_eq!(pkcs7_inspect(&cms, "{}"), pkcs7_inspect(&cms, "{}"));
    let macho = macho_with_signature(&signed_superblob());
    assert_eq!(macho_codesign(&macho, "{}"), macho_codesign(&macho, "{}"));
}
