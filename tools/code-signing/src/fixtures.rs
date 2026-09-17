//! Test-only fixture builders: every certificate, CRL, CMS, PE, and Mach-O
//! blob in the test suite is constructed here from raw DER encodings so tests
//! exercise the real parsers end to end.

#![allow(dead_code)]

pub const OID_SHA256_WITH_RSA: &[u64] = &[1, 2, 840, 113549, 1, 1, 11];
pub const OID_SHA256: &[u64] = &[2, 16, 840, 1, 101, 3, 4, 2, 1];
pub const OID_RSA_ENCRYPTION: &[u64] = &[1, 2, 840, 113549, 1, 1, 1];
pub const OID_CN: &[u64] = &[2, 5, 4, 3];
pub const OID_O: &[u64] = &[2, 5, 4, 10];
pub const OID_BASIC_CONSTRAINTS: &[u64] = &[2, 5, 29, 19];
pub const OID_KEY_USAGE: &[u64] = &[2, 5, 29, 15];
pub const OID_SAN: &[u64] = &[2, 5, 29, 17];
pub const OID_EKU: &[u64] = &[2, 5, 29, 37];
pub const OID_SKI: &[u64] = &[2, 5, 29, 14];
pub const OID_AKI: &[u64] = &[2, 5, 29, 35];
pub const OID_CRL_NUMBER: &[u64] = &[2, 5, 29, 20];
pub const OID_REASON_CODE: &[u64] = &[2, 5, 29, 21];
pub const OID_EKU_CODE_SIGNING: &[u64] = &[1, 3, 6, 1, 5, 5, 7, 3, 3];
pub const OID_EKU_TIME_STAMPING: &[u64] = &[1, 3, 6, 1, 5, 5, 7, 3, 8];
pub const OID_SIGNED_DATA: &[u64] = &[1, 2, 840, 113549, 1, 7, 2];
pub const OID_DATA: &[u64] = &[1, 2, 840, 113549, 1, 7, 1];
pub const OID_CONTENT_TYPE_ATTR: &[u64] = &[1, 2, 840, 113549, 1, 9, 3];
pub const OID_MESSAGE_DIGEST_ATTR: &[u64] = &[1, 2, 840, 113549, 1, 9, 4];
pub const OID_SIGNING_TIME_ATTR: &[u64] = &[1, 2, 840, 113549, 1, 9, 5];
pub const OID_COUNTERSIGNATURE_ATTR: &[u64] = &[1, 2, 840, 113549, 1, 9, 6];
pub const OID_SPC_INDIRECT_DATA: &[u64] = &[1, 3, 6, 1, 4, 1, 311, 2, 1, 4];
pub const OID_SPC_PE_IMAGE_DATA: &[u64] = &[1, 3, 6, 1, 4, 1, 311, 2, 1, 15];
pub const OID_SPC_PAGE_HASHES_V2: &[u64] = &[1, 3, 6, 1, 4, 1, 311, 2, 3, 2];

// ---------- minimal DER writer ----------

pub fn tlv(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    let len = content.len();
    if len < 0x80 {
        out.push(len as u8);
    } else {
        let bytes = len.to_be_bytes();
        let first = bytes.iter().position(|b| *b != 0).unwrap_or(bytes.len() - 1);
        let used = &bytes[first..];
        out.push(0x80 | used.len() as u8);
        out.extend_from_slice(used);
    }
    out.extend_from_slice(content);
    out
}

pub fn seq(parts: &[&[u8]]) -> Vec<u8> {
    tlv(0x30, &parts.concat())
}

/// SET OF with DER sorting of the encoded members.
pub fn set_of(members: &[&[u8]]) -> Vec<u8> {
    let mut sorted: Vec<&[u8]> = members.to_vec();
    sorted.sort();
    tlv(0x31, &sorted.concat())
}

/// Concatenated encodings inside an IMPLICIT context tag (constructed).
pub fn context_constructed(tag: u8, members: &[&[u8]]) -> Vec<u8> {
    let mut sorted: Vec<&[u8]> = members.to_vec();
    sorted.sort();
    tlv(0xa0 + tag, &sorted.concat())
}

/// [n] EXPLICIT wrapper.
pub fn explicit(tag: u8, inner: &[u8]) -> Vec<u8> {
    tlv(0xa0 + tag, inner)
}

/// [n] primitive context-specific tag (IMPLICIT content bytes).
pub fn context_primitive(tag: u8, content: &[u8]) -> Vec<u8> {
    tlv(0x80 + tag, content)
}

/// DER INTEGER from unsigned magnitude bytes; adds the leading zero when the
/// high bit would make it negative, strips redundant leading zeros.
pub fn int(magnitude: &[u8]) -> Vec<u8> {
    let mut bytes: &[u8] = magnitude;
    while bytes.len() > 1 && bytes[0] == 0 {
        bytes = &bytes[1..];
    }
    let mut content = Vec::new();
    if bytes.first().map(|b| b & 0x80 != 0).unwrap_or(false) {
        content.push(0);
    }
    content.extend_from_slice(bytes);
    tlv(0x02, &content)
}

pub fn oid(arcs: &[u64]) -> Vec<u8> {
    let mut content = vec![(arcs[0] * 40 + arcs[1]) as u8];
    for arc in &arcs[2..] {
        let mut stack = vec![(arc & 0x7f) as u8];
        let mut rest = arc >> 7;
        while rest > 0 {
            stack.push(((rest & 0x7f) | 0x80) as u8);
            rest >>= 7;
        }
        stack.reverse();
        content.extend(stack);
    }
    tlv(0x06, &content)
}

pub fn null() -> Vec<u8> {
    vec![0x05, 0x00]
}

pub fn boolean(value: bool) -> Vec<u8> {
    tlv(0x01, &[if value { 0xff } else { 0x00 }])
}

pub fn enumerated(value: u8) -> Vec<u8> {
    tlv(0x0a, &[value])
}

pub fn utc(value: &str) -> Vec<u8> {
    tlv(0x17, value.as_bytes())
}

pub fn utf8(value: &str) -> Vec<u8> {
    tlv(0x0c, value.as_bytes())
}

pub fn octstr(bytes: &[u8]) -> Vec<u8> {
    tlv(0x04, bytes)
}

/// BIT STRING with `unused` trailing pad bits.
pub fn bitstr(unused: u8, bytes: &[u8]) -> Vec<u8> {
    let mut content = vec![unused];
    content.extend_from_slice(bytes);
    tlv(0x03, &content)
}

pub fn alg_id(arcs: &[u64]) -> Vec<u8> {
    seq(&[&oid(arcs), &null()])
}

/// RDN sequence with CN + O attributes.
pub fn name(cn: &str) -> Vec<u8> {
    seq(&[
        &set_of(&[&seq(&[&oid(OID_CN), &utf8(cn)])]),
        &set_of(&[&seq(&[&oid(OID_O), &utf8("Turen Test")])]),
    ])
}

/// Extension ::= SEQUENCE { oid, critical BOOL OPTIONAL, value OCTET STRING }
pub fn extension(arcs: &[u64], critical: bool, inner_der: &[u8]) -> Vec<u8> {
    if critical {
        seq(&[&oid(arcs), &boolean(true), &octstr(inner_der)])
    } else {
        seq(&[&oid(arcs), &octstr(inner_der)])
    }
}

fn rsa_spki() -> Vec<u8> {
    let modulus: Vec<u8> = (0..64).map(|i| 0xc0u8.wrapping_add(i as u8)).collect();
    let key = seq(&[&int(&modulus), &int(&[0x01, 0x00, 0x01])]);
    seq(&[&alg_id(OID_RSA_ENCRYPTION), &bitstr(0, &key)])
}

/// A deterministic self-issued certificate (signature bytes are fake; this
/// suite is parse-only). `subject_cn == issuer_cn` for self-signed.
pub fn cert_der(
    subject_cn: &str,
    issuer_cn: &str,
    serial: &[u8],
    is_ca: bool,
    code_signing: bool,
    sans: &[&str],
) -> Vec<u8> {
    let key_id = [0x11u8; 20];
    let mut extensions: Vec<Vec<u8>> = Vec::new();
    extensions.push(extension(
        OID_BASIC_CONSTRAINTS,
        is_ca,
        &seq(&[&boolean(is_ca)]),
    ));
    let usage_bits: u8 = if is_ca { 0x84 } else { 0x80 };
    let usage_unused: u8 = if is_ca { 2 } else { 7 };
    extensions.push(extension(
        OID_KEY_USAGE,
        true,
        &bitstr(usage_unused, &[usage_bits]),
    ));
    if code_signing {
        extensions.push(extension(
            OID_EKU,
            false,
            &seq(&[&oid(OID_EKU_CODE_SIGNING), &oid(OID_EKU_TIME_STAMPING)]),
        ));
    }
    if !sans.is_empty() {
        let names: Vec<Vec<u8>> = sans
            .iter()
            .map(|name| context_primitive(2, name.as_bytes()))
            .collect();
        let refs: Vec<&[u8]> = names.iter().map(Vec::as_slice).collect();
        extensions.push(extension(OID_SAN, false, &seq(&refs)));
    }
    extensions.push(extension(OID_SKI, false, &octstr(&key_id)));
    extensions.push(extension(
        OID_AKI,
        false,
        &seq(&[&context_primitive(0, &key_id)]),
    ));
    let ext_refs: Vec<&[u8]> = extensions.iter().map(Vec::as_slice).collect();

    let tbs = seq(&[
        &explicit(0, &int(&[2])),
        &int(serial),
        &alg_id(OID_SHA256_WITH_RSA),
        &name(issuer_cn),
        &seq(&[&utc("250101000000Z"), &utc("350101000000Z")]),
        &name(subject_cn),
        &rsa_spki(),
        &explicit(3, &seq(&ext_refs)),
    ]);
    seq(&[
        &tbs,
        &alg_id(OID_SHA256_WITH_RSA),
        &bitstr(0, &[0xde, 0xad, 0xbe, 0xef]),
    ])
}

/// CRL v2 with `serials` revoked entries, reasonCode=keyCompromise, and a
/// cRLNumber extension.
pub fn crl_der(issuer_cn: &str, serials: &[&[u8]]) -> Vec<u8> {
    let entries: Vec<Vec<u8>> = serials
        .iter()
        .map(|serial| {
            seq(&[
                &int(serial),
                &utc("250301000000Z"),
                &seq(&[&extension(OID_REASON_CODE, false, &enumerated(1))]),
            ])
        })
        .collect();
    let entry_refs: Vec<&[u8]> = entries.iter().map(Vec::as_slice).collect();
    let tbs = seq(&[
        &int(&[1]),
        &alg_id(OID_SHA256_WITH_RSA),
        &name(issuer_cn),
        &utc("250101000000Z"),
        &utc("260101000000Z"),
        &seq(&entry_refs),
        &explicit(0, &seq(&[&extension(OID_CRL_NUMBER, false, &int(&[0x07]))])),
    ]);
    seq(&[
        &tbs,
        &alg_id(OID_SHA256_WITH_RSA),
        &bitstr(0, &[0xca, 0xfe]),
    ])
}

pub struct CmsOpts<'a> {
    /// eContentType OID arcs (e.g. OID_DATA or OID_SPC_INDIRECT_DATA).
    pub econtent_type: &'a [u64],
    /// The octets inside the eContent OCTET STRING, if attached.
    pub content: Option<Vec<u8>>,
    /// When true the messageDigest attr is the real SHA-256 of `content`.
    pub message_digest_ok: bool,
    /// DER certs embedded in the certificates field.
    pub certs: Vec<Vec<u8>>,
    pub countersignature: bool,
    /// Add an unsigned page-hash attribute (Authenticode style).
    pub page_hash_attr: bool,
}

impl Default for CmsOpts<'_> {
    fn default() -> Self {
        Self {
            econtent_type: OID_DATA,
            content: Some(b"hello signed content".to_vec()),
            message_digest_ok: true,
            certs: Vec::new(),
            countersignature: false,
            page_hash_attr: false,
        }
    }
}

fn attribute(arcs: &[u64], value: &[u8]) -> Vec<u8> {
    seq(&[&oid(arcs), &set_of(&[value])])
}

pub fn signer_info_der(
    issuer_der: &[u8],
    serial: &[u8],
    content: Option<&[u8]>,
    message_digest_ok: bool,
    extra_unsigned: &[Vec<u8>],
) -> Vec<u8> {
    use sha2::Digest;
    let digest = if message_digest_ok {
        content.map(|c| sha2::Sha256::digest(c).to_vec())
    } else {
        Some(vec![0x42; 32])
    };
    let mut signed_attrs: Vec<Vec<u8>> = vec![
        attribute(OID_CONTENT_TYPE_ATTR, &oid(OID_DATA)),
        attribute(OID_SIGNING_TIME_ATTR, &utc("250601000000Z")),
    ];
    if let Some(digest) = digest {
        signed_attrs.push(attribute(OID_MESSAGE_DIGEST_ATTR, &octstr(&digest)));
    }
    let signed_refs: Vec<&[u8]> = signed_attrs.iter().map(Vec::as_slice).collect();
    let unsigned_refs: Vec<&[u8]> = extra_unsigned.iter().map(Vec::as_slice).collect();
    let mut parts: Vec<Vec<u8>> = vec![
        int(&[1]),
        seq(&[issuer_der, &int(serial)]),
        alg_id(OID_SHA256),
    ];
    if !signed_attrs.is_empty() {
        parts.push(context_constructed(0, &signed_refs));
    }
    parts.push(alg_id(OID_SHA256_WITH_RSA));
    parts.push(octstr(&[0xaa; 64]));
    if !unsigned_refs.is_empty() {
        parts.push(context_constructed(1, &unsigned_refs));
    }
    seq(&parts.iter().map(Vec::as_slice).collect::<Vec<_>>())
}

/// A CMS ContentInfo wrapping SignedData (RFC 5652). Signature bytes are fake;
/// the tool reports structure only.
pub fn cms_der(opts: &CmsOpts) -> Vec<u8> {
    let issuer = name("Test Issuer");
    let mut unsigned: Vec<Vec<u8>> = Vec::new();
    if opts.page_hash_attr {
        unsigned.push(attribute(OID_SPC_PAGE_HASHES_V2, &octstr(&[0x99; 24])));
    }
    if opts.countersignature {
        let inner = signer_info_der(&issuer, &[0x09], None, false, &[]);
        unsigned.push(attribute(OID_COUNTERSIGNATURE_ATTR, &inner));
    }
    let signer = signer_info_der(
        &issuer,
        &[0x2a],
        opts.content.as_deref(),
        opts.message_digest_ok,
        &unsigned,
    );
    let cert_refs: Vec<&[u8]> = opts.certs.iter().map(Vec::as_slice).collect();
    let mut signed_parts: Vec<Vec<u8>> = vec![
        int(&[1]),
        set_of(&[&alg_id(OID_SHA256)]),
    ];
    if let Some(content) = &opts.content {
        signed_parts.push(seq(&[
            &oid(opts.econtent_type),
            &explicit(0, &octstr(content)),
        ]));
    } else {
        signed_parts.push(seq(&[&oid(opts.econtent_type)]));
    }
    if !opts.certs.is_empty() {
        signed_parts.push(context_constructed(0, &cert_refs));
    }
    signed_parts.push(set_of(&[&signer]));
    let signed_data = seq(&signed_parts.iter().map(Vec::as_slice).collect::<Vec<_>>());
    seq(&[&oid(OID_SIGNED_DATA), &explicit(0, &signed_data)])
}

/// SpcIndirectDataContent for Authenticode-style eContent.
pub fn spc_indirect_data_der() -> Vec<u8> {
    let image = seq(&[
        &bitstr(0, &[0x00]),
        &explicit(2, &seq(&[&context_primitive(1, b"test.exe")])),
    ]);
    seq(&[
        &seq(&[&oid(OID_SPC_PE_IMAGE_DATA), &explicit(0, &image)]),
        &seq(&[&alg_id(OID_SHA256), &octstr(&[0x55; 32])]),
    ])
}

/// Minimal PE32+ image. When `pkcs7` is `Some`, the security data directory
/// points at a WIN_CERTIFICATE table holding the blob.
pub fn pe_image(pkcs7: Option<&[u8]>, extra_x509_entry: Option<&[u8]>) -> Vec<u8> {
    let cert_table_offset = 0x400usize;
    let mut table = Vec::new();
    if let Some(blob) = pkcs7 {
        win_certificate(&mut table, 0x0002, blob);
    }
    if let Some(blob) = extra_x509_entry {
        win_certificate(&mut table, 0x0001, blob);
    }

    let mut bytes = vec![0u8; 0x400 + table.len()];
    bytes[0] = b'M';
    bytes[1] = b'Z';
    bytes[0x3c..0x40].copy_from_slice(&0x80u32.to_le_bytes());
    bytes[0x80..0x84].copy_from_slice(b"PE\0\0");
    // COFF header.
    bytes[0x84..0x86].copy_from_slice(&0x8664u16.to_le_bytes());
    bytes[0x86..0x88].copy_from_slice(&0u16.to_le_bytes()); // no sections needed
    bytes[0x94..0x96].copy_from_slice(&240u16.to_le_bytes());
    bytes[0x96..0x98].copy_from_slice(&0x0022u16.to_le_bytes());
    // PE32+ optional header at 0x98.
    bytes[0x98..0x9a].copy_from_slice(&0x020bu16.to_le_bytes());
    // NumberOfRvaAndSizes at optional-header offset 0x6c.
    bytes[0x98 + 0x6c..0x98 + 0x70].copy_from_slice(&16u32.to_le_bytes());
    // Security directory = data directory index 4 at offset 0x70 + 4*8.
    let dir = 0x98 + 0x70 + 4 * 8;
    if !table.is_empty() {
        bytes[dir..dir + 4].copy_from_slice(&(cert_table_offset as u32).to_le_bytes());
        bytes[dir + 4..dir + 8].copy_from_slice(&(table.len() as u32).to_le_bytes());
    }
    bytes[cert_table_offset..].copy_from_slice(&table);
    bytes
}

fn win_certificate(table: &mut Vec<u8>, cert_type: u16, blob: &[u8]) {
    let length = 8 + blob.len() as u32;
    table.extend_from_slice(&length.to_le_bytes());
    table.extend_from_slice(&0x0200u16.to_le_bytes());
    table.extend_from_slice(&cert_type.to_le_bytes());
    table.extend_from_slice(blob);
    while table.len() % 8 != 0 {
        table.push(0);
    }
}

/// Mach-O 64-bit image with a single LC_CODE_SIGNATURE pointing at `superblob`.
pub fn macho_with_signature(superblob: &[u8]) -> Vec<u8> {
    let data_offset = 0x60usize;
    let mut bytes = vec![0u8; data_offset + superblob.len()];
    bytes[0..4].copy_from_slice(&0xfeedfacfu32.to_le_bytes());
    bytes[4..8].copy_from_slice(&0x0100_000cu32.to_le_bytes());
    bytes[8..12].copy_from_slice(&0u32.to_le_bytes());
    bytes[12..16].copy_from_slice(&2u32.to_le_bytes()); // MH_EXECUTE
    bytes[16..20].copy_from_slice(&1u32.to_le_bytes()); // ncmds
    bytes[20..24].copy_from_slice(&16u32.to_le_bytes()); // sizeofcmds
    // LC_CODE_SIGNATURE: cmd, cmdsize, dataoff, datasize.
    bytes[32..36].copy_from_slice(&0x1du32.to_le_bytes());
    bytes[36..40].copy_from_slice(&16u32.to_le_bytes());
    bytes[40..44].copy_from_slice(&(data_offset as u32).to_le_bytes());
    bytes[44..48].copy_from_slice(&(superblob.len() as u32).to_le_bytes());
    bytes[data_offset..].copy_from_slice(superblob);
    bytes
}

pub const CSMAGIC_REQUIREMENTS: u32 = 0xfade0c01;
pub const CSMAGIC_CODEDIRECTORY: u32 = 0xfade0c02;
pub const CSMAGIC_BLOBWRAPPER: u32 = 0xfade0b01;
pub const CSMAGIC_SUPERBLOB: u32 = 0xfade0cc0;
pub const CSMAGIC_ENTITLEMENT: u32 = 0xfade7171;

/// CS_SuperBlob: magic, length, count, index entries, then blobs.
pub fn superblob(entries: &[(u32, Vec<u8>)]) -> Vec<u8> {
    let index_bytes = entries.len() * 8;
    let mut offsets = Vec::new();
    let mut cursor = 12 + index_bytes;
    for (_, blob) in entries {
        offsets.push(cursor as u32);
        cursor += blob.len();
    }
    let mut out = Vec::new();
    out.extend_from_slice(&CSMAGIC_SUPERBLOB.to_be_bytes());
    out.extend_from_slice(&(cursor as u32).to_be_bytes());
    out.extend_from_slice(&(entries.len() as u32).to_be_bytes());
    for ((slot_type, _), offset) in entries.iter().zip(offsets) {
        out.extend_from_slice(&slot_type.to_be_bytes());
        out.extend_from_slice(&offset.to_be_bytes());
    }
    for (_, blob) in entries {
        out.extend_from_slice(blob);
    }
    out
}

pub fn blob(magic: u32, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&magic.to_be_bytes());
    out.extend_from_slice(&((body.len() + 8) as u32).to_be_bytes());
    out.extend_from_slice(body);
    out
}

/// CodeDirectory v0x20300 with ident/team strings and two hash slots.
pub fn code_directory(ident: &str, team: &str) -> Vec<u8> {
    let hash_size = 32usize;
    let n_code = 2usize;
    let header_len = 64usize;
    let ident_offset = header_len;
    let team_offset = ident_offset + ident.len() + 1;
    let hash_offset = (team_offset + team.len() + 1 + 15) & !15;
    let length = hash_offset + n_code * hash_size;
    let mut body = vec![0u8; length - 8];
    macro_rules! put {
        ($offset:expr, $value:expr) => {
            body[$offset..$offset + 4].copy_from_slice(&$value.to_be_bytes())
        };
    }
    put!(0, 0x20300u32); // version
    put!(4, 0x2u32); // flags: adhoc
    put!(8, hash_offset as u32);
    put!(12, ident_offset as u32);
    put!(16, 1u32); // nSpecialSlots
    put!(20, n_code as u32);
    put!(24, 0x1000u32); // codeLimit
    body[28] = hash_size as u8;
    body[29] = 2; // hashType: sha256
    body[30] = 0; // platform
    body[31] = 12; // pageSize: 4096
    put!(36, 0u32); // scatterOffset
    put!(40, team_offset as u32);
    // spare3 + codeLimit64 remain zero (v0x20300 fields).
    body[ident_offset - 8..ident_offset - 8 + ident.len()].copy_from_slice(ident.as_bytes());
    body[team_offset - 8..team_offset - 8 + team.len()].copy_from_slice(team.as_bytes());
    blob(CSMAGIC_CODEDIRECTORY, &body)
}

/// PEM armor for a DER blob.
pub fn pem(label: &str, der: &[u8]) -> Vec<u8> {
    let mut out = format!("-----BEGIN {label}-----\n").into_bytes();
    let b64 = base64(der);
    for chunk in b64.as_bytes().chunks(64) {
        out.extend_from_slice(chunk);
        out.push(b'\n');
    }
    out.extend_from_slice(format!("-----END {label}-----\n").as_bytes());
    out
}

pub fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(n >> 18) as usize & 0x3f] as char);
        out.push(TABLE[(n >> 12) as usize & 0x3f] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 0x3f] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 0x3f] as char } else { '=' });
    }
    out
}
