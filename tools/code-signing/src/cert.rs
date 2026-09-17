//! X.509 certificate inspection (DER single object or PEM bundle).

use serde_json::{json, Value};
use x509_parser::certificate::X509Certificate;
use x509_parser::extensions::{GeneralName, ParsedExtension};
use x509_parser::pem::Pem;
use x509_parser::public_key::PublicKey;

use crate::{bounded_str, hex_encode, looks_like_pem, sha256_hex, Report, MAX_ITEMS};

pub(crate) fn inspect(bytes: &[u8], report: &mut Report) -> Result<Value, &'static str> {
    let der_blocks = collect_der(bytes, report)?;
    if der_blocks.is_empty() {
        return Err("no_certificates");
    }
    let mut certificates = Vec::new();
    for der in der_blocks.iter().take(report.limit) {
        certificates.push(cert_report_der(der, report)?);
    }
    if der_blocks.len() > report.limit {
        report.truncated = true;
        report
            .warnings
            .push(format!("certificates truncated from {} to {}", der_blocks.len(), report.limit));
    }
    Ok(json!({
        "schema_version": 1,
        "operation": "cert_inspect",
        "count": certificates.len(),
        "certificates": certificates,
        "truncated": report.truncated,
        "warnings": report.warnings,
    }))
}

/// Collect DER certificate bodies from a PEM bundle or a single DER blob.
/// Every PEM block is decoded; only `CERTIFICATE` labels are returned.
fn collect_der<'a>(bytes: &'a [u8], report: &mut Report) -> Result<Vec<Vec<u8>>, &'static str> {
    if !looks_like_pem(bytes) {
        return Ok(vec![bytes.to_vec()]);
    }
    let mut blocks = Vec::new();
    for (index, item) in Pem::iter_from_buffer(bytes).enumerate() {
        if index >= MAX_ITEMS {
            report.truncated = true;
            report
                .warnings
                .push(format!("pem blocks truncated at {MAX_ITEMS}"));
            break;
        }
        let pem = item.map_err(|_| "pem_parse_error")?;
        if pem.label == "CERTIFICATE" {
            blocks.push(pem.contents);
        } else {
            report
                .warnings
                .push(format!("skipped pem block with label {}", pem.label));
        }
    }
    Ok(blocks)
}

/// Build the report for one DER-encoded certificate. Used by `cert_inspect`
/// and by the PKCS#7 embedded-certificate path.
pub(crate) fn cert_report_der(
    der: &[u8],
    report: &mut Report,
) -> Result<Value, &'static str> {
    let (_, cert) =
        x509_parser::parse_x509_certificate(der).map_err(|_| "cert_parse_error")?;
    Ok(cert_report(&cert, report))
}

fn cert_report(cert: &X509Certificate, report: &mut Report) -> Value {
    let tbs = &cert.tbs_certificate;
    let mut san_dns = Vec::new();
    let mut san_email = Vec::new();
    let mut san_uri = Vec::new();
    let mut san_ip = Vec::new();
    let mut san_dir = Vec::new();
    let mut san_other = 0usize;
    let mut san_present = false;
    let mut san_critical = false;

    for extension in report_limited(tbs.extensions(), report, "extensions") {
        match extension.parsed_extension() {
            ParsedExtension::SubjectAlternativeName(san) => {
                san_present = true;
                san_critical = extension.critical;
                for name in &san.general_names {
                    match name {
                        GeneralName::DNSName(value) => {
                            push_bounded(&mut san_dns, value, report, "san_dns_names")
                        }
                        GeneralName::RFC822Name(value) => {
                            push_bounded(&mut san_email, value, report, "san_emails")
                        }
                        GeneralName::URI(value) => {
                            push_bounded(&mut san_uri, value, report, "san_uris")
                        }
                        GeneralName::IPAddress(value) => san_ip.push(format_ip(value)),
                        GeneralName::DirectoryName(name) => {
                            push_bounded(&mut san_dir, &name.to_string(), report, "san_dir_names")
                        }
                        _ => san_other += 1,
                    }
                }
            }
            _ => {}
        }
    }

    let mut eku_oids = Vec::new();
    let mut eku_code_signing = false;
    let mut eku_critical = false;
    let mut eku_present = false;
    if let Ok(Some(eku)) = tbs.extended_key_usage() {
        eku_present = true;
        eku_critical = eku.critical;
        eku_code_signing = eku.value.code_signing;
        let usage = &eku.value;
        for (oid, enabled) in [
            ("2.5.29.37.0", usage.any),
            ("1.3.6.1.5.5.7.3.1", usage.server_auth),
            ("1.3.6.1.5.5.7.3.2", usage.client_auth),
            ("1.3.6.1.5.5.7.3.3", usage.code_signing),
            ("1.3.6.1.5.5.7.3.4", usage.email_protection),
            ("1.3.6.1.5.5.7.3.8", usage.time_stamping),
            ("1.3.6.1.5.5.7.3.9", usage.ocsp_signing),
        ] {
            if enabled {
                eku_oids.push(oid.to_string());
            }
        }
        for other in &usage.other {
            eku_oids.push(other.to_id_string());
        }
        if eku_oids.len() > report.limit {
            eku_oids.truncate(report.limit);
            report.truncated = true;
        }
    }

    let basic_constraints = tbs
        .basic_constraints()
        .ok()
        .flatten()
        .map(|bc| json!({
            "critical": bc.critical,
            "ca": bc.value.ca,
            "path_len_constraint": bc.value.path_len_constraint,
        }));

    let key_usage = tbs.key_usage().ok().flatten().map(|ku| {
        let flags = ku.value.flags;
        let names: Vec<&str> = [
            (0u16, "digital_signature"),
            (1, "non_repudiation"),
            (2, "key_encipherment"),
            (3, "data_encipherment"),
            (4, "key_agreement"),
            (5, "key_cert_sign"),
            (6, "crl_sign"),
            (7, "encipher_only"),
            (8, "decipher_only"),
        ]
        .iter()
        .filter_map(|(bit, name)| ((flags >> bit) & 1 == 1).then_some(*name))
        .collect();
        json!({ "critical": ku.critical, "flags": flags, "usages": names })
    });

    let (ski, aki, aki_serial) = key_identifiers(tbs, report);

    let spki = &tbs.subject_pki;
    let (key_size_bits, key_detail) = match spki.parsed() {
        Ok(public) => (
            Some(public.key_size()),
            match &public {
                PublicKey::RSA(rsa) => json!({
                    "modulus_bytes": rsa.modulus.len(),
                    "exponent": rsa.try_exponent().ok(),
                }),
                PublicKey::EC(point) => json!({ "point_bytes": point.data().len() }),
                _ => json!(null),
            },
        ),
        Err(_) => (None, json!(null)),
    };
    let curve_oid = spki
        .algorithm
        .parameters
        .as_ref()
        .filter(|parameters| parameters.tag() == x509_parser::asn1_rs::Tag::Oid)
        .and_then(|parameters| parameters.as_oid().ok())
        .map(|oid| oid.to_id_string());

    let extension_oids: Vec<Value> = report_limited(tbs.extensions(), report, "extensions")
        .iter()
        .map(|extension| {
            json!({
                "oid": extension.oid.to_id_string(),
                "name": crate::oid_label(&extension.oid.to_id_string()),
                "critical": extension.critical,
                "parsed": !matches!(
                    extension.parsed_extension(),
                    ParsedExtension::Unparsed | ParsedExtension::UnsupportedExtension { .. }
                ),
            })
        })
        .collect();

    json!({
        "subject": bounded_str(&tbs.subject.to_string(), report),
        "issuer": bounded_str(&tbs.issuer.to_string(), report),
        "serial_hex": hex_encode(tbs.raw_serial()),
        "serial_decimal": tbs.serial.to_str_radix(10),
        "version": tbs.version.0 + 1,
        "validity": {
            "not_before": time_report(&tbs.validity.not_before),
            "not_after": time_report(&tbs.validity.not_after),
        },
        "signature_algorithm": {
            "oid": cert.signature_algorithm.algorithm.to_id_string(),
            "name": crate::oid_label(&cert.signature_algorithm.algorithm.to_id_string()),
        },
        "signature_bytes": cert.signature_value.data.len(),
        "fingerprint_sha256": sha256_hex(cert.as_raw()),
        "public_key": {
            "algorithm_oid": spki.algorithm.algorithm.to_id_string(),
            "algorithm": crate::oid_label(&spki.algorithm.algorithm.to_id_string()),
            "size_bits": key_size_bits,
            "curve": curve_oid,
            "detail": key_detail,
        },
        "is_ca": tbs.is_ca(),
        "basic_constraints": basic_constraints,
        "key_usage": key_usage,
        "extended_key_usage": if eku_present {
            json!({
                "critical": eku_critical,
                "code_signing": eku_code_signing,
                "oids": eku_oids,
            })
        } else {
            json!(null)
        },
        "subject_alt_names": if san_present {
            json!({
                "critical": san_critical,
                "dns_names": san_dns,
                "email_addresses": san_email,
                "uris": san_uri,
                "ip_addresses": san_ip,
                "directory_names": san_dir,
                "other_count": san_other,
            })
        } else {
            json!(null)
        },
        "subject_key_identifier": ski,
        "authority_key_identifier": aki,
        "authority_cert_serial_hex": aki_serial,
        "extensions": extension_oids,
    })
}

fn report_limited<'a, T>(items: &'a [T], report: &mut Report, field: &str) -> &'a [T] {
    let limited = items.len().min(report.limit);
    if items.len() > limited {
        report.truncated = true;
        report
            .warnings
            .push(format!("{field} truncated from {} to {limited}", items.len()));
    }
    &items[..limited]
}

fn key_identifiers(
    tbs: &x509_parser::certificate::TbsCertificate,
    report: &mut Report,
) -> (Value, Value, Value) {
    let mut ski = Value::Null;
    let mut aki = Value::Null;
    let mut aki_serial = Value::Null;
    for extension in report_limited(tbs.extensions(), report, "extensions") {
        match extension.parsed_extension() {
            ParsedExtension::SubjectKeyIdentifier(identifier) => {
                ski = json!(hex_encode(identifier.0));
            }
            ParsedExtension::AuthorityKeyIdentifier(identifier) => {
                if let Some(key) = &identifier.key_identifier {
                    aki = json!(hex_encode(key.0));
                }
                if let Some(serial) = identifier.authority_cert_serial {
                    aki_serial = json!(hex_encode(serial));
                }
            }
            _ => {}
        }
    }
    (ski, aki, aki_serial)
}

fn time_report(time: &x509_parser::time::ASN1Time) -> Value {
    json!({
        "unix": time.timestamp(),
        "rfc2822": time.to_rfc2822().unwrap_or_else(|_| time.to_string()),
    })
}

fn push_bounded(
    values: &mut Vec<String>,
    value: &str,
    report: &mut Report,
    _field: &str,
) {
    if values.len() >= report.limit {
        report.truncated = true;
        return;
    }
    values.push(bounded_str(value, report));
}

fn format_ip(bytes: &[u8]) -> String {
    match bytes.len() {
        4 => format!("{}.{}.{}.{}", bytes[0], bytes[1], bytes[2], bytes[3]),
        16 => {
            let mut parts = [0u16; 8];
            for (index, chunk) in bytes.chunks_exact(2).enumerate() {
                parts[index] = u16::from_be_bytes([chunk[0], chunk[1]]);
            }
            parts
                .iter()
                .map(|part| format!("{part:x}"))
                .collect::<Vec<_>>()
                .join(":")
        }
        _ => format!("0x{}", hex_encode(bytes)),
    }
}
