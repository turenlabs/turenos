//! `crypto_constants`: linear scan for known cryptographic artifacts.
//!
//! Signatures are grouped by first byte so each input position only compares
//! against the handful of tables that could start there. Word-oriented tables
//! (AES T-tables, SHA-2 IVs, MD5/Blowfish constants, Camellia sigmas) are
//! scanned in both little-endian and big-endian serializations.

use serde::{Deserialize, Serialize};

use crate::tables;
use crate::{error_json, to_json, MAX_RESULTS};

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ScanOptions {
    #[serde(alias = "max_findings")]
    max_findings: Option<usize>,
    #[serde(alias = "min_confidence")]
    min_confidence: Option<String>,
    algorithms: Option<Vec<String>>,
}

struct Signature {
    algorithm: &'static str,
    name: &'static str,
    kind: &'static str,
    endianness: &'static str,
    confidence: &'static str,
    bytes: Vec<u8>,
}

#[derive(Serialize)]
struct Finding {
    algorithm: &'static str,
    constant_name: &'static str,
    kind: &'static str,
    offset: usize,
    size: usize,
    endianness: &'static str,
    confidence: &'static str,
}

#[derive(Serialize)]
struct Report {
    schema_version: u32,
    input_bytes: usize,
    signatures_checked: usize,
    findings: Vec<Finding>,
    warnings: Vec<String>,
    truncated: bool,
}

pub fn run(bytes: &[u8], options_json: &str) -> String {
    let options: ScanOptions = match serde_json::from_str(options_json) {
        Ok(options) => options,
        Err(error) => return error_json("options_invalid", &error.to_string()),
    };
    let max_findings = options
        .max_findings
        .unwrap_or(MAX_RESULTS)
        .clamp(1, MAX_RESULTS);
    let min_confidence = match options.min_confidence.as_deref() {
        None | Some("low") => 0u8,
        Some("medium") => 1,
        Some("high") => 2,
        Some(other) => {
            return error_json(
                "options_invalid",
                &format!("unknown minConfidence {other:?}; expected low|medium|high"),
            )
        }
    };
    let algorithms: Option<Vec<String>> = options.algorithms.map(|list| {
        list.into_iter()
            .map(|a| a.to_ascii_lowercase())
            .take(256)
            .collect()
    });

    let signatures = signatures();
    // Bucket signature indices by first byte so most positions skip all work.
    let mut buckets: Vec<Vec<usize>> = (0..256).map(|_| Vec::new()).collect();
    let mut active = [false; 256];
    for (index, sig) in signatures.iter().enumerate() {
        buckets[sig.bytes[0] as usize].push(index);
        active[sig.bytes[0] as usize] = true;
    }

    let mut report = Report {
        schema_version: 1,
        input_bytes: bytes.len(),
        signatures_checked: signatures.len(),
        findings: Vec::new(),
        warnings: Vec::new(),
        truncated: false,
    };

    let filtered = min_confidence > 0 || algorithms.is_some();
    'outer: for (offset, &first) in bytes.iter().enumerate() {
        if !active[first as usize] {
            continue;
        }
        for &index in &buckets[first as usize] {
            let sig = &signatures[index];
            let size = sig.bytes.len();
            if offset + size > bytes.len() {
                continue;
            }
            if confidence_rank(sig.confidence) < min_confidence {
                continue;
            }
            if let Some(filter) = &algorithms {
                if !filter.iter().any(|a| a == sig.algorithm) {
                    continue;
                }
            }
            if bytes[offset..offset + size] != sig.bytes[..] {
                continue;
            }
            if report.findings.len() >= max_findings {
                report.truncated = true;
                report
                    .warnings
                    .push("findings_limit_reached".to_string());
                break 'outer;
            }
            report.findings.push(Finding {
                algorithm: sig.algorithm,
                constant_name: sig.name,
                kind: sig.kind,
                offset,
                size,
                endianness: sig.endianness,
                confidence: sig.confidence,
            });
        }
    }

    if filtered {
        report.warnings.push("findings_filtered".to_string());
    }

    to_json(&report)
}

fn confidence_rank(confidence: &str) -> u8 {
    match confidence {
        "high" => 2,
        "medium" => 1,
        _ => 0,
    }
}

fn words32_le(words: &[u32]) -> Vec<u8> {
    words.iter().flat_map(|w| w.to_le_bytes()).collect()
}

fn words32_be(words: &[u32]) -> Vec<u8> {
    words.iter().flat_map(|w| w.to_be_bytes()).collect()
}

fn words64_le(words: &[u64]) -> Vec<u8> {
    words.iter().flat_map(|w| w.to_le_bytes()).collect()
}

fn words64_be(words: &[u64]) -> Vec<u8> {
    words.iter().flat_map(|w| w.to_be_bytes()).collect()
}

fn byte_sig(
    sigs: &mut Vec<Signature>,
    algorithm: &'static str,
    name: &'static str,
    kind: &'static str,
    confidence: &'static str,
    bytes: &[u8],
) {
    sigs.push(Signature {
        algorithm,
        name,
        kind,
        endianness: "none",
        confidence,
        bytes: bytes.to_vec(),
    });
}

fn word32_sig(
    sigs: &mut Vec<Signature>,
    name: &'static str,
    algorithm: &'static str,
    kind: &'static str,
    confidence: &'static str,
    words: &[u32],
) {
    for (endianness, bytes) in [
        ("little", words32_le(words)),
        ("big", words32_be(words)),
    ] {
        sigs.push(Signature {
            algorithm,
            name,
            kind,
            endianness,
            confidence,
            bytes,
        });
    }
}

fn word64_sig(
    sigs: &mut Vec<Signature>,
    name: &'static str,
    algorithm: &'static str,
    kind: &'static str,
    confidence: &'static str,
    words: &[u64],
) {
    for (endianness, bytes) in [
        ("little", words64_le(words)),
        ("big", words64_be(words)),
    ] {
        sigs.push(Signature {
            algorithm,
            name,
            kind,
            endianness,
            confidence,
            bytes,
        });
    }
}

/// Build the full signature catalog. Kept behind one function so the scan is
/// stateless: the catalog is rebuilt per call (a few KiB of generated data).
fn signatures() -> Vec<Signature> {
    let mut sigs = Vec::with_capacity(160);

    // AES (FIPS-197): S-box, inverse S-box, Rcon, and the eight T-tables.
    byte_sig(&mut sigs, "aes", "sbox", "sbox", "high", &tables::AES_SBOX);
    byte_sig(&mut sigs, "aes", "inverse-sbox", "sbox", "high", &tables::AES_INV_SBOX);
    byte_sig(&mut sigs, "aes", "rcon", "round-constant", "medium", &tables::AES_RCON);
    for (name, table) in [
        ("te0", &tables::AES_TE0),
        ("te1", &tables::AES_TE1),
        ("te2", &tables::AES_TE2),
        ("te3", &tables::AES_TE3),
        ("td0", &tables::AES_TD0),
        ("td1", &tables::AES_TD1),
        ("td2", &tables::AES_TD2),
        ("td3", &tables::AES_TD3),
    ] {
        word32_sig(&mut sigs, name, "aes", "t-table", "high", table);
    }

    // Hash initial vectors (FIPS 180-4) and MD5 (RFC 1321).
    word32_sig(&mut sigs, "iv", "sha1", "iv", "high", &tables::SHA1_IV);
    word32_sig(&mut sigs, "iv", "sha224", "iv", "high", &tables::SHA224_IV);
    word32_sig(&mut sigs, "iv", "sha256", "iv", "high", &tables::SHA256_IV);
    word64_sig(&mut sigs, "iv", "sha384", "iv", "high", &tables::SHA384_IV);
    word64_sig(&mut sigs, "iv", "sha512", "iv", "high", &tables::SHA512_IV);
    sigs.push(Signature {
        algorithm: "md5",
        name: "iv",
        kind: "iv",
        endianness: "little",
        confidence: "high",
        bytes: tables::MD5_IV_LE.to_vec(),
    });
    word32_sig(&mut sigs, "t-table", "md5", "round-constant", "high", &tables::MD5_T);

    // ChaCha20 / Salsa20 expansion strings.
    byte_sig(&mut sigs, "chacha20/salsa20", "sigma-expand-32-byte-k", "constant", "medium", tables::SIGMA);
    byte_sig(&mut sigs, "chacha20/salsa20", "tau-expand-16-byte-k", "constant", "medium", tables::TAU);

    // Camellia (RFC 3713).
    byte_sig(&mut sigs, "camellia", "sbox1", "sbox", "high", &tables::CAMELLIA_SBOX1);
    word64_sig(&mut sigs, "sigma", "camellia", "round-constant", "high", &tables::CAMELLIA_SIGMA);

    // Serpent (AES submission).
    for (index, sbox) in tables::SERPENT_SBOXES.iter().enumerate() {
        let name: &'static str = match index {
            0 => "sbox0",
            1 => "sbox1",
            2 => "sbox2",
            3 => "sbox3",
            4 => "sbox4",
            5 => "sbox5",
            6 => "sbox6",
            _ => "sbox7",
        };
        byte_sig(&mut sigs, "serpent", name, "sbox", "medium", sbox);
    }

    // Twofish fixed permutations.
    byte_sig(&mut sigs, "twofish", "q0", "permutation", "high", &tables::TWOFISH_Q0);
    byte_sig(&mut sigs, "twofish", "q1", "permutation", "high", &tables::TWOFISH_Q1);

    // Blowfish pi tables.
    word32_sig(&mut sigs, "p-array", "blowfish", "round-constant", "high", &tables::BLOWFISH_P);
    for (name, table) in [
        ("sbox0", &tables::BLOWFISH_S0),
        ("sbox1", &tables::BLOWFISH_S1),
        ("sbox2", &tables::BLOWFISH_S2),
        ("sbox3", &tables::BLOWFISH_S3),
    ] {
        word32_sig(&mut sigs, name, "blowfish", "sbox", "high", table);
    }

    // DES (FIPS 46-3).
    for (index, sbox) in tables::DES_SBOXES.iter().enumerate() {
        let name: &'static str = match index {
            0 => "sbox1",
            1 => "sbox2",
            2 => "sbox3",
            3 => "sbox4",
            4 => "sbox5",
            5 => "sbox6",
            6 => "sbox7",
            _ => "sbox8",
        };
        byte_sig(&mut sigs, "des", name, "sbox", "high", sbox);
    }

    // DER algorithm-identifier and named-curve OIDs.
    for (name, algorithm, oid) in tables::OIDS {
        byte_sig(&mut sigs, algorithm, name, "oid", "medium", oid);
    }

    // DER structural templates and CAPI blob magics.
    for (name, algorithm, template) in tables::TEMPLATES {
        let confidence = if template.len() >= 12 { "high" } else { "low" };
        byte_sig(&mut sigs, algorithm, name, "template", confidence, template);
    }

    // Textual markers (bcrypt/argon2 prefixes, PEM armor, JWT prefixes).
    for (name, algorithm, confidence, text) in tables::TEXT_MARKERS {
        byte_sig(&mut sigs, algorithm, name, "string", confidence, text);
    }

    sigs
}
