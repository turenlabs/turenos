//! PKCS#7/CMS ContentInfo inspection. Reports structure only: signer infos,
//! embedded certificates, countersignature presence, and the messageDigest
//! vs encapsulated-content comparison. Signatures are never verified.

use cms::cert::CertificateChoices;
use cms::content_info::ContentInfo;
use cms::signed_data::{SignedData, SignerIdentifier};
use der::{Decode, Encode, Tagged};
use serde_json::{json, Value};
use x509_parser::pem::Pem;

use crate::{bounded_str, hex_encode, looks_like_pem, sha256_hex, Report, MAX_ITEMS};

pub(crate) const OID_SIGNED_DATA: &str = "1.2.840.113549.1.7.2";
pub(crate) const OID_MESSAGE_DIGEST: &str = "1.2.840.113549.1.9.4";
pub(crate) const OID_SIGNING_TIME: &str = "1.2.840.113549.1.9.5";
pub(crate) const OID_COUNTERSIGNATURE: &str = "1.2.840.113549.1.9.6";
pub(crate) const OID_SPC_INDIRECT_DATA: &str = "1.3.6.1.4.1.311.2.1.4";
pub(crate) const OID_SPC_PAGE_HASHES_V1: &str = "1.3.6.1.4.1.311.2.3.1";
pub(crate) const OID_SPC_PAGE_HASHES_V2: &str = "1.3.6.1.4.1.311.2.3.2";
pub(crate) const OID_SPC_NESTED_SIGNATURE: &str = "1.3.6.1.4.1.311.2.4.1";

pub(crate) fn inspect(bytes: &[u8], report: &mut Report) -> Result<Value, &'static str> {
    let der = unwrap_der(bytes, report)?;
    Ok(inspect_der(&der, report)?.report)
}

/// Decode a PEM block (any label, first block) or return the raw bytes as DER.
fn unwrap_der(bytes: &[u8], report: &mut Report) -> Result<Vec<u8>, &'static str> {
    if !looks_like_pem(bytes) {
        return Ok(bytes.to_vec());
    }
    let mut blocks = Pem::iter_from_buffer(bytes);
    let first = blocks.next().ok_or("pem_parse_error")?;
    let pem = first.map_err(|_| "pem_parse_error")?;
    if blocks.next().is_some() {
        report
            .warnings
            .push("additional pem blocks ignored".to_string());
    }
    Ok(pem.contents)
}

/// Structural facts extracted while building a PKCS#7 report, so the PE and
/// Mach-O operations can report Authenticode-specific details without
/// re-parsing.
pub(crate) struct ParsedPkcs7 {
    pub report: Value,
    pub econtent_type: Option<String>,
    /// The octets inside the eContent OCTET STRING, when attached.
    pub econtent: Option<Vec<u8>>,
    pub signer_count: usize,
    pub countersignatures: usize,
    pub nested_signatures: usize,
    /// Page-hash OIDs seen in signer attributes (SPC_PE_IMAGE_PAGE_HASHES_*).
    pub page_hash_oids: Vec<String>,
}

/// Parse a DER ContentInfo into a structural report. Shared by
/// `pkcs7_inspect`, `pe_authenticode`, and `macho_codesign`.
pub(crate) fn inspect_der(
    der: &[u8],
    report: &mut Report,
) -> Result<ParsedPkcs7, &'static str> {
    let info = ContentInfo::from_der(der).map_err(|_| "invalid_content_info")?;
    let content_type = info.content_type.to_string();
    let mut out = json!({
        "schema_version": 1,
        "operation": "pkcs7_inspect",
        "content_type": content_type,
        "content_type_name": crate::oid_label(&content_type),
    });
    let mut parsed = ParsedPkcs7 {
        report: Value::Null,
        econtent_type: None,
        econtent: None,
        signer_count: 0,
        countersignatures: 0,
        nested_signatures: 0,
        page_hash_oids: Vec::new(),
    };
    if content_type == OID_SIGNED_DATA {
        // `info.content` is the [0] EXPLICIT-unwrapped SignedData SEQUENCE.
        let signed = info
            .content
            .decode_as::<SignedData>()
            .map_err(|_| "invalid_signed_data")?;
        out["signed_data"] = signed_data_report(&signed, report, &mut parsed);
    } else {
        out["signed_data"] = json!(null);
    }
    out["warnings"] = json!(report.warnings);
    out["truncated"] = json!(report.truncated);
    parsed.report = out;
    Ok(parsed)
}

fn signed_data_report(
    signed: &SignedData,
    report: &mut Report,
    parsed: &mut ParsedPkcs7,
) -> Value {
    let digest_algorithms: Vec<Value> = signed
        .digest_algorithms
        .iter()
        .take(report.limit)
        .map(|algorithm| {
            let oid = algorithm.oid.to_string();
            json!({ "oid": oid, "name": crate::oid_label(&oid) })
        })
        .collect();

    let (content_bytes, econtent_oid) = encapsulated_content(signed);
    parsed.econtent_type = Some(econtent_oid.clone());
    parsed.econtent = content_bytes.clone();
    let mut certificates = Vec::new();
    let mut other_choices = 0usize;
    if let Some(set) = &signed.certificates {
        for choice in set.0.iter().take(report.limit) {
            match choice {
                CertificateChoices::Certificate(certificate) => {
                    match certificate.to_der() {
                        Ok(der) => match crate::cert::cert_report_der(&der, report) {
                            Ok(value) => certificates.push(value),
                            Err(code) => {
                                report
                                    .warnings
                                    .push(format!("embedded certificate parse failed: {code}"));
                                certificates.push(json!({ "error": code }));
                            }
                        },
                        Err(_) => report
                            .warnings
                            .push("embedded certificate re-encode failed".to_string()),
                    }
                }
                _ => other_choices += 1,
            }
        }
        if set.0.len() > report.limit {
            report.truncated = true;
            report.warnings.push(format!(
                "embedded certificates truncated from {} to {}",
                set.0.len(),
                report.limit
            ));
        }
    }

    let mut signers = Vec::new();
    for (index, signer) in signed.signer_infos.0.iter().enumerate() {
        if index >= report.limit.min(MAX_ITEMS) {
            report.truncated = true;
            break;
        }
        let (value, countersignatures, nested, page_hashes) =
            signer_report(signer, index, content_bytes.as_deref(), report);
        parsed.countersignatures += countersignatures;
        parsed.nested_signatures += nested;
        parsed.page_hash_oids.extend(page_hashes);
        signers.push(value);
    }
    if signed.signer_infos.0.len() > report.limit {
        report.truncated = true;
    }
    parsed.signer_count = signed.signer_infos.0.len();

    json!({
        "version": signed.version as u8,
        "digest_algorithms": digest_algorithms,
        "encapsulated_content": {
            "content_type": econtent_oid,
            "content_type_name": crate::oid_label(&econtent_oid),
            "attached": content_bytes.is_some(),
            "content_bytes": content_bytes.as_ref().map(|b| b.len()),
            "content_sha256": content_bytes.as_ref().map(|b| sha256_hex(b)),
        },
        "certificates": certificates,
        "other_certificate_choices": other_choices,
        "crls_present": signed.crls.as_ref().map(|c| c.0.len()).unwrap_or(0),
        "signer_infos": signers,
        "signer_count": signed.signer_infos.0.len(),
    })
}

/// The eContent OCTET STRING contents (the bytes the messageDigest covers)
/// plus the eContentType OID. `econtent` is `[0] EXPLICIT`-decoded, so the
/// `Any` already holds the inner OCTET STRING: `value()` is the payload.
fn encapsulated_content(signed: &SignedData) -> (Option<Vec<u8>>, String) {
    let oid = signed.encap_content_info.econtent_type.to_string();
    let content = signed
        .encap_content_info
        .econtent
        .as_ref()
        .filter(|any| any.tag() == der::Tag::OctetString)
        .map(|any| any.value().to_vec());
    (content, oid)
}

fn signer_report(
    signer: &cms::signed_data::SignerInfo,
    index: usize,
    content: Option<&[u8]>,
    report: &mut Report,
) -> (Value, usize, usize, Vec<String>) {
    let sid = match &signer.sid {
        SignerIdentifier::IssuerAndSerialNumber(issuer_serial) => json!({
            "kind": "issuer_and_serial_number",
            "issuer": bounded_str(&issuer_serial.issuer.to_string(), report),
            "serial_hex": hex_encode(issuer_serial.serial_number.as_bytes()),
        }),
        SignerIdentifier::SubjectKeyIdentifier(identifier) => json!({
            "kind": "subject_key_identifier",
            "ski_hex": hex_encode(identifier.0.as_bytes()),
        }),
    };

    let mut signed_oids = Vec::new();
    let mut message_digest: Option<Vec<u8>> = None;
    let mut signing_time: Option<String> = None;
    if let Some(attributes) = &signer.signed_attrs {
        for attribute in attributes.iter().take(report.limit) {
            let oid = attribute.oid.to_string();
            signed_oids.push(json!({
                "oid": oid,
                "name": crate::oid_label(&oid),
                "value_count": attribute.values.len(),
            }));
            match oid.as_str() {
                OID_MESSAGE_DIGEST => {
                    // The attribute value is a single OCTET STRING; `value()` is
                    // its content octets, i.e. the digest itself.
                    message_digest = attribute
                        .values
                        .iter()
                        .next()
                        .filter(|value| value.tag() == der::Tag::OctetString)
                        .map(|value| value.value().to_vec());
                }
                OID_SIGNING_TIME => {
                    signing_time = attribute
                        .values
                        .iter()
                        .next()
                        .and_then(|value| String::from_utf8(value.value().to_vec()).ok());
                }
                _ => {}
            }
        }
    }

    let mut unsigned_oids = Vec::new();
    let mut countersignatures = 0usize;
    let mut nested_signatures = 0usize;
    let mut page_hash_oids: Vec<String> = Vec::new();
    if let Some(attributes) = &signer.unsigned_attrs {
        for attribute in attributes.iter().take(report.limit) {
            let oid = attribute.oid.to_string();
            unsigned_oids.push(json!({
                "oid": oid,
                "name": crate::oid_label(&oid),
                "value_count": attribute.values.len(),
            }));
            match oid.as_str() {
                OID_COUNTERSIGNATURE => countersignatures += attribute.values.len(),
                OID_SPC_NESTED_SIGNATURE => nested_signatures += attribute.values.len(),
                OID_SPC_PAGE_HASHES_V1 | OID_SPC_PAGE_HASHES_V2 => page_hash_oids.push(oid),
                _ => {}
            }
        }
    }

    let digest_oid = signer.digest_alg.oid.to_string();
    let message_digest_matches = match (content, &message_digest) {
        (Some(content), Some(expected)) => digest_bytes(&digest_oid, content)
            .map(|computed| computed == *expected),
        _ => None,
    };

    let value = json!({
        "index": index,
        "version": signer.version as u8,
        "sid": sid,
        "digest_algorithm": { "oid": digest_oid, "name": crate::oid_label(&digest_oid) },
        "signature_algorithm": {
            "oid": signer.signature_algorithm.oid.to_string(),
            "name": crate::oid_label(&signer.signature_algorithm.oid.to_string()),
        },
        "signature_bytes": signer.signature.as_bytes().len(),
        "signed_attributes": signed_oids,
        "message_digest": message_digest.as_ref().map(|d| hex_encode(d)),
        "message_digest_matches_content": message_digest_matches,
        "signing_time": signing_time,
        "unsigned_attributes": unsigned_oids,
        "countersignatures": countersignatures,
        "nested_signatures": nested_signatures,
        "page_hash_oids": page_hash_oids.clone(),
    });
    (value, countersignatures, nested_signatures, page_hash_oids)
}

/// Hash `content` per the digestAlgorithm OID. Returns `None` for algorithms
/// this tool does not implement (structural report only, never verification).
pub(crate) fn digest_bytes(oid: &str, content: &[u8]) -> Option<Vec<u8>> {
    use sha1::Digest as _;
    match oid {
        "1.2.840.113549.2.5" => Some(md5::Md5::digest(content).to_vec()),
        "1.3.14.3.2.26" => Some(sha1::Sha1::digest(content).to_vec()),
        "2.16.840.1.101.3.4.2.4" => Some(sha2::Sha224::digest(content).to_vec()),
        "2.16.840.1.101.3.4.2.1" => Some(sha2::Sha256::digest(content).to_vec()),
        "2.16.840.1.101.3.4.2.2" => Some(sha2::Sha384::digest(content).to_vec()),
        "2.16.840.1.101.3.4.2.3" => Some(sha2::Sha512::digest(content).to_vec()),
        _ => None,
    }
}
