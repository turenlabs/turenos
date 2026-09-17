use md5::Md5;
use serde::Serialize;
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha512};
use std::fmt::Write;
use std::str::FromStr;
use wasm_bindgen::prelude::*;

const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_STRING_ARG_BYTES: usize = 4 * 1024;
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_IMPHASH_IMPORTS: usize = 4096;
const MAX_SSDEEP_PART_BYTES: usize = 64;
const MAX_SSDEEP_BLOCK_SIZE: u32 = i32::MAX as u32;

#[derive(Serialize)]
struct HashAll {
    schema_version: u8,
    bytes: usize,
    md5: String,
    sha1: String,
    sha256: String,
    sha512: String,
    blake3: String,
    xxh64: String,
    imphash: Option<String>,
}

#[derive(Serialize)]
struct FuzzyHashResult<'a> {
    schema_version: u8,
    algorithm: &'a str,
    bytes: usize,
    hash: String,
}

#[derive(Serialize)]
struct CompareResult<'a> {
    schema_version: u8,
    algorithm: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    score: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    distance: Option<i32>,
}

/// Compute MD5, SHA-1, SHA-256, SHA-512, BLAKE3, and xxHash64 over the input,
/// plus the PE import hash (imphash) when the input parses as a PE.
///
/// Returns a JSON document; expected failures return
/// `{"schema_version":1,"error":"<code>"}` instead of throwing.
#[wasm_bindgen]
pub fn hash_all(bytes: &[u8]) -> String {
    if bytes.len() > MAX_INPUT_BYTES {
        return error("input_too_large");
    }
    serialize(&HashAll {
        schema_version: 1,
        bytes: bytes.len(),
        md5: hex(Md5::digest(bytes)),
        sha1: hex(Sha1::digest(bytes)),
        sha256: hex(Sha256::digest(bytes)),
        sha512: hex(Sha512::digest(bytes)),
        blake3: blake3::hash(bytes).to_hex().to_string(),
        xxh64: format!("{:016x}", xxhash_rust::xxh64::xxh64(bytes, 0)),
        imphash: imphash(bytes),
    })
}

/// Compute a similarity hash of `bytes` using `algorithm` ("ssdeep" or "tlsh").
#[wasm_bindgen]
pub fn fuzzy_hash(algorithm: &str, bytes: &[u8]) -> String {
    if algorithm.len() > MAX_STRING_ARG_BYTES {
        return error("options_too_large");
    }
    if bytes.len() > MAX_INPUT_BYTES {
        return error("input_too_large");
    }
    match algorithm {
        "ssdeep" => {
            let hash = fuzzyhash::FuzzyHash::new(bytes).to_string();
            if hash.is_empty() {
                return error("internal_error");
            }
            serialize(&FuzzyHashResult {
                schema_version: 1,
                algorithm,
                bytes: bytes.len(),
                hash,
            })
        }
        "tlsh" => match tlsh2::TlshDefaultBuilder::build_from(bytes) {
            Some(tlsh) => serialize(&FuzzyHashResult {
                schema_version: 1,
                algorithm,
                bytes: bytes.len(),
                hash: String::from_utf8_lossy(&tlsh.hash()).into_owned(),
            }),
            None => error("insufficient_data"),
        },
        _ => error("unknown_algorithm"),
    }
}

/// Compare two similarity hash strings. `algorithm` is "ssdeep" or "tlsh".
/// ssdeep reports a 0-100 similarity `score`; TLSH reports a `distance`
/// where 0 is identical and larger values are more different.
#[wasm_bindgen]
pub fn fuzzy_compare(algorithm: &str, hash_a: &str, hash_b: &str) -> String {
    if algorithm.len() > MAX_STRING_ARG_BYTES
        || hash_a.len() > MAX_STRING_ARG_BYTES
        || hash_b.len() > MAX_STRING_ARG_BYTES
    {
        return error("options_too_large");
    }
    match algorithm {
        "ssdeep" => {
            if !is_ssdeep_hash(hash_a) || !is_ssdeep_hash(hash_b) {
                return error("invalid_hash");
            }
            match fuzzyhash::FuzzyHash::compare(hash_a, hash_b) {
                Ok(score) => serialize(&CompareResult {
                    schema_version: 1,
                    algorithm,
                    score: Some(score),
                    distance: None,
                }),
                // Structurally valid hashes that cannot produce a similarity
                // (incompatible block sizes, no common substring) score 0.
                Err(
                    fuzzyhash::error::Error::IncompatibleBlockSizes
                    | fuzzyhash::error::Error::NoCommonSubstrings,
                ) => serialize(&CompareResult {
                    schema_version: 1,
                    algorithm,
                    score: Some(0),
                    distance: None,
                }),
                Err(_) => error("invalid_hash"),
            }
        }
        "tlsh" => {
            let a = match tlsh2::TlshDefault::from_str(hash_a) {
                Ok(value) => value,
                Err(_) => return error("invalid_hash"),
            };
            let b = match tlsh2::TlshDefault::from_str(hash_b) {
                Ok(value) => value,
                Err(_) => return error("invalid_hash"),
            };
            serialize(&CompareResult {
                schema_version: 1,
                algorithm,
                score: None,
                distance: Some(a.diff(&b, true)),
            })
        }
        _ => error("unknown_algorithm"),
    }
}

/// ssdeep CTPH hash via the pure-Rust `fuzzyhash` crate: `block:hash1:hash2`.
fn is_ssdeep_hash(value: &str) -> bool {
    let mut parts = value.split(':');
    let (Some(block), Some(first), Some(second), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    if block.is_empty() || !block.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    let Ok(size) = block.parse::<u32>() else {
        return false;
    };
    // Reject zero and block sizes whose doubled value would overflow u32.
    if size == 0 || size > MAX_SSDEEP_BLOCK_SIZE {
        return false;
    }
    is_ssdeep_part(first) && is_ssdeep_part(second)
}

fn is_ssdeep_part(part: &str) -> bool {
    part.len() <= MAX_SSDEEP_PART_BYTES
        && part
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/')
}

/// Standard imphash (Mandiant/pefile convention): MD5 over the comma-joined,
/// lowercase `library.function` list in import order. The library extension is
/// stripped for .ocx/.sys/.dll and by-ordinal imports render as `ord<N>`.
fn imphash(bytes: &[u8]) -> Option<String> {
    let options = goblin::pe::options::ParseOptions::default()
        .with_parse_mode(goblin::pe::options::ParseMode::Permissive);
    let pe = goblin::pe::PE::parse_with_opts(bytes, &options).ok()?;
    if pe.imports.is_empty() {
        return None;
    }
    let entries: Vec<String> = pe
        .imports
        .iter()
        .take(MAX_IMPHASH_IMPORTS)
        .map(|import| {
            let function = if import.name.is_empty() || import.name.starts_with("ORDINAL ") {
                format!("ord{}", import.ordinal)
            } else {
                import.name.to_lowercase()
            };
            format!("{}.{}", imphash_library(import.dll), function)
        })
        .collect();
    if entries.is_empty() {
        return None;
    }
    Some(hex(Md5::digest(entries.join(",").as_bytes())))
}

fn imphash_library(dll: &str) -> String {
    let lower = dll.to_lowercase();
    match lower.rsplit_once('.') {
        Some((stem, "ocx" | "sys" | "dll")) => stem.to_string(),
        _ => lower,
    }
}

fn hex(digest: impl AsRef<[u8]>) -> String {
    digest
        .as_ref()
        .iter()
        .fold(String::new(), |mut out, byte| {
            let _ = write!(out, "{byte:02x}");
            out
        })
}

fn serialize(value: &impl Serialize) -> String {
    match serde_json::to_string(value) {
        Ok(json) if json.len() <= MAX_OUTPUT_BYTES => json,
        Ok(_) => error("output_too_large"),
        Err(_) => error("internal_error"),
    }
}

fn error(code: &str) -> String {
    format!(r#"{{"schema_version":1,"error":"{code}"}}"#)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn parse(output: String) -> Value {
        serde_json::from_str(&output).expect("output must be JSON")
    }

    #[test]
    fn hash_all_abc_known_answers() {
        let result = parse(hash_all(b"abc"));
        assert_eq!(result["schema_version"], 1);
        assert_eq!(result["bytes"], 3);
        assert_eq!(result["md5"], "900150983cd24fb0d6963f7d28e17f72");
        assert_eq!(result["sha1"], "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(
            result["sha256"],
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            result["sha512"],
            "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a\
2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"
        );
        assert_eq!(
            result["blake3"],
            "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85"
        );
        assert_eq!(result["xxh64"], "44bc2cf5ad770999");
        assert!(result["imphash"].is_null());
    }

    #[test]
    fn hash_all_empty_known_answers() {
        let result = parse(hash_all(b""));
        assert_eq!(result["bytes"], 0);
        assert_eq!(result["md5"], "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(result["sha1"], "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(
            result["sha256"],
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            result["sha512"],
            "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce\
47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e"
        );
        assert_eq!(
            result["blake3"],
            "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262"
        );
        assert_eq!(result["xxh64"], "ef46db3751d8e999");
        assert!(result["imphash"].is_null());
    }

    #[test]
    fn hash_all_input_too_large() {
        let oversized = vec![0u8; MAX_INPUT_BYTES + 1];
        let result = parse(hash_all(&oversized));
        assert_eq!(result["error"], "input_too_large");
        let result = parse(fuzzy_hash("ssdeep", &oversized));
        assert_eq!(result["error"], "input_too_large");
    }

    #[test]
    fn hash_all_reports_imphash_for_pe() {
        let result = parse(hash_all(&minimal_pe()));
        // md5("kernel32.createfilea,kernel32.ord60,ws2_32.recv,ws2_32.ord115")
        assert_eq!(result["imphash"], "0c4f73a6f9ca4a45523c3f5eaf83360d");
    }

    #[test]
    fn hash_all_omits_imphash_for_malformed_pe() {
        for input in [
            &minimal_pe()[..200],
            b"MZ",
            b"MZ\x90\x00 not really a pe",
            &minimal_pe()[..0x84],
        ] {
            let result = parse(hash_all(input));
            assert_eq!(result["schema_version"], 1);
            assert!(result["imphash"].is_null(), "input {input:?}");
            assert!(result["md5"].is_string());
        }
    }

    #[test]
    fn fuzzy_hash_ssdeep_known_answers() {
        let result = parse(fuzzy_hash("ssdeep", b"this is our test data!"));
        assert_eq!(result["algorithm"], "ssdeep");
        assert_eq!(result["bytes"], 22);
        assert_eq!(result["hash"], "3:YKKGhR0tn:YRGRmn");

        let result = parse(fuzzy_hash("ssdeep", b""));
        assert_eq!(result["hash"], "3::");
    }

    #[test]
    fn fuzzy_hash_tlsh_known_answer() {
        let result = parse(fuzzy_hash(
            "tlsh",
            b"Lorem ipsum dolor sit amet, consectetur adipiscing elit",
        ));
        assert_eq!(result["algorithm"], "tlsh");
        assert_eq!(
            result["hash"],
            "T12D900249414E0BD59A46503F3ADA802AE50825242B2590561CF690599112214C051556"
        );
    }

    #[test]
    fn fuzzy_hash_tlsh_insufficient_data() {
        for input in [&b"too small"[..], &[0u8; 49][..], &[0u8; 400][..]] {
            let result = parse(fuzzy_hash("tlsh", input));
            assert_eq!(result["error"], "insufficient_data");
        }
    }

    #[test]
    fn fuzzy_hash_unknown_algorithm() {
        let result = parse(fuzzy_hash("md5", b"abc"));
        assert_eq!(result["error"], "unknown_algorithm");
        let result = parse(fuzzy_hash("SSDEEP", b"abc"));
        assert_eq!(result["error"], "unknown_algorithm");
        let result = parse(fuzzy_hash(&"x".repeat(5000), b"abc"));
        assert_eq!(result["error"], "options_too_large");
    }

    #[test]
    fn fuzzy_compare_ssdeep_known_score() {
        let result = parse(fuzzy_compare(
            "ssdeep",
            "96:U57GjXnLt9co6pZwvLhJluvrszNgMFwO6MFG8SvkpjTWf:Hj3BeoEcNJ0TspgIG8SvkpjTg",
            "96:U57GjXnLt9co6pZwvLhJluvrs1eRTxYARdEallia:Hj3BeoEcNJ0TsI9xYeia3R",
        ));
        assert_eq!(result["score"], 63);

        let result = parse(fuzzy_compare(
            "ssdeep",
            "3:HEREar5MFUul0U0KMP:knl8lkKMP",
            &parse(fuzzy_hash(
                "ssdeep",
                b"some data to hash for the purposes of running a test",
            ))["hash"]
                .as_str()
                .unwrap()
                .to_string(),
        ));
        assert_eq!(result["score"], 18);
    }

    #[test]
    fn fuzzy_compare_ssdeep_identical_and_dissimilar() {
        let hash = parse(fuzzy_hash("ssdeep", b"self similarity check"))["hash"]
            .as_str()
            .unwrap()
            .to_string();
        let result = parse(fuzzy_compare("ssdeep", &hash, &hash));
        assert_eq!(result["score"], 100);

        let other = parse(fuzzy_hash("ssdeep", &[7u8; 8192]))["hash"]
            .as_str()
            .unwrap()
            .to_string();
        let result = parse(fuzzy_compare("ssdeep", &hash, &other));
        assert!(result["score"].as_u64().unwrap() <= 40);
    }

    #[test]
    fn fuzzy_compare_ssdeep_invalid_hashes() {
        for bad in [
            "",
            "garbage",
            "1:2",
            "3:a",
            "0:abc:def",
            "2147483648:abc:def",
            "99999999999:abc:def",
            "3:a%$:def",
            "3:abc:def:extra",
            ":abc:def",
        ] {
            let good = "3:YKKGhR0tn:YRGRmn";
            let result = parse(fuzzy_compare("ssdeep", bad, good));
            assert_eq!(result["error"], "invalid_hash", "hash {bad:?}");
            let result = parse(fuzzy_compare("ssdeep", good, bad));
            assert_eq!(result["error"], "invalid_hash", "hash {bad:?}");
        }
    }

    #[test]
    fn fuzzy_compare_ssdeep_incompatible_scores_zero() {
        let result = parse(fuzzy_compare(
            "ssdeep",
            "3:YKKGhR0tn:YRGRmn",
            "6144:YKKGhR0tn:YRGRmn",
        ));
        assert_eq!(result["score"], 0);
    }

    #[test]
    fn fuzzy_compare_tlsh_known_distance() {
        let first = parse(fuzzy_hash(
            "tlsh",
            b"Lorem ipsum dolor sit amet, consectetur adipiscing elit",
        ))["hash"]
            .as_str()
            .unwrap()
            .to_string();
        let second = parse(fuzzy_hash(
            "tlsh",
            b"Duis aute irure dolor in reprehenderit in voluptate velit \
esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat \
cupidatat non proident, sunt in culpa qui officia",
        ))["hash"]
            .as_str()
            .unwrap()
            .to_string();

        let result = parse(fuzzy_compare("tlsh", &first, &first));
        assert_eq!(result["distance"], 0);

        let result = parse(fuzzy_compare("tlsh", &first, &second));
        assert_eq!(result["distance"], 280);
    }

    #[test]
    fn fuzzy_compare_tlsh_invalid_hashes() {
        let good = parse(fuzzy_hash(
            "tlsh",
            b"Lorem ipsum dolor sit amet, consectetur adipiscing elit",
        ))["hash"]
            .as_str()
            .unwrap()
            .to_string();
        for bad in [
            "",
            "T1",
            "T12D900249414E0BD59A46503F3ADA802AE50825242B2590561CF690599112214C05155G",
            "12D900249414E0BD59A46503F3ADA802AE50825242B2590561CF690599112214C051556",
            "3:YKKGhR0tn:YRGRmn",
        ] {
            let result = parse(fuzzy_compare("tlsh", bad, &good));
            assert_eq!(result["error"], "invalid_hash", "hash {bad:?}");
        }
    }

    #[test]
    fn fuzzy_compare_rejects_oversized_strings() {
        let big = "3:".to_string() + &"a".repeat(5000);
        let result = parse(fuzzy_compare("ssdeep", &big, "3:YKKGhR0tn:YRGRmn"));
        assert_eq!(result["error"], "options_too_large");
        let result = parse(fuzzy_compare("ssdeep", "3:YKKGhR0tn:YRGRmn", &big));
        assert_eq!(result["error"], "options_too_large");
    }

    #[test]
    fn deterministic_outputs() {
        let input = minimal_pe();
        assert_eq!(hash_all(&input), hash_all(&input));
        assert_eq!(
            fuzzy_hash("ssdeep", b"repeatable"),
            fuzzy_hash("ssdeep", b"repeatable")
        );
        assert_eq!(
            fuzzy_compare("ssdeep", "3:YKKGhR0tn:YRGRmn", "3:YKKGhR0tn:YRGRmn"),
            fuzzy_compare("ssdeep", "3:YKKGhR0tn:YRGRmn", "3:YKKGhR0tn:YRGRmn")
        );
    }

    #[test]
    fn no_panics_on_arbitrary_input() {
        // Deterministic byte sweep over both hashing ops.
        for length in (0..4096).step_by(37) {
            let input: Vec<u8> = (0..length).map(|i| (i * 31) as u8).collect();
            assert!(parse(hash_all(&input))["schema_version"] == 1);
            assert!(parse(fuzzy_hash("ssdeep", &input))["schema_version"] == 1);
            assert!(parse(fuzzy_hash("tlsh", &input))["schema_version"] == 1);
        }
        // Fuzz the compare path with hash-shaped and garbage strings.
        let seed = "6:AbCdEfGh+/09:ZyXwVu";
        for case in 0..64 {
            let mut probe = seed.to_string();
            probe.insert(case % probe.len(), char::from(b'!' + case as u8));
            let _ = fuzzy_compare("ssdeep", &probe, seed);
            let _ = fuzzy_compare("tlsh", &probe, seed);
        }
    }

    /// Minimal PE32 with two import descriptors: KERNEL32.dll exports
    /// CreateFileA (named) plus ordinal 60, WS2_32.DLL exports recv plus
    /// ordinal 115. RVAs 0x1000..0x13ff map 1:1 onto file bytes 0x200..0x5ff.
    fn minimal_pe() -> Vec<u8> {
        let mut pe = vec![0u8; 0x600];
        let put16 = |pe: &mut [u8], offset: usize, value: u16| {
            pe[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
        };
        let put32 = |pe: &mut [u8], offset: usize, value: u32| {
            pe[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        };

        pe[0] = b'M';
        pe[1] = b'Z';
        put32(&mut pe, 0x3c, 0x80);
        pe[0x80..0x84].copy_from_slice(b"PE\0\0");
        put16(&mut pe, 0x84, 0x14c); // machine: i386
        put16(&mut pe, 0x86, 1); // number of sections
        put16(&mut pe, 0x94, 0xe0); // size of optional header
        put16(&mut pe, 0x96, 0x010f); // characteristics
        put16(&mut pe, 0x98, 0x10b); // PE32 magic
        put32(&mut pe, 0x98 + 32, 0x1000); // section alignment
        put32(&mut pe, 0x98 + 36, 0x200); // file alignment
        put32(&mut pe, 0x98 + 56, 0x2000); // size of image
        put32(&mut pe, 0x98 + 60, 0x200); // size of headers
        put16(&mut pe, 0x98 + 68, 3); // subsystem: console
        put32(&mut pe, 0x98 + 92, 16); // number of rva and sizes
        put32(&mut pe, 0x98 + 104, 0x1000); // import directory rva
        put32(&mut pe, 0x98 + 108, 60); // import directory size

        pe[0x178..0x180].copy_from_slice(b".text\0\0\0");
        put32(&mut pe, 0x178 + 8, 0x400); // virtual size
        put32(&mut pe, 0x178 + 12, 0x1000); // virtual address
        put32(&mut pe, 0x178 + 16, 0x400); // size of raw data
        put32(&mut pe, 0x178 + 20, 0x200); // pointer to raw data

        // Import descriptor: KERNEL32.dll
        put32(&mut pe, 0x200, 0x1040); // import lookup table rva
        put32(&mut pe, 0x20c, 0x1080); // name rva
        put32(&mut pe, 0x210, 0x1060); // import address table rva
        // Import descriptor: WS2_32.DLL
        put32(&mut pe, 0x214, 0x10c0);
        put32(&mut pe, 0x220, 0x10a0);
        put32(&mut pe, 0x224, 0x10e0);
        // 0x228: null descriptor terminator

        // KERNEL32 ILT at rva 0x1040 (file 0x240): hint/name rva, ordinal 60
        put32(&mut pe, 0x240, 0x1090);
        put32(&mut pe, 0x244, 0x8000_003c);
        // KERNEL32 IAT at rva 0x1060 (file 0x260)
        put32(&mut pe, 0x260, 0x1090);
        put32(&mut pe, 0x264, 0x8000_003c);
        // WS2_32 ILT at rva 0x10c0 (file 0x2c0): hint/name rva, ordinal 115
        put32(&mut pe, 0x2c0, 0x1100);
        put32(&mut pe, 0x2c4, 0x8000_0073);
        // WS2_32 IAT at rva 0x10e0 (file 0x2e0)
        put32(&mut pe, 0x2e0, 0x1100);
        put32(&mut pe, 0x2e4, 0x8000_0073);

        pe[0x280..0x28c].copy_from_slice(b"KERNEL32.dll");
        pe[0x292..0x29d].copy_from_slice(b"CreateFileA"); // hint 0 at 0x290
        pe[0x2a0..0x2aa].copy_from_slice(b"WS2_32.DLL");
        pe[0x302..0x306].copy_from_slice(b"recv"); // hint 0 at 0x300
        pe
    }
}
