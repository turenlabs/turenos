//! Text encodings. hex, z85, quoted-printable, and uuencode are implemented
//! locally so the shipped closure stays small; base64/base32 family uses
//! `data-encoding`; base58 uses `bs58` (with Base58Check support).

use serde_json::json;

use crate::{err_with, Options, MAX_TRANSFORM_BYTES};

pub(crate) fn encode(
    encoding: &str,
    bytes: &[u8],
    options: &Options,
) -> Result<Vec<u8>, String> {
    let name = normalize(encoding);
    if !matches!(
        name.as_str(),
        "hex"
            | "base64"
            | "base64url"
            | "base32"
            | "base32hex"
            | "base58"
            | "base58check"
            | "z85"
            | "quoted-printable"
            | "uuencode"
    ) {
        return Err(err_with(
            "unknown_encoding",
            json!({ "encoding": encoding }),
        ));
    }
    // Reject before allocating when even the best case cannot fit.
    if encoded_upper_bound(&name, bytes.len()) > options.max_output_bytes {
        return Err(err_with(
            "output_too_large",
            json!({ "limit": options.max_output_bytes }),
        ));
    }
    match name.as_str() {
        "hex" => Ok(data_encoding::HEXLOWER.encode(bytes).into_bytes()),
        "base64" => Ok(data_encoding::BASE64.encode(bytes).into_bytes()),
        "base64url" => Ok(data_encoding::BASE64URL.encode(bytes).into_bytes()),
        "base32" => Ok(data_encoding::BASE32.encode(bytes).into_bytes()),
        "base32hex" => Ok(data_encoding::BASE32HEX.encode(bytes).into_bytes()),
        "base58" => Ok(bs58::encode(bytes).into_string().into_bytes()),
        "base58check" => Ok(bs58::encode(bytes).with_check().into_string().into_bytes()),
        "z85" => z85_encode(bytes),
        "quoted-printable" => Ok(qp_encode(bytes)),
        "uuencode" => Ok(uu_encode(bytes)),
        _ => Err(err_with(
            "unknown_encoding",
            json!({ "encoding": encoding }),
        )),
    }
}

pub(crate) fn decode(
    encoding: &str,
    bytes: &[u8],
    options: &Options,
) -> Result<Vec<u8>, String> {
    let name = normalize(encoding);
    let stripped: Vec<u8>;
    let input = match name.as_str() {
        // Whitespace is never meaningful inside these payloads.
        "hex" | "base64" | "base64url" | "base32" | "base32hex" | "base58" | "base58check"
        | "z85" => {
            stripped = bytes
                .iter()
                .copied()
                .filter(|byte| !byte.is_ascii_whitespace())
                .collect();
            stripped.as_slice()
        }
        _ => bytes,
    };
    // Reject before allocating when even the decoded upper bound cannot fit.
    if decoded_upper_bound(&name, input.len()) > options.max_output_bytes {
        return Err(err_with(
            "output_too_large",
            json!({ "limit": options.max_output_bytes }),
        ));
    }
    let decoded = match name.as_str() {
        "hex" => decode_hex(input),
        "base64" => decode_padded(input, 4, data_encoding::BASE64),
        "base64url" => decode_padded(input, 4, data_encoding::BASE64URL),
        "base32" => decode_base32(input, data_encoding::BASE32),
        "base32hex" => decode_base32(input, data_encoding::BASE32HEX),
        "base58" => bs58::decode(input)
            .into_vec()
            .map_err(|error| codec_failure("decode_failed", error.to_string())),
        "base58check" => bs58::decode(input)
            .with_check(None)
            .into_vec()
            .map_err(|error| codec_failure("decode_failed", error.to_string())),
        "z85" => z85_decode(input),
        "quoted-printable" => qp_decode(input),
        "uuencode" => uu_decode(bytes, options),
        _ => Err(err_with(
            "unknown_encoding",
            json!({ "encoding": encoding }),
        )),
    }?;
    if decoded.len() > options.max_output_bytes {
        return Err(err_with(
            "output_too_large",
            json!({ "limit": options.max_output_bytes }),
        ));
    }
    Ok(decoded)
}

fn normalize(name: &str) -> String {
    match name.trim().to_ascii_lowercase().as_str() {
        "hex" | "base16" | "hexlower" => "hex",
        "base64" | "b64" => "base64",
        "base64url" | "b64url" | "base64-url" => "base64url",
        "base32" | "b32" => "base32",
        "base32hex" | "b32hex" => "base32hex",
        "base58" | "b58" | "base58btc" => "base58",
        "base58check" | "b58check" | "base58-check" => "base58check",
        "z85" | "base85" => "z85",
        "quoted-printable" | "quotedprintable" | "qp" => "quoted-printable",
        "uuencode" | "uudecode" | "uu" => "uuencode",
        other => other,
    }
    .to_string()
}

/// Conservative upper bound for an encoder's output; used to reject inputs
/// whose best-case result would exceed the transform cap before allocating.
fn encoded_upper_bound(encoding: &str, input_len: usize) -> usize {
    let n = input_len as u128;
    let bound: u128 = match encoding {
        "hex" => n * 2,
        "base64" | "base64url" => (n + 2) / 3 * 4,
        "base32" | "base32hex" => (n + 4) / 5 * 8,
        "base58" | "base58check" => n * 2 + 8,
        "z85" => (n + 3) / 4 * 5,
        "quoted-printable" => n * 3 + (n / 75 + 2) * 3,
        "uuencode" => (n + 44) / 45 * 62 + 32,
        _ => n * 4 + 64,
    };
    bound.min(MAX_TRANSFORM_BYTES as u128 + 1) as usize
}

/// Conservative upper bound for a decoder's output; used to reject inputs
/// whose best-case result would exceed the transform cap before allocating.
fn decoded_upper_bound(encoding: &str, input_len: usize) -> usize {
    let n = input_len as u128;
    let bound: u128 = match encoding {
        "hex" => n / 2,
        "base64" | "base64url" => (n / 4 + 1) * 3,
        "base32" | "base32hex" => (n / 8 + 1) * 5,
        // base58 inflates by ~0.733x; quoted-printable and uudecode shrink.
        _ => n + 8,
    };
    bound.min(MAX_TRANSFORM_BYTES as u128 + 1) as usize
}

fn codec_failure(code: &'static str, detail: String) -> String {
    err_with(code, json!({ "detail": detail.chars().take(256).collect::<String>() }))
}

fn is_hex_digit(byte: u8) -> bool {
    byte.is_ascii_hexdigit()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Lenient hex decode: ASCII whitespace already stripped, mixed case accepted.
fn decode_hex(input: &[u8]) -> Result<Vec<u8>, String> {
    if input.len() % 2 != 0 {
        return Err(err_with(
            "decode_failed",
            json!({ "detail": "hex input has odd length" }),
        ));
    }
    let mut out = Vec::with_capacity(input.len() / 2);
    for pair in input.chunks(2) {
        let high = hex_value(pair[0]);
        let low = hex_value(pair[1]);
        match (high, low) {
            (Some(high), Some(low)) => out.push((high << 4) | low),
            _ => {
                return Err(err_with(
                    "decode_failed",
                    json!({ "detail": "invalid hex digit" }),
                ))
            }
        }
    }
    Ok(out)
}

/// data-encoding decode that tolerates missing padding.
fn decode_padded(
    input: &[u8],
    quantum: usize,
    spec: data_encoding::Encoding,
) -> Result<Vec<u8>, String> {
    let mut padded = input.to_vec();
    while padded.len() % quantum != 0 {
        padded.push(b'=');
    }
    spec.decode(&padded)
        .map_err(|error| codec_failure("decode_failed", error.to_string()))
}

/// base32 variants are uppercased first; lowercase payloads decode too.
fn decode_base32(input: &[u8], spec: data_encoding::Encoding) -> Result<Vec<u8>, String> {
    let mut padded: Vec<u8> = input
        .iter()
        .map(|byte| byte.to_ascii_uppercase())
        .collect();
    while padded.len() % 8 != 0 {
        padded.push(b'=');
    }
    spec.decode(&padded)
        .map_err(|error| codec_failure("decode_failed", error.to_string()))
}

// ---- Z85 (ZeroMQ RFC 32) -------------------------------------------------

const Z85_ALPHABET: &[u8; 85] =
    b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#";

fn z85_encode(input: &[u8]) -> Result<Vec<u8>, String> {
    if input.len() % 4 != 0 {
        return Err(err_with(
            "invalid_input",
            json!({ "detail": "z85 input length must be a multiple of 4" }),
        ));
    }
    let mut out = Vec::with_capacity(input.len() / 4 * 5);
    for chunk in input.chunks(4) {
        let mut value =
            u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        let mut encoded = [0u8; 5];
        for slot in (0..5).rev() {
            encoded[slot] = Z85_ALPHABET[(value % 85) as usize];
            value /= 85;
        }
        out.extend_from_slice(&encoded);
    }
    Ok(out)
}

fn z85_decode(input: &[u8]) -> Result<Vec<u8>, String> {
    if input.len() % 5 != 0 {
        return Err(err_with(
            "invalid_input",
            json!({ "detail": "z85 input length must be a multiple of 5" }),
        ));
    }
    let mut out = Vec::with_capacity(input.len() / 5 * 4);
    for chunk in input.chunks(5) {
        let mut value = 0u64;
        for &byte in chunk {
            let index = Z85_ALPHABET
                .iter()
                .position(|candidate| *candidate == byte)
                .ok_or_else(|| {
                    err_with(
                        "decode_failed",
                        json!({ "detail": "invalid z85 character" }),
                    )
                })? as u64;
            value = value * 85 + index;
        }
        if value > u32::MAX as u64 {
            return Err(err_with(
                "decode_failed",
                json!({ "detail": "z85 group value out of range" }),
            ));
        }
        out.extend_from_slice(&(value as u32).to_be_bytes());
    }
    Ok(out)
}

// ---- quoted-printable (RFC 2045 section 6.7) ------------------------------

const HEX_UPPER: &[u8; 16] = b"0123456789ABCDEF";
const QP_LINE: usize = 75; // content columns; the soft '=' lands on column 76

fn qp_encode(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len() + input.len() / 25 + 4);
    let mut column = 0usize;
    let mut index = 0usize;
    while index < input.len() {
        let byte = input[index];
        if byte == b'\r' && input.get(index + 1) == Some(&b'\n') {
            // A CRLF pair is the only canonical line break in RFC 2045 data.
            out.extend_from_slice(b"\r\n");
            column = 0;
            index += 2;
            continue;
        }
        // Trailing spaces/tabs before a line break or EOF are escaped so they
        // survive transports that strip them. A space before a lone CR/LF is
        // mid-line in the encoded form because that CR/LF is itself escaped.
        let trailing_ws = (byte == b' ' || byte == b'\t')
            && (index + 1 == input.len()
                || (input.get(index + 1) == Some(&b'\r')
                    && input.get(index + 2) == Some(&b'\n')));
        let (rep, rep_len): ([u8; 3], usize) =
            if byte == b'=' || !(0x20..=0x7e).contains(&byte) || trailing_ws {
                ([b'=', HEX_UPPER[(byte >> 4) as usize], HEX_UPPER[(byte & 15) as usize]], 3)
            } else {
                ([byte, 0, 0], 1)
            };
        if column + rep_len > QP_LINE {
            out.extend_from_slice(b"=\r\n");
            column = 0;
        }
        out.extend_from_slice(&rep[..rep_len]);
        column += rep_len;
        index += 1;
    }
    out
}

fn qp_decode(input: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(input.len());
    let mut index = 0usize;
    while index < input.len() {
        let byte = input[index];
        if byte != b'=' {
            out.push(byte);
            index += 1;
            continue;
        }
        match (input.get(index + 1), input.get(index + 2)) {
            (Some(b'\r'), Some(b'\n')) => index += 3, // soft line break
            (Some(b'\n'), _) => index += 2,           // soft line break, bare LF
            (Some(&h1), Some(&h2)) if is_hex_digit(h1) && is_hex_digit(h2) => {
                out.push((hex_value(h1).unwrap_or(0) << 4) | hex_value(h2).unwrap_or(0));
                index += 3;
            }
            _ => {
                // Lenient: a bare '=' stays literal.
                out.push(b'=');
                index += 1;
            }
        }
    }
    Ok(out)
}

// ---- uuencode -------------------------------------------------------------

fn uu_value(byte: u8) -> u8 {
    // Both the classic space padding and the modern backtick are zero.
    byte.wrapping_sub(32) & 63
}

fn uu_encode(input: &[u8]) -> Vec<u8> {
    // The record name is fixed so no untrusted path can enter the payload.
    let mut out = Vec::with_capacity(input.len() + input.len() / 45 * 2 + 32);
    out.extend_from_slice(b"begin 644 -\n");
    for chunk in input.chunks(45) {
        out.push((chunk.len() as u8) + 32);
        for group in chunk.chunks(3) {
            let a = group[0];
            let b = *group.get(1).unwrap_or(&0);
            let c = *group.get(2).unwrap_or(&0);
            out.push(uu_char(a >> 2));
            out.push(uu_char((a << 4) | (b >> 4)));
            out.push(uu_char((b << 2) | (c >> 6)));
            out.push(uu_char(c));
        }
        out.push(b'\n');
    }
    out.extend_from_slice(b"`\nend\n");
    out
}

fn uu_char(value: u8) -> u8 {
    let encoded = value & 63;
    if encoded == 0 {
        b'`'
    } else {
        encoded + 32
    }
}

fn uu_decode(input: &[u8], options: &Options) -> Result<Vec<u8>, String> {
    let mut lines = input.split(|byte| *byte == b'\n');
    let mut found_begin = false;
    for line in lines.by_ref() {
        if line.starts_with(b"begin ") {
            found_begin = true;
            break;
        }
    }
    if !found_begin {
        return Err(err_with(
            "invalid_input",
            json!({ "detail": "uudecode payload has no begin line" }),
        ));
    }
    let mut out = Vec::with_capacity(input.len());
    for line in lines.by_ref() {
        let line = match line.last() {
            Some(b'\r') => &line[..line.len() - 1],
            _ => line,
        };
        if line == b"end" {
            break;
        }
        if line.is_empty() {
            continue;
        }
        let count = uu_value(line[0]) as usize;
        if count == 0 {
            break; // "`" or space line ends the data section
        }
        let body = &line[1..];
        let mut remaining = count;
        for group in body.chunks(4) {
            if remaining == 0 {
                break;
            }
            let v0 = uu_value(*group.first().unwrap_or(&b'`'));
            let v1 = uu_value(*group.get(1).unwrap_or(&b'`'));
            let v2 = uu_value(*group.get(2).unwrap_or(&b'`'));
            let v3 = uu_value(*group.get(3).unwrap_or(&b'`'));
            let triple = [
                (v0 << 2) | (v1 >> 4),
                (v1 << 4) | (v2 >> 2),
                (v2 << 6) | v3,
            ];
            for byte in triple.into_iter().take(remaining.min(3)) {
                out.push(byte);
            }
            remaining = remaining.saturating_sub(3);
            if out.len() > options.max_output_bytes {
                return Err(err_with(
                    "output_too_large",
                    json!({ "limit": options.max_output_bytes }),
                ));
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MAX_INPUT_BYTES;

    fn opts() -> Options {
        Options::default()
    }

    fn expect_error(result: Result<Vec<u8>, String>) -> String {
        let error = result.expect_err("expected error");
        let parsed: serde_json::Value =
            serde_json::from_str(&error.to_string()).expect("error message is JSON");
        parsed["error"].as_str().unwrap_or("").to_string()
    }

    fn round_trip(encoding: &str, data: &[u8]) {
        let options = opts();
        let encoded = encode(encoding, data, &options).expect("encode");
        let decoded = decode(encoding, &encoded, &options).expect("decode");
        assert_eq!(decoded, data, "{encoding} round trip");
    }

    #[test]
    fn round_trip_all_encodings() {
        let data: Vec<u8> = (0..=255u8).collect();
        for encoding in [
            "hex", "base64", "base64url", "base32", "base32hex", "base58", "base58check",
            "quoted-printable", "uuencode",
        ] {
            round_trip(encoding, &data);
        }
        // z85 requires a multiple of 4.
        round_trip("z85", &data[..252]);
        round_trip("z85", &[]);
    }

    #[test]
    fn known_vectors() {
        let options = opts();
        assert_eq!(encode("hex", b"Hi", &options).unwrap(), b"4869");
        assert_eq!(encode("base64", b"Man", &options).unwrap(), b"TWFu");
        assert_eq!(
            encode("base64url", b"\xfb\xff\xfe", &options).unwrap(),
            b"-__-"
        );
        assert_eq!(encode("base32", b"foo", &options).unwrap(), b"MZXW6===");
        assert_eq!(
            encode("base58", b"Hello World!", &options).unwrap(),
            b"2NEpo7TZRRrLZSi2U"
        );
        // Z85 reference vector from RFC 32.
        assert_eq!(
            encode(
                "z85",
                &[0x86, 0x4f, 0xd2, 0x6f, 0xb5, 0x59, 0xf7, 0x5b],
                &options
            )
            .unwrap(),
            b"HelloWorld"
        );
        assert_eq!(
            decode("z85", b"HelloWorld", &options).unwrap(),
            &[0x86, 0x4f, 0xd2, 0x6f, 0xb5, 0x59, 0xf7, 0x5b]
        );
        assert_eq!(decode("hex", b"4869", &options).unwrap(), b"Hi");
        assert_eq!(decode("base64", b"TWFu", &options).unwrap(), b"Man");
    }

    #[test]
    fn lenient_decoders() {
        let options = opts();
        // Whitespace inside payloads is tolerated.
        assert_eq!(decode("base64", b"TW Fu\n", &options).unwrap(), b"Man");
        assert_eq!(decode("hex", b"48 69\n", &options).unwrap(), b"Hi");
        // Missing padding is tolerated.
        assert_eq!(decode("base64", b"TWE", &options).unwrap(), b"Ma");
        assert_eq!(decode("base32", b"mzxw6", &options).unwrap(), b"foo");
    }

    #[test]
    fn strict_failures() {
        let options = opts();
        assert_eq!(
            expect_error(decode("hex", b"123", &options)),
            "decode_failed"
        );
        assert_eq!(
            expect_error(decode("hex", b"zz", &options)),
            "decode_failed"
        );
        assert_eq!(
            expect_error(decode("base64", b"!!!*", &options)),
            "decode_failed"
        );
        assert_eq!(
            expect_error(decode("base58", b"0OIl", &options)),
            "decode_failed"
        );
        assert_eq!(
            expect_error(encode("z85", b"abc", &options)),
            "invalid_input"
        );
        assert_eq!(
            expect_error(decode("z85", b"abcd", &options)),
            "invalid_input"
        );
        assert_eq!(
            expect_error(decode("z85", b"'''''", &options)),
            "decode_failed" // '\'' is outside the Z85 alphabet
        );
        assert_eq!(
            expect_error(decode("uuencode", b"no begin line here", &options)),
            "invalid_input"
        );
        assert_eq!(
            expect_error(encode("rot13", b"x", &options)),
            "unknown_encoding"
        );
    }

    #[test]
    fn quoted_printable_semantics() {
        let options = opts();
        assert_eq!(
            encode("quoted-printable", b"foo bar", &options).unwrap(),
            b"foo bar"
        );
        assert_eq!(
            encode("quoted-printable", b"a=\x00\xffb", &options).unwrap(),
            b"a=3D=00=FFb"
        );
        // A lone LF is not a valid QP line break: it is escaped so arbitrary
        // bytes round-trip exactly. Whitespace before it stays mid-line.
        assert_eq!(
            encode("quoted-printable", b"x \ny ", &options).unwrap(),
            b"x =0Ay=20"
        );
        // A real CRLF pair is the canonical line break and stays literal.
        assert_eq!(
            encode("quoted-printable", b"a\r\nb ", &options).unwrap(),
            b"a\r\nb=20"
        );
        assert_eq!(
            decode("quoted-printable", b"x =0Ay=20", &options).unwrap(),
            b"x \ny "
        );
        assert_eq!(
            decode("quoted-printable", b"a=3D=00=FFb", &options).unwrap(),
            b"a=\x00\xffb"
        );
        // Soft breaks disappear.
        assert_eq!(
            decode("quoted-printable", b"ab=\r\ncd", &options).unwrap(),
            b"abcd"
        );
        // A bare '=' is kept literal (lenient mode for damaged payloads).
        assert_eq!(
            decode("quoted-printable", b"a=b", &options).unwrap(),
            b"a=b"
        );
    }

    #[test]
    fn quoted_printable_line_wrapping() {
        let options = opts();
        let long = vec![b'A'; 200];
        let encoded = encode("quoted-printable", &long, &options).unwrap();
        for line in encoded.split(|b| *b == b'\n') {
            let line = if line.last() == Some(&b'\r') {
                &line[..line.len() - 1]
            } else {
                line
            };
            assert!(line.len() <= 76, "qp line {} > 76", line.len());
        }
        assert_eq!(decode("quoted-printable", &encoded, &options).unwrap(), long);
    }

    #[test]
    fn uudecode_classic_fixture() {
        // `uuencode -` of "The quick brown fox" style payload (BSD format).
        let options = opts();
        let payload = b"begin 644 -\n#0V%T\n`\nend\n";
        assert_eq!(decode("uudecode", payload, &options).unwrap(), b"Cat");
        let payload_space = b"begin 644 data.txt\n#0V%T\n \nend\n";
        assert_eq!(decode("uuencode", payload_space, &options).unwrap(), b"Cat");
        // Prose before the begin line is skipped.
        let mut wrapped = b"junk prose\nmore junk\n".to_vec();
        wrapped.extend_from_slice(payload);
        assert_eq!(decode("uudecode", &wrapped, &options).unwrap(), b"Cat");
    }

    #[test]
    fn uudecode_real_file_roundtrip() {
        let options = opts();
        let data: Vec<u8> = (0..2000u32).map(|i| (i * 7 % 256) as u8).collect();
        let encoded = uu_encode(&data);
        let text = String::from_utf8(encoded.clone()).unwrap();
        assert!(text.starts_with("begin 644 -\n"));
        assert!(text.ends_with("`\nend\n"));
        assert_eq!(uu_decode(&encoded, &options).unwrap(), data);
    }

    #[test]
    fn base58check_roundtrip_and_validation() {
        let options = opts();
        let encoded = encode("base58check", b"payload-bytes", &options).unwrap();
        assert_eq!(
            decode("base58check", &encoded, &options).unwrap(),
            b"payload-bytes"
        );
        // A corrupted checksum must fail.
        let mut corrupt = encoded.clone();
        let last = corrupt.len() - 1;
        corrupt[last] = if corrupt[last] == b'1' { b'2' } else { b'1' };
        assert!(decode("base58check", &corrupt, &options).is_err());
    }

    #[test]
    fn empty_input() {
        let options = opts();
        for encoding in [
            "hex", "base64", "base64url", "base32", "base32hex", "base58", "base58check",
            "z85", "quoted-printable", "uuencode",
        ] {
            let encoded = encode(encoding, b"", &options).unwrap();
            assert_eq!(decode(encoding, &encoded, &options).unwrap(), b"", "{encoding}");
        }
    }

    #[test]
    fn determinism() {
        let options = opts();
        let data = b"deterministic input bytes";
        for encoding in ["hex", "base64", "base32", "base58", "z85", "quoted-printable", "uuencode"] {
            let data4 = if encoding == "z85" { &data[..24] } else { &data[..] };
            assert_eq!(
                encode(encoding, data4, &options).unwrap(),
                encode(encoding, data4, &options).unwrap()
            );
        }
    }

    #[test]
    fn encoded_upper_bound_guard() {
        // Encode output cap is enforced before allocation.
        let options = Options {
            max_output_bytes: 8,
            ..Options::default()
        };
        let data = vec![0u8; 64];
        assert_eq!(expect_error(encode("hex", &data, &options)), "output_too_large");
        let _ = MAX_INPUT_BYTES;
    }
}
