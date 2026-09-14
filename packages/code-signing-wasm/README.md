# code-signing

Bounded, offline, **parse-only** WebAssembly inspection of code-signing and
PKI structures for Turen agent tools.

This module is a parser, not a validator. It reports structural facts from
certificates, PKCS#7/CMS blobs, CRLs, PE Authenticode certificate tables, and
Mach-O code-signing SuperBlobs. It **never**:

- verifies signatures or trust chains (no chain building, no root stores)
- contacts a network, fetches OCSP responses, or downloads CRLs/AIA
- verifies timestamps or countersignatures
- evaluates Mach-O requirements or entitlements
- executes or emulates analyzed code

Every operation is a read-only structural report over caller-supplied bytes.

## Operations

All functions take `(bytes, options_json) -> JSON string`. Errors return
`{"schema_version":1,"error":"<code>"}`; the module does not throw or panic on
expected input failures.

| Function | Input | Report |
| --- | --- | --- |
| `cert_inspect` | DER or PEM (bundle) X.509 | subject, issuer, serial, validity, SANs, EKUs incl. code-signing flag, public key algorithm/size, signature algorithm, SHA-256 fingerprint, `is_ca`, SKI, AKI, per-extension list |
| `pkcs7_inspect` | DER or PEM CMS/PKCS#7 | content type, SignedData digest algorithms, encapsulated content facts, signer infos (issuer/serial, digest/signature algorithms, signed/unsigned attribute OIDs), countersignature and page-hash presence, messageDigest vs attached-content comparison, embedded certificates via `cert_inspect` logic |
| `crl_inspect` | DER or PEM X.509 CRL | issuer, thisUpdate/nextUpdate, revoked serials + dates + reason codes, cRLNumber, extension list |
| `pe_authenticode` | PE image | WIN_CERTIFICATE table entries, enclosed PKCS#7 report, SpcIndirectData type/hash-algorithm/digest, page-hash presence, nested signatures |
| `macho_codesign` | Mach-O or fat Mach-O | LC_CODE_SIGNATURE region, SuperBlob slot index, CodeDirectory fields (hash type, flags, page size, slot counts, identifier, team ID), requirements/entitlements presence + SHA-256, bounded entitlements XML, CMS blob report |

The `messageDigest` comparison and SpcIndirectData digest are reported as
structural facts only — no authenticity or trust conclusion is drawn.

## Options

```json
{"maxItems": 4096, "includeEntitlementsXml": true}
```

`maxItems` (alias `max_items`, 1..4096) caps every reported collection.
`includeEntitlementsXml` (alias `include_entitlements_xml`, default `true`)
controls whether the entitlements blob body is embedded as bounded XML text.

## Limits

| Bound | Value |
| --- | --- |
| Input bytes | 32 MiB |
| Options JSON | 4 KiB |
| Output JSON | 4 MiB |
| Collections (SANs, revoked certs, embedded certs, signers, blob indices) | 4,096 |
| One string field | 4 KiB |
| Entitlements XML | 256 KiB |
| SuperBlob indices | 4,096 |

Limits are enforced before unbounded allocation or serialization; excess
collections set `truncated: true` and a `warnings` entry. Oversized input,
options, or output produce `input_too_large`, `options_too_large`, or
`output_too_large` error JSON.

## Build and verify

```sh
export PATH="$HOME/.cargo/bin:$PATH"
cargo test --manifest-path tools/code-signing/Cargo.toml
wasm-pack build tools/code-signing --target web --release --out-dir pkg
node tools/code-signing/script/pack.mjs tools/code-signing/pkg artifact/code-signing-wasm
node tools/code-signing/test/verify.mjs artifact/code-signing-wasm/dist
cd artifact/code-signing-wasm && shasum -a 256 -c SHA256SUMS
```

Rust 1.97.1 and wasm-pack 0.15.0 are pinned; all dependencies are exact-pinned
in `Cargo.toml` and committed in `Cargo.lock`.

## Upstream

- [x509-parser](https://github.com/rusticata/x509-parser) — X.509/CRL parsing
- [RustCrypto `formats`](https://github.com/RustCrypto/formats) — `cms`, `der`
- [goblin](https://github.com/m4b/goblin) — PE certificate table and Mach-O
  load-command navigation
- RustCrypto `sha1`/`sha2`/`md-5` — structural digest computation only

See `SOURCE.json` and `NOTICE`.
