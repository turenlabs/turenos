//! X.509 certificate revocation list inspection (DER or PEM).

use serde_json::{json, Value};
use x509_parser::pem::Pem;

use crate::{bounded_str, hex_encode, looks_like_pem, Report};

pub(crate) fn inspect(bytes: &[u8], report: &mut Report) -> Result<Value, &'static str> {
    let der = unwrap_der(bytes, report)?;
    let (_, crl) =
        x509_parser::parse_x509_crl(&der).map_err(|_| "crl_parse_error")?;
    let tbs = &crl.tbs_cert_list;

    let mut revoked = Vec::new();
    for entry in tbs.revoked_certificates.iter().take(report.limit) {
        revoked.push(json!({
            "serial_hex": hex_encode(entry.raw_serial()),
            "revocation_date": {
                "unix": entry.revocation_date.timestamp(),
                "rfc2822": entry.revocation_date.to_rfc2822()
                    .unwrap_or_else(|_| entry.revocation_date.to_string()),
            },
            "reason_code": entry.reason_code().map(|(_, code)| code.to_string()),
        }));
    }
    let revoked_total = tbs.revoked_certificates.len();
    if revoked_total > report.limit {
        report.truncated = true;
        report.warnings.push(format!(
            "revoked certificates truncated from {} to {}",
            revoked_total, report.limit
        ));
    }

    let extensions: Vec<Value> = report
        .truncate_list(tbs.extensions(), "extensions")
        .iter()
        .map(|extension| {
            json!({
                "oid": extension.oid.to_id_string(),
                "name": crate::oid_label(&extension.oid.to_id_string()),
                "critical": extension.critical,
            })
        })
        .collect();

    Ok(json!({
        "schema_version": 1,
        "operation": "crl_inspect",
        "issuer": bounded_str(&tbs.issuer.to_string(), report),
        "this_update": {
            "unix": tbs.this_update.timestamp(),
            "rfc2822": tbs.this_update.to_rfc2822()
                .unwrap_or_else(|_| tbs.this_update.to_string()),
        },
        "next_update": tbs.next_update.map(|time| json!({
            "unix": time.timestamp(),
            "rfc2822": time.to_rfc2822().unwrap_or_else(|_| time.to_string()),
        })),
        "signature_algorithm": {
            "oid": crl.signature_algorithm.algorithm.to_id_string(),
            "name": crate::oid_label(&crl.signature_algorithm.algorithm.to_id_string()),
        },
        "crl_number_hex": crl.crl_number().map(|number| hex_encode(&number.to_bytes_be())),
        "revoked_count": revoked_total,
        "revoked": revoked,
        "extensions": extensions,
        "truncated": report.truncated,
        "warnings": report.warnings,
    }))
}

fn unwrap_der(bytes: &[u8], report: &mut Report) -> Result<Vec<u8>, &'static str> {
    if !looks_like_pem(bytes) {
        return Ok(bytes.to_vec());
    }
    let mut blocks = Pem::iter_from_buffer(bytes);
    let first = blocks.next().ok_or("pem_parse_error")?;
    let pem = first.map_err(|_| "pem_parse_error")?;
    if pem.label != "X509 CRL" {
        report
            .warnings
            .push(format!("unexpected pem label {}", pem.label));
    }
    if blocks.next().is_some() {
        report
            .warnings
            .push("additional pem blocks ignored".to_string());
    }
    Ok(pem.contents)
}
