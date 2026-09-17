//! Bounded, offline, parse-only inspection of code-signing and PKI structures.
//!
//! This module never verifies signatures, trust chains, timestamps, or revocation
//! status, and never contacts a network, filesystem, or OCSP/CRL responder. It
//! reports structural facts only.

mod cert;
mod crl;
mod macho;
mod pe;
mod pkcs7;
mod spc;

#[cfg(test)]
mod fixtures;
#[cfg(test)]
mod tests;

use serde::Deserialize;
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

pub(crate) const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const MAX_OPTIONS_BYTES: usize = 4 * 1024;
pub(crate) const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_ITEMS: usize = 4096;
pub(crate) const MAX_STRING_BYTES: usize = 4096;
pub(crate) const MAX_XML_BYTES: usize = 256 * 1024;
pub(crate) const MAX_BLOB_INDEX: usize = 4096;

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Options {
    #[serde(alias = "max_items")]
    max_items: Option<usize>,
    #[serde(alias = "include_entitlements_xml")]
    include_entitlements_xml: Option<bool>,
}

impl Options {
    pub(crate) fn limit(&self) -> usize {
        self.max_items.unwrap_or(MAX_ITEMS).clamp(1, MAX_ITEMS)
    }

    pub(crate) fn include_xml(&self) -> bool {
        self.include_entitlements_xml.unwrap_or(true)
    }
}

/// Shared per-request collection state so every operation applies the same
/// truncation and warning semantics.
pub(crate) struct Report {
    pub warnings: Vec<String>,
    pub truncated: bool,
    pub limit: usize,
    pub include_xml: bool,
}

impl Report {
    fn new(options: &Options) -> Self {
        Self {
            warnings: Vec::new(),
            truncated: false,
            limit: options.limit(),
            include_xml: options.include_xml(),
        }
    }

    pub(crate) fn truncate_list<'a, T>(
        &mut self,
        items: &'a [T],
        field: &str,
    ) -> &'a [T] {
        if items.len() > self.limit {
            self.truncated = true;
            self.warnings
                .push(format!("{field} truncated from {} to {}", items.len(), self.limit));
            &items[..self.limit]
        } else {
            items
        }
    }
}

/// Inspect one X.509 certificate (DER) or a PEM bundle of certificates.
/// Returns `{schema_version, certificates, count, ...}`. Parse only; no trust
/// or signature verification is performed.
#[wasm_bindgen]
pub fn cert_inspect(bytes: &[u8], options_json: &str) -> String {
    guard(bytes, options_json, cert::inspect)
}

/// Inspect a PKCS#7/CMS ContentInfo structure (DER or PEM). Reports the
/// SignedData signer infos, embedded certificates, countersignatures, and the
/// messageDigest-vs-content structural comparison. Never verifies signatures.
#[wasm_bindgen]
pub fn pkcs7_inspect(bytes: &[u8], options_json: &str) -> String {
    guard(bytes, options_json, pkcs7::inspect)
}

/// Inspect an X.509 certificate revocation list (DER or PEM).
#[wasm_bindgen]
pub fn crl_inspect(bytes: &[u8], options_json: &str) -> String {
    guard(bytes, options_json, crl::inspect)
}

/// Extract the PE attribute-certificate table (WIN_CERTIFICATE) and parse the
/// enclosed PKCS#7/Authenticode structure. Reports SpcIndirectData facts and
/// page-hash attribute presence. Parse only.
#[wasm_bindgen]
pub fn pe_authenticode(bytes: &[u8], options_json: &str) -> String {
    guard(bytes, options_json, pe::inspect)
}

/// Locate LC_CODE_SIGNATURE in a Mach-O image and parse the code-signing
/// SuperBlob: CodeDirectory, requirements, entitlements, and CMS signature.
/// Parse only; no signature or requirement evaluation.
#[wasm_bindgen]
pub fn macho_codesign(bytes: &[u8], options_json: &str) -> String {
    guard(bytes, options_json, macho::inspect)
}

fn guard(
    bytes: &[u8],
    options_json: &str,
    operation: fn(&[u8], &mut Report) -> Result<Value, &'static str>,
) -> String {
    if options_json.len() > MAX_OPTIONS_BYTES {
        return error_json("options_too_large");
    }
    if bytes.is_empty() {
        return error_json("empty_input");
    }
    if bytes.len() > MAX_INPUT_BYTES {
        return error_json("input_too_large");
    }
    let options = match serde_json::from_str::<Options>(options_json) {
        Ok(options) => options,
        Err(_) => return error_json("invalid_options"),
    };
    let mut report = Report::new(&options);
    match operation(bytes, &mut report) {
        Ok(value) => match serde_json::to_string(&value) {
            Ok(output) if output.len() <= MAX_OUTPUT_BYTES => output,
            Ok(_) => error_json("output_too_large"),
            Err(_) => error_json("serialization_error"),
        },
        Err(code) => error_json(code),
    }
}

pub(crate) fn error_json(code: &str) -> String {
    json!({ "schema_version": 1, "error": code }).to_string()
}

pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0xf) as usize] as char);
    }
    output
}

/// Bound a string field so hostile input cannot grow the JSON report.
pub(crate) fn bounded_str(value: &str, report: &mut Report) -> String {
    bounded_text(value, MAX_STRING_BYTES, report)
}

/// Bound a string field to an explicit byte limit, on a char boundary.
pub(crate) fn bounded_text(value: &str, limit: usize, report: &mut Report) -> String {
    if value.len() <= limit {
        return value.to_string();
    }
    report.truncated = true;
    let end = value
        .char_indices()
        .take_while(|(index, _)| *index < limit)
        .last()
        .map(|(index, character)| index + character.len_utf8())
        .unwrap_or(0);
    value[..end].to_string()
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    hex_encode(&sha2::Sha256::digest(bytes))
}

/// Friendly labels for the small set of OIDs this tool reports on. Anything
/// not listed is reported by its dotted-decimal form only.
pub(crate) fn oid_label(oid: &str) -> &'static str {
    match oid {
        // Signature algorithms
        "1.2.840.113549.1.1.5" => "sha1WithRSAEncryption",
        "1.2.840.113549.1.1.10" => "rsassaPss",
        "1.2.840.113549.1.1.11" => "sha256WithRSAEncryption",
        "1.2.840.113549.1.1.12" => "sha384WithRSAEncryption",
        "1.2.840.113549.1.1.13" => "sha512WithRSAEncryption",
        "1.2.840.113549.1.1.14" => "sha224WithRSAEncryption",
        "1.2.840.10045.4.3.1" => "ecdsa-with-SHA224",
        "1.2.840.10045.4.3.2" => "ecdsa-with-SHA256",
        "1.2.840.10045.4.3.3" => "ecdsa-with-SHA384",
        "1.2.840.10045.4.3.4" => "ecdsa-with-SHA512",
        "1.2.840.10040.4.3" => "dsaWithSha1",
        "1.3.101.112" => "ed25519",
        "1.3.101.113" => "ed448",
        // Key algorithms
        "1.2.840.113549.1.1.1" => "rsaEncryption",
        "1.2.840.10045.2.1" => "id-ecPublicKey",
        "1.2.840.10040.4.1" => "dsa",
        // Digest algorithms
        "1.2.840.113549.2.5" => "md5",
        "1.3.14.3.2.26" => "sha1",
        "2.16.840.1.101.3.4.2.1" => "sha256",
        "2.16.840.1.101.3.4.2.2" => "sha384",
        "2.16.840.1.101.3.4.2.3" => "sha512",
        "2.16.840.1.101.3.4.2.4" => "sha224",
        "2.16.840.1.101.3.4.2.5" => "sha512-224",
        "2.16.840.1.101.3.4.2.6" => "sha512-256",
        // CMS content types
        "1.2.840.113549.1.7.1" => "data",
        "1.2.840.113549.1.7.2" => "signedData",
        "1.2.840.113549.1.7.3" => "envelopedData",
        "1.2.840.113549.1.7.4" => "signedAndEnvelopedData",
        "1.2.840.113549.1.7.5" => "digestedData",
        "1.2.840.113549.1.7.6" => "encryptedData",
        "1.2.840.113549.1.9.16.1.2" => "authenticatedData",
        "1.2.840.113549.1.9.16.1.4" => "tstInfo",
        // CMS attribute types
        "1.2.840.113549.1.9.3" => "contentType",
        "1.2.840.113549.1.9.4" => "messageDigest",
        "1.2.840.113549.1.9.5" => "signingTime",
        "1.2.840.113549.1.9.6" => "countersignature",
        "1.2.840.113549.1.9.15" => "smimeCapabilities",
        "1.2.840.113549.1.9.16.2.47" => "signingCertificateV2",
        // Microsoft code-signing OIDs
        "1.3.6.1.4.1.311.2.1.4" => "spcIndirectDataContext",
        "1.3.6.1.4.1.311.2.1.15" => "spcPeImageData",
        "1.3.6.1.4.1.311.2.1.11" => "spcStatementType",
        "1.3.6.1.4.1.311.2.1.12" => "spcSpOpusInfo",
        "1.3.6.1.4.1.311.2.3.1" => "spcPeImagePageHashesV1",
        "1.3.6.1.4.1.311.2.3.2" => "spcPeImagePageHashesV2",
        "1.3.6.1.4.1.311.2.4.1" => "spcNestedSignature",
        "1.3.6.1.4.1.311.10.3.6" => "msNtVer",
        "1.3.6.1.4.1.311.60.2.1.1" => "msSpcExtensionData",
        "1.3.6.1.4.1.311.60.2.1.2" => "msSpcStatementOfIntent",
        // X.509 extensions
        "2.5.29.14" => "subjectKeyIdentifier",
        "2.5.29.15" => "keyUsage",
        "2.5.29.17" => "subjectAltName",
        "2.5.29.18" => "issuerAltName",
        "2.5.29.19" => "basicConstraints",
        "2.5.29.20" => "cRLNumber",
        "2.5.29.21" => "reasonCode",
        "2.5.29.31" => "cRLDistributionPoints",
        "2.5.29.32" => "certificatePolicies",
        "2.5.29.35" => "authorityKeyIdentifier",
        "2.5.29.36" => "policyConstraints",
        "2.5.29.37" => "extendedKeyUsage",
        "1.3.6.1.5.5.7.1.1" => "authorityInfoAccess",
        "1.3.6.1.5.5.7.1.11" => "subjectInfoAccess",
        "1.3.6.1.4.1.11129.2.4.2" => "signedCertificateTimestampList",
        _ => "unknown",
    }
}

/// True when the input looks like PEM text rather than DER.
pub(crate) fn looks_like_pem(bytes: &[u8]) -> bool {
    let text = match std::str::from_utf8(&bytes[..bytes.len().min(256)]) {
        Ok(text) => text,
        Err(_) => return false,
    };
    text.trim_start().starts_with("-----BEGIN ")
}
