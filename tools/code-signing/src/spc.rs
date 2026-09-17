//! Microsoft Authenticode `SpcIndirectDataContent` (the eContent of a PE
//! signature) decoded with the `der` crate. Parse-only: the digest is reported
//! but the PE image is never re-hashed or compared.

use der::asn1::{OctetString, ObjectIdentifier};
use der::{Any, Decode, Sequence};
use serde_json::{json, Value};

use crate::hex_encode;

#[derive(Sequence)]
struct AlgorithmIdentifier {
    algorithm: ObjectIdentifier,
    #[asn1(optional = "true")]
    parameters: Option<Any>,
}

#[derive(Sequence)]
struct DigestInfo {
    algorithm: AlgorithmIdentifier,
    digest: OctetString,
}

#[derive(Sequence)]
struct SpcAttributeTypeAndOptionalValue {
    oid: ObjectIdentifier,
    #[asn1(context_specific = "0", optional = "true", tag_mode = "EXPLICIT")]
    value: Option<Any>,
}

#[derive(Sequence)]
struct SpcIndirectDataContent {
    data: SpcAttributeTypeAndOptionalValue,
    message_digest: DigestInfo,
}

/// Parse the eContent octets of a SignedData as `SpcIndirectDataContent`.
/// `content` is the raw content of the eContent OCTET STRING (itself DER).
pub(crate) fn indirect_data_report(content: &[u8]) -> Value {
    match SpcIndirectDataContent::from_der(content) {
        Ok(spc) => {
            let algorithm = spc.message_digest.algorithm.algorithm.to_string();
            json!({
                "present": true,
                "data_type_oid": spc.data.oid.to_string(),
                "data_type_name": crate::oid_label(&spc.data.oid.to_string()),
                "hash_algorithm": {
                    "oid": algorithm,
                    "name": crate::oid_label(&algorithm),
                },
                "digest": hex_encode(spc.message_digest.digest.as_bytes()),
            })
        }
        Err(_) => json!({ "present": false, "error": "spc_parse_error" }),
    }
}
