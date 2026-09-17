use super::*;
use serde_json::Value;

fn parse(json: String) -> Value {
    serde_json::from_str(&json).expect("operation must return valid JSON")
}

/// Deterministic xorshift64* PRNG for high-entropy filler; no rand dep.
struct XorShift(u64);

impl XorShift {
    fn next(&mut self) -> u8 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        (x.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 56) as u8
    }

    fn fill(&mut self, buf: &mut [u8]) {
        for b in buf.iter_mut() {
            *b = self.next();
        }
    }
}

fn prng_buffer(len: usize, seed: u64) -> Vec<u8> {
    let mut rng = XorShift(seed);
    let mut buf = vec![0u8; len];
    rng.fill(&mut buf);
    buf
}

fn findings(bytes: &[u8], options: &str) -> Value {
    parse(crypto_constants(bytes, options))
}

fn has_finding(report: &Value, algorithm: &str, name: &str, offset: usize, endianness: &str) -> bool {
    report["findings"].as_array().unwrap().iter().any(|f| {
        f["algorithm"] == algorithm
            && f["constant_name"] == name
            && f["offset"] == offset
            && f["endianness"] == endianness
    })
}

// ---------------------------------------------------------------------------
// Known-answer table sanity

#[test]
fn aes_tables_match_fips197() {
    assert_eq!(tables::AES_SBOX[0], 0x63);
    assert_eq!(tables::AES_SBOX[1], 0x7c);
    assert_eq!(tables::AES_SBOX[0x53], 0xed);
    assert_eq!(tables::AES_SBOX[0xff], 0x16);
    assert_eq!(tables::AES_INV_SBOX[0x63], 0x00);
    assert_eq!(tables::AES_INV_SBOX[0xed], 0x53);
    for i in 0..256usize {
        assert_eq!(tables::AES_INV_SBOX[tables::AES_SBOX[i] as usize], i as u8);
    }
    // Published OpenSSL-style table entries.
    assert_eq!(tables::AES_TE0[0], 0xc66363a5);
    assert_eq!(tables::AES_TE0[1], 0xf87c7c84);
    assert_eq!(tables::AES_TE1[0], 0xa5c66363);
    assert_eq!(tables::AES_TE2[0], 0x63a5c663);
    assert_eq!(tables::AES_TE3[0], 0x6363a5c6);
    assert_eq!(tables::AES_TD0[0], 0x51f4a750);
    assert_eq!(tables::AES_RCON, [1, 2, 4, 8, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36]);
}

#[test]
fn md5_table_matches_sine_formula() {
    for i in 0..64 {
        let expected = ((1u64 << 32) as f64 * ((i + 1) as f64).sin().abs()) as u32;
        assert_eq!(tables::MD5_T[i], expected, "T[{}]", i + 1);
    }
}

#[test]
fn nibble_sboxes_are_permutations() {
    for sbox in tables::SERPENT_SBOXES.iter() {
        let mut sorted = *sbox;
        sorted.sort();
        assert_eq!(sorted, (0u8..16).collect::<Vec<_>>()[..]);
    }
    for sbox in tables::DES_SBOXES.iter() {
        for row in 0..4 {
            let mut sorted: Vec<u8> = sbox[row * 16..(row + 1) * 16].to_vec();
            sorted.sort();
            assert_eq!(sorted, (0u8..16).collect::<Vec<_>>()[..]);
        }
    }
    let mut q0 = tables::TWOFISH_Q0;
    q0.sort();
    assert_eq!(q0[..], (0u8..=255).collect::<Vec<u8>>()[..]);
    let mut q1 = tables::TWOFISH_Q1;
    q1.sort();
    assert_eq!(q1[..], (0u8..=255).collect::<Vec<u8>>()[..]);
    // Camellia SBOX1 is likewise a permutation.
    let mut c = tables::CAMELLIA_SBOX1;
    c.sort();
    assert_eq!(c[..], (0u8..=255).collect::<Vec<u8>>()[..]);
}

// ---------------------------------------------------------------------------
// crypto_constants detection

#[test]
fn detects_aes_sbox_at_known_offset() {
    let mut buf = prng_buffer(2048, 0x1111);
    buf[100..356].copy_from_slice(&tables::AES_SBOX);
    let report = findings(&buf, "{}");
    assert_eq!(report["schema_version"], 1);
    assert!(has_finding(&report, "aes", "sbox", 100, "none"));
    let f = report["findings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["constant_name"] == "sbox")
        .unwrap();
    assert_eq!(f["confidence"], "high");
    assert_eq!(f["size"], 256);
    assert_eq!(f["kind"], "sbox");
}

#[test]
fn detects_aes_ttables_both_endiannesses() {
    let mut buf = vec![0u8; 4096];
    for (i, w) in tables::AES_TE0.iter().enumerate() {
        buf[256 + i * 4..256 + i * 4 + 4].copy_from_slice(&w.to_le_bytes());
    }
    for (i, w) in tables::AES_TD2.iter().enumerate() {
        buf[2048 + i * 4..2048 + i * 4 + 4].copy_from_slice(&w.to_be_bytes());
    }
    let report = findings(&buf, "{}");
    assert!(has_finding(&report, "aes", "te0", 256, "little"));
    assert!(has_finding(&report, "aes", "td2", 2048, "big"));
}

#[test]
fn detects_sha_ivs_both_endiannesses() {
    let mut buf = vec![0u8; 512];
    for (i, w) in tables::SHA256_IV.iter().enumerate() {
        buf[64 + i * 4..68 + i * 4].copy_from_slice(&w.to_le_bytes());
    }
    for (i, w) in tables::SHA256_IV.iter().enumerate() {
        buf[256 + i * 4..260 + i * 4].copy_from_slice(&w.to_be_bytes());
    }
    for (i, w) in tables::SHA1_IV.iter().enumerate() {
        buf[400 + i * 4..404 + i * 4].copy_from_slice(&w.to_be_bytes());
    }
    let report = findings(&buf, "{}");
    assert!(has_finding(&report, "sha256", "iv", 64, "little"));
    assert!(has_finding(&report, "sha256", "iv", 256, "big"));
    assert!(has_finding(&report, "sha1", "iv", 400, "big"));
}

#[test]
fn detects_sha512_md5_and_stream_constants() {
    let mut buf = vec![0u8; 1024];
    for (i, w) in tables::SHA512_IV.iter().enumerate() {
        buf[32 + i * 8..40 + i * 8].copy_from_slice(&w.to_be_bytes());
    }
    for (i, w) in tables::MD5_T.iter().enumerate() {
        buf[200 + i * 4..204 + i * 4].copy_from_slice(&w.to_le_bytes());
    }
    buf[600..616].copy_from_slice(tables::SIGMA);
    buf[700..716].copy_from_slice(tables::TAU);
    let report = findings(&buf, "{}");
    assert!(has_finding(&report, "sha512", "iv", 32, "big"));
    assert!(has_finding(&report, "md5", "t-table", 200, "little"));
    assert!(has_finding(&report, "chacha20/salsa20", "sigma-expand-32-byte-k", 600, "none"));
    assert!(has_finding(&report, "chacha20/salsa20", "tau-expand-16-byte-k", 700, "none"));
}

#[test]
fn detects_block_cipher_tables() {
    let mut buf = vec![0u8; 8192];
    buf[64..320].copy_from_slice(&tables::CAMELLIA_SBOX1);
    for (i, w) in tables::CAMELLIA_SIGMA.iter().enumerate() {
        buf[512 + i * 8..520 + i * 8].copy_from_slice(&w.to_be_bytes());
    }
    buf[1024..1040].copy_from_slice(&tables::SERPENT_SBOXES[2]);
    buf[1536..1792].copy_from_slice(&tables::TWOFISH_Q1);
    for (i, w) in tables::BLOWFISH_P.iter().enumerate() {
        buf[2048 + i * 4..2052 + i * 4].copy_from_slice(&w.to_be_bytes());
    }
    buf[3072..3136].copy_from_slice(&tables::DES_SBOXES[4]);
    let report = findings(&buf, "{}");
    assert!(has_finding(&report, "camellia", "sbox1", 64, "none"));
    assert!(has_finding(&report, "camellia", "sigma", 512, "big"));
    assert!(has_finding(&report, "serpent", "sbox2", 1024, "none"));
    assert!(has_finding(&report, "twofish", "q1", 1536, "none"));
    assert!(has_finding(&report, "blowfish", "p-array", 2048, "big"));
    assert!(has_finding(&report, "des", "sbox5", 3072, "none"));
}

#[test]
fn detects_oids_templates_and_strings() {
    let mut buf = vec![0u8; 2048];
    buf[64..75].copy_from_slice(&[
        0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    ]); // rsaEncryption
    buf[128..138].copy_from_slice(&[0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]); // prime256v1
    buf[256..261].copy_from_slice(&[0x06, 0x03, 0x2b, 0x65, 0x70]); // ed25519
    buf[400..424].copy_from_slice(&[
        0x30, 0x82, 0x01, 0x22, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01,
        0x01, 0x01, 0x05, 0x00, 0x03, 0x82, 0x01, 0x0f, 0x00,
    ]); // spki-rsa-2048
    buf[600..604].copy_from_slice(b"$2b$");
    buf[700..710].copy_from_slice(b"$argon2id$");
    buf[800..831].copy_from_slice(b"-----BEGIN RSA PRIVATE KEY-----");
    buf[900..910].copy_from_slice(b"eyJhbGciOi");
    let report = findings(&buf, "{}");
    assert!(has_finding(&report, "rsa", "rsaEncryption", 64, "none"));
    assert!(has_finding(&report, "ecc-curve", "prime256v1", 128, "none"));
    assert!(has_finding(&report, "ecc-curve", "ed25519", 256, "none"));
    assert!(has_finding(&report, "rsa", "spki-rsa-2048", 400, "none"));
    // The SPKI template embeds the rsaEncryption OID at offset 406.
    assert!(has_finding(&report, "rsa", "rsaEncryption", 406, "none"));
    assert!(has_finding(&report, "bcrypt", "bcrypt-$2b$", 600, "none"));
    assert!(has_finding(&report, "argon2", "argon2id", 700, "none"));
    assert!(has_finding(&report, "rsa", "pem-rsa-private-key", 800, "none"));
    assert!(has_finding(&report, "jwt", "jwt-header-alg", 900, "none"));
}

#[test]
fn scan_filters_and_caps() {
    let mut buf = vec![0u8; 512];
    buf[16..272].copy_from_slice(&tables::AES_SBOX);
    buf[300..304].copy_from_slice(b"$2b$");
    let high = findings(&buf, r#"{"minConfidence":"high"}"#);
    assert!(high["findings"].as_array().unwrap().iter().all(|f| f["confidence"] == "high"));
    assert!(!high["findings"].as_array().unwrap().iter().any(|f| f["algorithm"] == "bcrypt"));

    let filtered = findings(&buf, r#"{"algorithms":["bcrypt"]}"#);
    assert_eq!(filtered["findings"].as_array().unwrap().len(), 1);
    assert_eq!(filtered["findings"][0]["algorithm"], "bcrypt");

    // Two identical S-box copies -> maxFindings 1 truncates.
    let mut big = vec![0u8; 1024];
    big[0..256].copy_from_slice(&tables::AES_SBOX);
    big[512..768].copy_from_slice(&tables::AES_SBOX);
    let capped = findings(&big, r#"{"maxFindings":1}"#);
    assert_eq!(capped["findings"].as_array().unwrap().len(), 1);
    assert_eq!(capped["truncated"], true);

    let bad = findings(&buf, r#"{"minConfidence":"extreme"}"#);
    assert_eq!(bad["error"], "options_invalid");
}

#[test]
fn scan_empty_and_clean_inputs() {
    let empty = findings(&[], "{}");
    assert_eq!(empty["findings"].as_array().unwrap().len(), 0);
    assert_eq!(empty["truncated"], false);
    // Zero-filled input contains no table.
    let zeros = findings(&vec![0u8; 4096], "{}");
    assert_eq!(zeros["findings"].as_array().unwrap().len(), 0);
}

// ---------------------------------------------------------------------------
// entropy_map

#[test]
fn entropy_zeros_is_zero() {
    let report = parse(entropy_map(&vec![0u8; 8192], "{}"));
    assert_eq!(report["overall"]["entropy"], 0.0);
    assert_eq!(report["overall"]["classification"], "padding-or-sparse");
    assert_eq!(report["overall"]["null"], 1.0);
    assert_eq!(report["regions"].as_array().unwrap().len(), 2);
    assert_eq!(report["regions"][0]["entropy"], 0.0);
    assert_eq!(report["lowest_entropy_region"]["entropy"], 0.0);
    assert_eq!(report["highest_entropy_region"]["offset"], 0);
}

#[test]
fn entropy_prng_is_high() {
    let report = parse(entropy_map(&prng_buffer(8192, 0x9e3779b9), "{}"));
    let e = report["overall"]["entropy"].as_f64().unwrap();
    assert!(e > 7.0, "entropy {e}");
    assert_eq!(report["overall"]["classification"], "encrypted/compressed/packed");
}

#[test]
fn entropy_english_text_is_midrange() {
    let text = b"The quick brown fox jumps over the lazy dog. \
        Pack my box with five dozen liquor jugs. \
        How vexingly quick daft zebras jump! ";
    let mut buf = Vec::new();
    while buf.len() < 8192 {
        buf.extend_from_slice(text);
    }
    buf.truncate(8192);
    let report = parse(entropy_map(&buf, "{}"));
    let e = report["overall"]["entropy"].as_f64().unwrap();
    assert!((3.5..6.0).contains(&e), "text entropy {e}");
    let ascii = report["overall"]["ascii"].as_f64().unwrap();
    assert!(ascii > 0.9);
}

#[test]
fn entropy_windows_stride_and_caps() {
    let buf = prng_buffer(70_000, 7);
    let report = parse(entropy_map(&buf, r#"{"windowSize":16,"stride":16}"#));
    assert_eq!(report["regions"].as_array().unwrap().len(), 4096);
    assert_eq!(report["truncated"], true);
    assert!(report["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|w| w == "regions_limit_reached"));

    let report = parse(entropy_map(&[0u8; 100], r#"{"windowSize":64,"stride":32}"#));
    // offsets 0, 32, 64, 96 -> 4 regions
    assert_eq!(report["regions"].as_array().unwrap().len(), 4);
    assert_eq!(report["regions"][1]["offset"], 32);
    assert_eq!(report["regions"][3]["size"], 4); // tail region 96..100
}

#[test]
fn entropy_empty_input() {
    let report = parse(entropy_map(&[], "{}"));
    assert_eq!(report["regions"].as_array().unwrap().len(), 0);
    assert_eq!(report["overall"]["classification"], "empty");
    assert!(report["highest_entropy_region"].is_null());
}

// ---------------------------------------------------------------------------
// xor_probe

#[test]
fn xor_recovers_single_byte_key_over_mz() {
    let plain = b"MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff\x00\x00This program cannot be run in DOS mode.\r\r$\x00\x00\x00\x00\x00\x00\x00";
    let key = 0x42u8;
    let encoded: Vec<u8> = plain.iter().map(|b| b ^ key).collect();
    // Put the encoded payload at offset 0 for prefix-magic scoring.
    let mut payload = prng_buffer(2048, 0xbeef);
    payload[..encoded.len()].copy_from_slice(&encoded);
    let report = parse(xor_probe(&payload, "{}"));
    let top = &report["candidates"][0];
    assert_eq!(top["key"], "42");
    assert_eq!(top["length"], 1);
    assert!(top["magic_hits"]
        .as_array()
        .unwrap()
        .iter()
        .any(|h| h == "mz"));
    assert!(top["magic_hits"]
        .as_array()
        .unwrap()
        .iter()
        .any(|h| h == "dos-stub"));
    assert!(top["preview_hex"].as_str().unwrap().starts_with("4d5a"));
    assert_eq!(top["method"], "exhaustive");
}

#[test]
fn xor_recovers_multi_byte_key() {
    let text = b"GET /index.html HTTP/1.1\r\nHost: example.com\r\nUser-Agent: test\r\n\r\n";
    let key = b"\xde\xad\xbe\xef";
    let encoded: Vec<u8> = text
        .iter()
        .enumerate()
        .map(|(i, b)| b ^ key[i % key.len()])
        .collect();

    // Known-plaintext crib: "Host: " at offset 24 fixes every key residue.
    let report = parse(xor_probe(
        &encoded,
        r#"{"maxKeyLength":4,"crib":"Host: ","topK":8}"#,
    ));
    let candidates = report["candidates"].as_array().unwrap();
    assert!(candidates
        .iter()
        .any(|c| c["key"] == "deadbeef" && c["length"] == 4 && c["method"] == "crib"));

    // Heuristic per-residue recovery still surfaces a high-printable decode.
    let heuristic = parse(xor_probe(&encoded, r#"{"maxKeyLength":4,"topK":8}"#));
    assert!(heuristic["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["method"] == "recovered" && c["printable_ratio"].as_f64().unwrap() > 0.8));
}

#[test]
fn xor_provided_keys_and_filters() {
    let plain = b"%PDF-1.4 fake document body";
    let encoded: Vec<u8> = plain.iter().map(|b| b ^ 0x77).collect();
    let report = parse(xor_probe(&encoded, r#"{"keys":["0x77","dead"],"topK":8}"#));
    let candidates = report["candidates"].as_array().unwrap();
    let provided = candidates
        .iter()
        .find(|c| c["method"] == "provided" && c["key"] == "77")
        .expect("provided key evaluated");
    assert!(provided["magic_hits"].as_array().unwrap().iter().any(|h| h == "pdf"));

    let high_bar = parse(xor_probe(&encoded, r#"{"keys":["77"],"minScore":99}"#));
    assert_eq!(high_bar["candidates"].as_array().unwrap().len(), 0);

    let bad = parse(xor_probe(&encoded, r#"{"keys":["zz"]}"#));
    assert_eq!(bad["error"], "options_invalid");
}

#[test]
fn xor_scan_bytes_and_empty() {
    let report = parse(xor_probe(&[], "{}"));
    assert_eq!(report["scanned_bytes"], 0);
    assert_eq!(report["candidates"].as_array().unwrap().len(), 0);

    let small = parse(xor_probe(&prng_buffer(1024, 5), r#"{"scanBytes":256}"#));
    assert_eq!(small["scanned_bytes"], 256);
}

// ---------------------------------------------------------------------------
// byte_stats

#[test]
fn byte_stats_zeros() {
    let report = parse(byte_stats(&vec![0u8; 1000], "{}"));
    assert_eq!(report["length"], 1000);
    assert_eq!(report["entropy"], 0.0);
    assert_eq!(report["null_ratio"], 1.0);
    assert_eq!(report["unique_bytes"], 1);
    assert_eq!(report["top_bytes"][0]["byte"], 0);
    assert_eq!(report["top_bytes"][0]["count"], 1000);
    assert_eq!(report["longest_run"]["byte"], 0);
    assert_eq!(report["longest_run"]["offset"], 0);
    assert_eq!(report["longest_run"]["length"], 1000);
    assert_eq!(report["strings"]["ascii_count"], 0);
    assert_eq!(report["strings"]["utf16le_count"], 0);
}

#[test]
fn byte_stats_text_and_lines() {
    let text = b"hello world\r\nsecond line\nthird\rmore";
    let report = parse(byte_stats(text, "{}"));
    assert_eq!(report["length"], text.len());
    assert_eq!(report["line_endings"]["crlf"], 1);
    assert_eq!(report["line_endings"]["lf"], 1);
    assert_eq!(report["line_endings"]["cr_only"], 1);
    assert!(report["ascii_printable_ratio"].as_f64().unwrap() > 0.9);
    // "hello world" and friends are >=4 printable runs
    assert!(report["strings"]["ascii_count"].as_u64().unwrap() >= 4);
    assert_eq!(report["longest_run"]["length"], 2); // "ll" in "hello"
}

#[test]
fn byte_stats_utf16le_strings() {
    // "Hello" in UTF-16LE followed by a binary blob
    let mut buf = Vec::new();
    for c in b"Hello" {
        buf.push(*c);
        buf.push(0);
    }
    buf.extend_from_slice(&[1u8, 2, 3]);
    let report = parse(byte_stats(&buf, "{}"));
    assert_eq!(report["strings"]["utf16le_count"], 1);
    assert_eq!(report["strings"]["ascii_count"], 0); // NULs break ASCII runs
}

#[test]
fn byte_stats_prng_and_empty() {
    let report = parse(byte_stats(&prng_buffer(4096, 42), "{}"));
    assert!(report["entropy"].as_f64().unwrap() > 7.0);
    assert_eq!(report["unique_bytes"], 256);
    assert!(report["null_ratio"].as_f64().unwrap() < 0.05);

    let empty = parse(byte_stats(&[], "{}"));
    assert_eq!(empty["length"], 0);
    assert_eq!(empty["entropy"], 0.0);
    assert!(empty["longest_run"].is_null());
}

// ---------------------------------------------------------------------------
// Shared bound enforcement on every op

#[test]
fn bounds_enforced_on_all_ops() {
    let oversized = vec![0u8; 32 * 1024 * 1024 + 1];
    for result in [
        crypto_constants(&oversized, "{}"),
        entropy_map(&oversized, "{}"),
        xor_probe(&oversized, "{}"),
        byte_stats(&oversized, "{}"),
    ] {
        assert_eq!(parse(result)["error"], "input_too_large");
    }
    // Exactly at the limit is accepted.
    let at_limit = vec![0u8; 32 * 1024 * 1024];
    assert!(parse(byte_stats(&at_limit, "{}"))["error"].is_null());

    let big_options = "x".repeat(4 * 1024 + 1);
    for result in [
        crypto_constants(b"abc", &big_options),
        entropy_map(b"abc", &big_options),
        xor_probe(b"abc", &big_options),
        byte_stats(b"abc", &big_options),
    ] {
        assert_eq!(parse(result)["error"], "options_too_large");
    }
    // Exactly at the options limit is not an options_too_large error (it is a
    // JSON parse error instead, which still surfaces as a JSON error doc).
    let at_limit_options = " ".repeat(4 * 1024);
    let r = parse(byte_stats(b"abc", &at_limit_options));
    assert!(r["error"].is_null() || r["error"] == "options_invalid");

    for result in [
        crypto_constants(b"abc", "{invalid"),
        entropy_map(b"abc", "{invalid"),
        xor_probe(b"abc", "{invalid"),
        byte_stats(b"abc", "{invalid"),
    ] {
        assert_eq!(parse(result)["error"], "options_invalid");
    }
}

#[test]
fn deterministic_outputs() {
    let buf = prng_buffer(4096, 0xabcdef);
    for op in [
        crypto_constants as fn(&[u8], &str) -> String,
        entropy_map,
        xor_probe,
        byte_stats,
    ] {
        assert_eq!(op(&buf, "{}"), op(&buf, "{}"));
    }
}
