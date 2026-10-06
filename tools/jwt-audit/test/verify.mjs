import assert from "node:assert/strict"
import { randomBytes, verify } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { encode, fixture } from "./fixtures.mjs"
import { verifyWorker } from "./verify-worker.mjs"

const directory = path.resolve(process.argv[2])
await verifyWorker()
const wasm = await readFile(path.join(directory, "turen_jwt_audit_wasm_bg.wasm"))
assert.deepEqual(
  WebAssembly.Module.imports(new WebAssembly.Module(wasm)).filter(
    (entry) => !entry.module.startsWith("./turen_jwt_audit_wasm_bg.js"),
  ),
  [],
)
const api = await import(pathToFileURL(path.join(directory, "turen_jwt_audit_wasm.js")).href)
await api.default({ module_or_path: wasm })
const inspect = (bytes) => JSON.parse(api.jwt_inspect(bytes))
const check = (bytes, jwk, policy) =>
  JSON.parse(
    api.jwt_verify(bytes, Buffer.from(typeof jwk === "string" ? jwk : JSON.stringify(jwk)), JSON.stringify(policy)),
  )
let checks = 0
for (const algorithm of ["RS256", "ES256"]) {
  const f = fixture(algorithm)
  const bytes = f.token()
  const parts = bytes.toString().split(".")
  assert.equal(
    verify(
      "sha256",
      Buffer.from(parts.slice(0, 2).join(".")),
      algorithm === "ES256" ? { key: f.keys.publicKey, dsaEncoding: "ieee-p1363" } : f.keys.publicKey,
      Buffer.from(parts[2], "base64url"),
    ),
    true,
  )
  const report = check(bytes, f.jwk, f.policy)
  assert.equal(report.verified, true)
  assert.equal(report.signatureValid, true)
  assert.equal(report.claimsValid, true)
  assert.equal(report.claimsTrusted, true)
  assert.ok(!JSON.stringify(report).includes("DO-NOT-REPORT-SUBJECT"))
  assert.equal(inspect(bytes).verified, false)
  assert.equal(inspect(bytes).claimsTrusted, false)
  const signature = Buffer.from(parts[2], "base64url")
  signature[0] ^= 1
  assert.equal(
    check(Buffer.from(`${parts[0]}.${parts[1]}.${signature.toString("base64url")}`), f.jwk, f.policy).verified,
    false,
  )
  assert.equal(check(bytes, fixture(algorithm).jwk, f.policy).signatureValid, false)
  for (const [payload, failure] of [
    [{ ...f.claims, exp: f.policy.now }, "expired"],
    [{ ...f.claims, nbf: f.policy.now + 1 }, "not_yet_valid"],
    [{ ...f.claims, iat: f.policy.now + 1 }, "issued_in_future"],
    [{ ...f.claims, iss: "https://attacker.example" }, "issuer_mismatch"],
    [{ ...f.claims, aud: "different-api" }, "audience_mismatch"],
    [{ ...f.claims, aud: [f.policy.audience, 1] }, "audience_mismatch"],
    [{ ...f.claims, exp: null }, "missing_or_invalid_numeric_date"],
    [{ ...f.claims, exp: 1800000000.5 }, "missing_or_invalid_numeric_date"],
    [{ ...f.claims, exp: "1800000300" }, "missing_or_invalid_numeric_date"],
    [{ ...f.claims, exp: -1 }, "missing_or_invalid_numeric_date"],
  ]) {
    const value = check(f.token(payload), f.jwk, f.policy)
    assert.equal(value.signatureValid, true)
    assert.equal(value.verified, false)
    assert.equal(value.claimsTrusted, false)
    assert.ok(value.claimFailures.includes(failure))
    checks++
  }
  assert.equal(
    check(f.token(Object.fromEntries(Object.entries(f.claims).filter(([key]) => key !== "exp"))), f.jwk, f.policy)
      .verified,
    false,
  )
  assert.equal(check(f.token({ ...f.claims, aud: ["another-api", f.policy.audience] }), f.jwk, f.policy).verified, true)
  assert.equal(check(f.token({ ...f.claims, nbf: f.policy.now }), f.jwk, f.policy).verified, true)
  assert.equal(check(bytes, f.jwk, { ...f.policy, algorithm: "HS256" }).error, "invalid_verification_policy")
  assert.equal(check(bytes, { ...f.jwk, alg: "HS256" }, f.policy).error, "jwk_policy_mismatch")
  assert.equal(check(bytes, { ...f.jwk, use: "enc" }, f.policy).error, "jwk_policy_mismatch")
  assert.equal(check(bytes, { ...f.jwk, key_ops: ["sign"] }, f.policy).error, "jwk_policy_mismatch")
  assert.equal(check(bytes, { ...f.jwk, key_ops: ["verify", "verify"] }, f.policy).error, "jwk_policy_mismatch")
  assert.equal(check(bytes, { ...f.jwk, kid: "wrong-key" }, f.policy).error, "key_id_mismatch")
  assert.equal(check(bytes, { ...f.jwk, d: "secret" }, f.policy).error, "private_or_symmetric_key_rejected")
  assert.equal(check(f.token(f.claims, { ...f.header, alg: "none" }), f.jwk, f.policy).error, "algorithm_mismatch")
  assert.equal(
    check(f.token(f.claims, { ...f.header, crit: ["exp"] }), f.jwk, f.policy).error,
    "unsupported_header_extension",
  )
  assert.equal(
    check(f.token(f.claims, { ...f.header, b64: false }), f.jwk, f.policy).error,
    "unsupported_header_extension",
  )
  assert.equal(
    check(f.token(f.claims, { ...f.header, typ: "at+jwt" }), f.jwk, f.policy).error,
    "unsupported_token_type",
  )
  const hinted = check(
    f.token(f.claims, { ...f.header, jku: "https://attacker.example/keys", jwk: fixture(algorithm).jwk }),
    f.jwk,
    f.policy,
  )
  assert.equal(hinted.verified, true)
  assert.ok(hinted.findings.includes("token_supplied_key_reference_ignored"))
  assert.equal(
    check(
      f.token(`{"iss":"wrong","\\u0069ss":"${f.policy.issuer}","aud":"${f.policy.audience}","exp":1800000300}`),
      f.jwk,
      f.policy,
    ).error,
    "invalid_claims",
  )
  assert.equal(
    check(f.token(f.claims, `{"alg":"none","\\u0061lg":"${algorithm}"}`), f.jwk, f.policy).error,
    "invalid_header",
  )
  assert.equal(
    check(bytes, JSON.stringify(f.jwk).replace('"kty":', '"kty":"bad","kty":'), f.policy).error,
    "invalid_jwk",
  )
  if (algorithm === "RS256") {
    const modulus = Buffer.from(f.jwk.n, "base64url")
    const shortBits = Buffer.from(modulus)
    shortBits[0] &= 0x7f
    for (const n of [Buffer.concat([Buffer.from([0]), modulus]), shortBits, Buffer.alloc(513, 1)])
      assert.equal(check(bytes, { ...f.jwk, n: n.toString("base64url") }, f.policy).error, "invalid_rsa_key")
    assert.equal(check(bytes, { ...f.jwk, e: "Ag" }, f.policy).error, "invalid_rsa_key")
  }
  if (algorithm === "ES256") {
    assert.equal(check(f.token(f.claims, f.header, true), f.jwk, f.policy).error, "invalid_signature_encoding")
    assert.equal(
      check(bytes, { ...f.jwk, x: encode(Buffer.alloc(32).toString("binary")), y: "AA" }, f.policy).error,
      "invalid_ec_key",
    )
  }
  checks += 25
}
const f = fixture()
const none = Buffer.from(`${encode({ alg: "none" })}.${encode(f.claims)}.`)
assert.ok(inspect(none).findings.includes("unsigned_token"))
assert.equal(check(none, f.jwk, f.policy).error, "algorithm_mismatch")
assert.equal(inspect(Buffer.from("x.y.z.extra")).error, "invalid_compact_jwt")
assert.equal(inspect(Buffer.from(`${encode(f.header)}=.e30.`)).error, "invalid_base64url")
assert.equal(inspect(Buffer.alloc(128 * 1024 + 1)).error, "input_too_large")
assert.equal(check(f.token(), " ".repeat(16 * 1024 + 1), f.policy).error, "key_too_large")
assert.equal(
  JSON.parse(api.jwt_verify(f.token(), Buffer.from(JSON.stringify(f.jwk)), " ".repeat(4097))).error,
  "options_too_large",
)
const hugeHeader = { ...f.header, padding: "x".repeat(8192) }
assert.equal(inspect(f.token(f.claims, hugeHeader)).error, "header_too_large")
assert.equal(
  inspect(f.token(Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`c${i}`, i])))).error,
  "invalid_claims",
)
assert.equal(
  inspect(
    f.token(f.claims, Object.fromEntries([["alg", "ES256"], ...Array.from({ length: 256 }, (_, i) => [`h${i}`, i])])),
  ).error,
  "invalid_header",
)
for (let i = 0; i < 500; i++) {
  const value = inspect(randomBytes(i))
  assert.equal(value.schema_version, 1)
  assert.equal(typeof value.error, "string")
}
const bytes = f.token()
for (let length = 0; length < bytes.length; length++) {
  const value = inspect(bytes.subarray(0, length))
  assert.equal(value.schema_version, 1)
}
console.log(
  `JWT WASM verified against Node crypto: ${checks}+ policy checks, 500 malformed inputs, and all token truncations`,
)
