//! Compression/encoding identification by magic bytes and charset sniffing.
//! Read-only: detection never decodes or decompresses.

use serde_json::{json, Value};

/// One detection hypothesis.
fn candidate(
    kind: &'static str,
    name: &'static str,
    confidence: &'static str,
    detail: impl Into<String>,
) -> Value {
    json!({
        "kind": kind,
        "name": name,
        "confidence": confidence,
        "detail": detail.into(),
    })
}

pub(crate) fn detect(bytes: &[u8]) -> Value {
    let mut candidates: Vec<Value> = Vec::new();
    compression_candidates(bytes, &mut candidates);
    encoding_candidates(bytes, &mut candidates);

    let primary = candidates
        .iter()
        .find(|entry| entry["confidence"] == "high")
        .or_else(|| candidates.first())
        .map(|entry| entry["name"].clone())
        .unwrap_or(Value::Null);

    json!({
        "schema_version": 1,
        "inputBytes": bytes.len(),
        "primary": primary,
        "candidates": candidates,
        "note": "raw deflate, lzma2 raw streams and brotli carry no reliable magic bytes; detection is heuristic and read-only",
    })
}

fn compression_candidates(bytes: &[u8], out: &mut Vec<Value>) {
    let b = bytes;
    let get = |index: usize| b.get(index).copied();

    // gzip: 1f 8b, method byte 0x08 = deflate.
    if get(0) == Some(0x1f) && get(1) == Some(0x8b) {
        if get(2) == Some(0x08) {
            out.push(candidate("compression", "gzip", "high", "magic 1f8b, method deflate"));
        } else {
            out.push(candidate(
                "compression",
                "gzip",
                "medium",
                format!("magic 1f8b, unusual method byte {:?}", get(2)),
            ));
        }
    }

    // zlib: CMF low nibble 8, CINFO <= 7, FCHECK makes (CMF<<8|FLG) % 31 == 0.
    if let (Some(cmf), Some(flg)) = (get(0), get(1)) {
        let checksum_ok = ((cmf as u16) * 256 + flg as u16) % 31 == 0;
        if cmf & 0x0f == 8 && cmf >> 4 <= 7 && checksum_ok {
            out.push(candidate(
                "compression",
                "zlib",
                "high",
                format!("zlib header {cmf:02x} {flg:02x}, FCHECK valid"),
            ));
        } else if cmf & 0x0f == 8 && checksum_ok {
            out.push(candidate(
                "compression",
                "zlib",
                "medium",
                format!("header {cmf:02x} {flg:02x} checksum-valid but CINFO > 32K window"),
            ));
        }
    }

    // xz: fd 37 7a 58 5a 00
    if b.starts_with(b"\xfd7zXZ\x00") {
        out.push(candidate("compression", "xz", "high", "magic fd377a585a00"));
    }

    // zstd frame: 28 b5 2f fd; skippable frames 50..=5f 2a 4d 18.
    if b.starts_with(&[0x28, 0xb5, 0x2f, 0xfd]) {
        out.push(candidate("compression", "zstd", "high", "magic 28b52ffd"));
    } else if let (Some(first), Some(0x2a), Some(0x4d), Some(0x18)) =
        (get(0), get(1), get(2), get(3))
    {
        if (0x50..=0x5f).contains(&first) {
            out.push(candidate(
                "compression",
                "zstd",
                "medium",
                "zstd skippable frame",
            ));
        }
    }

    // lz4 frame: 04 22 4d 18
    if b.starts_with(&[0x04, 0x22, 0x4d, 0x18]) {
        out.push(candidate("compression", "lz4", "high", "magic 04224d18"));
    }

    // bzip2: 'B' 'Z' 'h' '1'..'9'
    if b.starts_with(b"BZh") {
        if let Some(digit @ b'1'..=b'9') = get(3) {
            out.push(candidate(
                "compression",
                "bzip2",
                "high",
                format!("magic BZh, block size {}00k", digit - b'0'),
            ));
        }
    }

    // LZMA-Alone (.lzma): properties byte <= 224, dictionary u32 sane,
    // 8-byte uncompressed size field.
    if b.len() >= 13 {
        let props = b[0] as u32;
        let dict = u32::from_le_bytes([b[1], b[2], b[3], b[4]]);
        let lc_lp_pb_ok = props < 9 * 5 * 5; // lc<=8, lp<=4, pb<=4 ⇒ props < 225
        let dict_ok = dict >= 4096 && dict.is_power_of_two() || dict == 0;
        let size = u64::from_le_bytes([b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12]]);
        let size_ok = size == u64::MAX || size > 0;
        if lc_lp_pb_ok && dict_ok && size_ok && props == 0x5d {
            out.push(candidate(
                "compression",
                "lzma",
                "medium",
                format!("lzma-alone header: props 0x{props:02x}, dict {dict}, declared size {size}"),
            ));
        }
    }
}

/// Charset table membership over the (whitespace-stripped) input.
fn charset_stats<'a>(bytes: &[u8], alphabet: &'a [bool; 256]) -> (usize, usize) {
    let mut kept = 0usize;
    let mut bad = 0usize;
    for &byte in bytes {
        if byte.is_ascii_whitespace() {
            continue;
        }
        if alphabet[byte as usize] {
            kept += 1;
        } else {
            bad += 1;
        }
    }
    (kept, bad)
}

fn alphabet(chars: &str) -> [bool; 256] {
    let mut table = [false; 256];
    for &byte in chars.as_bytes() {
        table[byte as usize] = true;
    }
    table
}

fn encoding_candidates(bytes: &[u8], out: &mut Vec<Value>) {
    if bytes.is_empty() {
        return;
    }
    // Only sniff text-shaped input: every byte must be printable or whitespace.
    let texty = bytes
        .iter()
        .all(|byte| byte.is_ascii_graphic() || byte.is_ascii_whitespace());
    if !texty {
        return;
    }
    let stripped: Vec<u8> = bytes
        .iter()
        .copied()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect();
    if stripped.is_empty() {
        return;
    }

    // uudecode is unambiguous when the begin line is present.
    if bytes
        .split(|byte| *byte == b'\n')
        .any(|line| line.starts_with(b"begin "))
    {
        out.push(candidate(
            "encoding",
            "uuencode",
            "high",
            "uuencode begin line present",
        ));
    }

    // quoted-printable: =XX escapes or soft breaks are distinctive.
    let escapes = stripped
        .windows(3)
        .filter(|w| w[0] == b'=' && w[1].is_ascii_hexdigit() && w[2].is_ascii_hexdigit())
        .count();
    if escapes > 0 {
        out.push(candidate(
            "encoding",
            "quoted-printable",
            "medium",
            format!("{escapes} =XX escape(s) present"),
        ));
    }

    let base64_tab = alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=");
    let base64url_tab = alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_=");
    let base32_tab = alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567=");
    let hex_tab = alphabet("0123456789abcdefABCDEF");
    let z85_tab = alphabet(
        "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#",
    );
    let base58_tab =
        alphabet("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz");

    let (b64_kept, b64_bad) = charset_stats(bytes, &base64_tab);
    if b64_bad == 0 && stripped.len() >= 4 && stripped.len() % 4 == 0 {
        out.push(candidate(
            "encoding",
            "base64",
            "medium",
            "charset-compatible with base64, length multiple of 4",
        ));
    }
    let (_kept, url_bad) = charset_stats(bytes, &base64url_tab);
    if url_bad == 0
        && stripped.len() >= 4
        && (stripped.contains(&b'-') || stripped.contains(&b'_'))
    {
        out.push(candidate(
            "encoding",
            "base64url",
            "medium",
            "charset-compatible with base64url",
        ));
    }
    let (_b32, b32_bad) = charset_stats(bytes, &base32_tab);
    if b32_bad == 0 && stripped.len() >= 8 {
        out.push(candidate(
            "encoding",
            "base32",
            "low",
            "charset-compatible with base32",
        ));
    }
    let (_z, z_bad) = charset_stats(bytes, &z85_tab);
    if z_bad == 0 && stripped.len() >= 5 && stripped.len() % 5 == 0 {
        out.push(candidate(
            "encoding",
            "z85",
            "low",
            "charset-compatible with z85, length multiple of 5",
        ));
    }
    let (_b58, b58_bad) = charset_stats(bytes, &base58_tab);
    if b58_bad == 0 && stripped.len() >= 8 {
        out.push(candidate(
            "encoding",
            "base58",
            "low",
            "charset-compatible with base58",
        ));
    }
    let (_h, hex_bad) = charset_stats(bytes, &hex_tab);
    // Even length, 6+ hex characters. Short strings are noisy, so confidence
    // stays low; anything shorter is not flagged at all.
    if hex_bad == 0 && stripped.len() >= 6 && stripped.len() % 2 == 0 {
        out.push(candidate(
            "encoding",
            "hex",
            "low",
            "charset-compatible with hex",
        ));
    }
    let _ = b64_kept;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(bytes: &[u8]) -> Vec<String> {
        detect(bytes)["candidates"]
            .as_array()
            .map(|list| {
                list.iter()
                    .filter_map(|entry| entry["name"].as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn magic_detection() {
        let cases: &[(&[u8], &str)] = &[
            (&[0x1f, 0x8b, 0x08, 0x00, 0x00], "gzip"),
            (&[0x78, 0x9c, 0x00, 0x11], "zlib"),
            (b"\xfd7zXZ\x00\x00", "xz"),
            (&[0x28, 0xb5, 0x2f, 0xfd, 0x20], "zstd"),
            (&[0x04, 0x22, 0x4d, 0x18, 0x64], "lz4"),
            (b"BZh91AY&SY", "bzip2"),
            (&[0x5d, 0x00, 0x00, 0x80, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00], "lzma"),
        ];
        for (bytes, want) in cases {
            assert!(names(bytes).contains(&want.to_string()), "{want} in {bytes:02x?}");
        }
    }

    #[test]
    fn zlib_header_checksum_is_validated() {
        // 78 9c passes FCHECK; 78 9d does not.
        assert!(names(&[0x78, 0x9c, 0x00]).contains(&"zlib".to_string()));
        assert!(!names(&[0x78, 0x9d, 0x00]).contains(&"zlib".to_string()));
    }

    #[test]
    fn encoding_sniffing() {
        assert!(names(b"TWFu").contains(&"base64".to_string()));
        assert!(names(b"4869ab").contains(&"hex".to_string()));
        assert!(names(b"begin 644 x\n#0V%T\n`\nend\n").contains(&"uuencode".to_string()));
        assert!(names(b"a=3Db").contains(&"quoted-printable".to_string()));
    }

    #[test]
    fn binary_input_has_no_encoding_candidates() {
        let bytes = &[0x00, 0x01, 0x02, 0xff];
        let report = detect(bytes);
        let enc = report["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| entry["kind"] == "encoding")
            .count();
        assert_eq!(enc, 0);
    }

    #[test]
    fn empty_and_unknown_inputs() {
        let report = detect(b"");
        assert_eq!(report["primary"], Value::Null);
        let report = detect(&[0xde, 0xad, 0xbe, 0xef, 0x00]);
        assert!(report["candidates"].is_array());
    }

    #[test]
    fn determinism() {
        let bytes = b"TWFu";
        assert_eq!(detect(bytes), detect(bytes));
    }
}
