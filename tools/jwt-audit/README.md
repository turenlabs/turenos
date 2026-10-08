# JWT Audit

Offline JWT inspection and RS256/ES256 verification for AppSec and ProdSec
defenders. Use it to review captured tokens, debug identity integration,
and test issuer, audience, expiration, and algorithm policies.

## Operations

`jwt_inspect(bytes)` decodes a compact JWT without trusting it. It reports
algorithm, type, key ID, claim names, registered context/time claims, and
findings. It never reports the compact token, signature, or `sub` claim.

`jwt_verify(bytes, jwk_bytes, options_json)` accepts one explicit public JWK
as JSON bytes and a separate policy:

```json
{"algorithm":"ES256","issuer":"https://identity.example","audience":"payments-api","now":1800000000}
```

`verified` requires both signature verification and claim-policy success.
`signatureValid` and `claimsValid` report the two checks separately.
Issuer, audience, and expiration are required. `nbf` and `iat` are checked
when present. Time is supplied explicitly in Unix seconds. No clock skew
is allowed. NumericDates must be non-negative safe integers; fractional or
negative dates are rejected by this narrower policy. Future `iat` is rejected.

## Security Boundary

- Only compact, signed JWTs with RS256 or ES256 can verify. Inspection also
  reports unsigned tokens. HMAC, `none`, JWE, detached payloads, `crit`, and
  `b64` extensions cannot verify.
- The caller pins the algorithm and supplies the trusted public key.
  `jku`, `x5u`, embedded `jwk`, and `x5c` never select keys or trigger fetches.
- Duplicate top-level names in header, claims, and JWK are rejected,
  including escaped duplicate names. Nested custom claims are not validated.
- If present, `typ` must be `JWT`. Missing `typ` is a finding, not a failure.
- JWK `alg`, `use`, `key_ops`, and paired key IDs must match the policy.
  Private or symmetric key members are rejected. RSA keys must be 2048 to
  4096 bits. ES256 requires P-256 and raw 64-byte JOSE signatures, not DER.
- Verification does not establish key ownership, check revocation, enforce
  replay protection, or grant authorization. It is not a replacement for
  the application's identity provider or authorization checks.
- WASM has no filesystem, network, subprocess, or random-source access.
  Core reads permission-approved files and uses a fresh isolated worker.

## Bounds

Token input: 128 KiB. Options: 4 KiB. Public JWK: 16 KiB. Encoded header: 8 KiB.
Top-level members: 256 per object. JSON output: 256 KiB. Core serializes one
worker at a time and terminates it on cancellation or a 60-second timeout.
Serde JSON's default nesting limit also applies. Malformed data returns
`{"schema_version":1,"error":"code","message":"code"}`.

## Build

```sh
bun run build:wasm jwt-audit
bun run verify:wasm
```

The build uses Rust 1.97.1 and wasm-pack 0.15.0. Cargo.lock pins the entire
dependency graph. The pack script preserves dependency license files and
records the lockfile digest. Tests compare the actual packaged WASM with
Node crypto for both supported signature algorithms.
The same test also bundles the Core worker and runs it under Node from
isolated packaged assets outside the repository.
