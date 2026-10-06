//! Offline compact JWT inspection and RS256/ES256 verification. No key discovery.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use rsa::{pkcs1v15, traits::PublicKeyParts, BigUint, RsaPublicKey};
use serde::{
    de::{Error, MapAccess, Visitor},
    Deserialize, Deserializer,
};
use serde_json::{json, Map, Value};
use sha2::Sha256;
use std::fmt;
use wasm_bindgen::prelude::*;

const MAX_INPUT: usize = 128 * 1024;
const MAX_OPTIONS: usize = 4 * 1024;
const MAX_KEY: usize = 16 * 1024;
const MAX_HEADER: usize = 8 * 1024;
const MAX_MEMBERS: usize = 256;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    algorithm: String,
    issuer: String,
    audience: String,
    now: u64,
}

// Reject duplicate top-level members instead of silently accepting the last value.
struct Object(Map<String, Value>);
impl<'de> Deserialize<'de> for Object {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ObjectVisitor;
        impl<'de> Visitor<'de> for ObjectVisitor {
            type Value = Object;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a JSON object with unique members")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Object, A::Error> {
                let mut value = Map::new();
                while let Some(key) = map.next_key::<String>()? {
                    if value.len() >= MAX_MEMBERS || value.contains_key(&key) {
                        return Err(A::Error::custom("duplicate member or member limit"));
                    }
                    value.insert(key, map.next_value::<Value>()?);
                }
                Ok(Object(value))
            }
        }
        deserializer.deserialize_map(ObjectVisitor)
    }
}

struct Token<'a> {
    header: Object,
    claims: Object,
    signature: Vec<u8>,
    signed: &'a [u8],
}

#[wasm_bindgen]
pub fn jwt_inspect(bytes: &[u8]) -> String {
    finish(parse(bytes).map(|token| summary(&token)))
}

#[wasm_bindgen]
pub fn jwt_verify(bytes: &[u8], jwk: &[u8], options_json: &str) -> String {
    finish(verify(bytes, jwk, options_json))
}

fn finish(result: Result<Value, &'static str>) -> String {
    let output = result
        .unwrap_or_else(|code| json!({"schema_version":1,"error":code,"message":code}))
        .to_string();
    if output.len() > 256 * 1024 {
        return json!({"schema_version":1,"error":"output_too_large","message":"output exceeds 256 KiB"}).to_string();
    }
    output
}

fn decode(value: &str) -> Result<Vec<u8>, &'static str> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| "invalid_base64url")
}

fn parse(bytes: &[u8]) -> Result<Token<'_>, &'static str> {
    if bytes.is_empty() {
        return Err("empty_input");
    }
    if bytes.len() > MAX_INPUT {
        return Err("input_too_large");
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "invalid_utf8")?;
    let mut parts = text.split('.');
    let header = parts.next().ok_or("invalid_compact_jwt")?;
    let payload = parts.next().ok_or("invalid_compact_jwt")?;
    let signature = parts.next().ok_or("invalid_compact_jwt")?;
    if parts.next().is_some() || header.is_empty() || payload.is_empty() {
        return Err("invalid_compact_jwt");
    }
    if header.len() > MAX_HEADER {
        return Err("header_too_large");
    }
    let header =
        serde_json::from_slice::<Object>(&decode(header)?).map_err(|_| "invalid_header")?;
    let claims =
        serde_json::from_slice::<Object>(&decode(payload)?).map_err(|_| "invalid_claims")?;
    if !header.0.get("alg").is_some_and(Value::is_string) {
        return Err("invalid_algorithm");
    }
    Ok(Token {
        header,
        claims,
        signature: decode(signature)?,
        signed: &bytes[..text.len() - signature.len() - 1],
    })
}

fn summary(token: &Token<'_>) -> Value {
    let mut findings = Vec::new();
    if token.header.0.get("alg").and_then(Value::as_str) == Some("none") {
        findings.push("unsigned_token");
    }
    if token.signature.is_empty() {
        findings.push("empty_signature");
    }
    if !token.header.0.contains_key("typ") {
        findings.push("missing_explicit_type");
    }
    if !token.claims.0.contains_key("exp") {
        findings.push("missing_expiration");
    }
    if ["jku", "x5u", "jwk", "x5c"]
        .iter()
        .any(|key| token.header.0.contains_key(*key))
    {
        findings.push("token_supplied_key_reference_ignored");
    }
    if token.header.0.contains_key("crit") || token.header.0.contains_key("b64") {
        findings.push("unsupported_header_extension");
    }
    json!({
        "schema_version":1, "kind":"jwt", "verified":false, "claimsTrusted":false,
        "algorithm":token.header.0.get("alg"), "type":token.header.0.get("typ"),
        "keyId":token.header.0.get("kid"),
        "claimNames":token.claims.0.keys().collect::<Vec<_>>(),
        "registeredClaims": (["iss", "aud", "exp", "nbf", "iat"].iter().filter_map(|key|
            token.claims.0.get(*key).map(|value| ((*key).to_string(), value.clone()))
        ).collect::<Map<_, _>>()),
        "findings":findings,
        "caveat":"Inspection alone is unverified. Signature and claim checks do not grant authorization, establish key ownership, or check revocation. The compact token, signature, and sub claim are not returned.",
    })
}

fn verify(bytes: &[u8], jwk: &[u8], options_json: &str) -> Result<Value, &'static str> {
    if options_json.len() > MAX_OPTIONS {
        return Err("options_too_large");
    }
    if jwk.len() > MAX_KEY {
        return Err("key_too_large");
    }
    let key = serde_json::from_slice::<Object>(jwk).map_err(|_| "invalid_jwk")?;
    let options = serde_json::from_str::<Options>(options_json).map_err(|_| "invalid_options")?;
    if !matches!(options.algorithm.as_str(), "RS256" | "ES256")
        || options.issuer.is_empty()
        || options.audience.is_empty()
        || options.now > 9_007_199_254_740_991
    {
        return Err("invalid_verification_policy");
    }
    let token = parse(bytes)?;
    let header = &token.header.0;
    if header.get("alg").and_then(Value::as_str) != Some(options.algorithm.as_str()) {
        return Err("algorithm_mismatch");
    }
    if header.contains_key("crit") || header.contains_key("b64") {
        return Err("unsupported_header_extension");
    }
    if header
        .get("typ")
        .is_some_and(|value| value.as_str() != Some("JWT"))
    {
        return Err("unsupported_token_type");
    }
    let signature_valid = verify_signature(&token, &key.0, &options)?;
    let mut failures = Vec::new();
    let claims = &token.claims.0;
    if claims.get("iss").and_then(Value::as_str) != Some(options.issuer.as_str()) {
        failures.push("issuer_mismatch");
    }
    let audience_valid = match claims.get("aud") {
        Some(Value::String(value)) => value == &options.audience,
        Some(Value::Array(values)) => {
            !values.is_empty()
                && values.iter().all(Value::is_string)
                && values
                    .iter()
                    .any(|value| value.as_str() == Some(options.audience.as_str()))
        }
        _ => false,
    };
    if !audience_valid {
        failures.push("audience_mismatch");
    }
    // This tool deliberately accepts only non-negative, safe-integer NumericDates.
    for (key, required) in [("exp", true), ("nbf", false), ("iat", false)] {
        let value = claims.get(key);
        if value.is_none() && !required {
            continue;
        }
        let timestamp = value
            .and_then(Value::as_u64)
            .filter(|value| *value <= 9_007_199_254_740_991);
        match (key, timestamp) {
            ("exp", Some(time)) if options.now >= time => failures.push("expired"),
            ("nbf", Some(time)) if options.now < time => failures.push("not_yet_valid"),
            ("iat", Some(time)) if options.now < time => failures.push("issued_in_future"),
            (_, None) => failures.push("missing_or_invalid_numeric_date"),
            _ => {}
        }
    }
    let mut report = summary(&token);
    report["signatureValid"] = json!(signature_valid);
    report["claimsValid"] = json!(failures.is_empty());
    report["verified"] = json!(signature_valid && failures.is_empty());
    report["claimsTrusted"] = json!(signature_valid && failures.is_empty());
    report["claimFailures"] = json!(failures);
    report["policy"] = json!({"algorithm":options.algorithm,"issuer":options.issuer,"audience":options.audience,"now":options.now,"clockSkewSeconds":0});
    Ok(report)
}

fn key_bytes(key: &Map<String, Value>, name: &str) -> Result<Vec<u8>, &'static str> {
    decode(key.get(name).and_then(Value::as_str).ok_or("invalid_jwk")?).map_err(|_| "invalid_jwk")
}

fn verify_signature(
    token: &Token<'_>,
    key: &Map<String, Value>,
    options: &Options,
) -> Result<bool, &'static str> {
    if ["d", "p", "q", "dp", "dq", "qi", "oth", "k"]
        .iter()
        .any(|name| key.contains_key(*name))
    {
        return Err("private_or_symmetric_key_rejected");
    }
    if key
        .get("alg")
        .is_some_and(|value| value.as_str() != Some(options.algorithm.as_str()))
        || key
            .get("use")
            .is_some_and(|value| value.as_str() != Some("sig"))
    {
        return Err("jwk_policy_mismatch");
    }
    if let Some(ops) = key.get("key_ops") {
        let Some(ops) = ops.as_array() else {
            return Err("jwk_policy_mismatch");
        };
        if ops.len() != 1 || ops[0].as_str() != Some("verify") {
            return Err("jwk_policy_mismatch");
        }
    }
    for object in [&token.header.0, key] {
        if object.get("kid").is_some_and(|value| !value.is_string()) {
            return Err("invalid_key_id");
        }
    }
    if let (Some(header), Some(key)) = (token.header.0.get("kid"), key.get("kid")) {
        if header != key {
            return Err("key_id_mismatch");
        }
    }
    if options.algorithm == "RS256" {
        if key.get("kty").and_then(Value::as_str) != Some("RSA") {
            return Err("key_type_mismatch");
        }
        let n = key_bytes(key, "n")?;
        let e = key_bytes(key, "e")?;
        if !(256..=512).contains(&n.len()) || n[0] == 0 || e.is_empty() || e.len() > 4 || e[0] == 0
        {
            return Err("invalid_rsa_key");
        }
        let public = RsaPublicKey::new(BigUint::from_bytes_be(&n), BigUint::from_bytes_be(&e))
            .map_err(|_| "invalid_rsa_key")?;
        if !(2048..=4096).contains(&public.n().bits()) {
            return Err("invalid_rsa_key");
        }
        let signature = pkcs1v15::Signature::try_from(token.signature.as_slice())
            .map_err(|_| "invalid_signature_encoding")?;
        return Ok(pkcs1v15::VerifyingKey::<Sha256>::new(public)
            .verify(token.signed, &signature)
            .is_ok());
    }
    if key.get("kty").and_then(Value::as_str) != Some("EC")
        || key.get("crv").and_then(Value::as_str) != Some("P-256")
    {
        return Err("key_type_mismatch");
    }
    let x = key_bytes(key, "x")?;
    let y = key_bytes(key, "y")?;
    if x.len() != 32 || y.len() != 32 {
        return Err("invalid_ec_key");
    }
    let mut point = [0; 65];
    point[0] = 4;
    point[1..33].copy_from_slice(&x);
    point[33..].copy_from_slice(&y);
    let public = VerifyingKey::from_sec1_bytes(&point).map_err(|_| "invalid_ec_key")?;
    let signature =
        Signature::from_slice(&token.signature).map_err(|_| "invalid_signature_encoding")?;
    Ok(public.verify(token.signed, &signature).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parser_limits_and_duplicate_members() {
        assert_eq!(parse(&[]).err(), Some("empty_input"));
        assert_eq!(
            parse(&vec![0; MAX_INPUT + 1]).err(),
            Some("input_too_large")
        );
        assert_eq!(parse(b"a.b.c.d").err(), Some("invalid_compact_jwt"));
        assert!(serde_json::from_str::<Object>(r#"{"alg":"none","alg":"RS256"}"#).is_err());
        assert!(serde_json::from_str::<Object>(r#"{"iss":"a","iss":"b"}"#).is_err());
        assert!(decode("YQ==").is_err());
        assert!(decode("YR").is_err());
    }
}
