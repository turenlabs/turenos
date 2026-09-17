import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const directory = path.resolve(process.argv[2] ?? "")
const api = await import(pathToFileURL(path.join(directory, "turen_binary_diff_wasm.js")).href)
await api.default({ module_or_path: await readFile(path.join(directory, "turen_binary_diff_wasm_bg.wasm")) })

let checks = 0
const ok = (...args) => { assert.ok(...args); checks += 1 }
const eq = (...args) => { assert.deepEqual(...args); checks += 1 }
const text = (value) => new TextEncoder().encode(value)
const b64 = (bytes) => Buffer.from(bytes).toString("base64")
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")
const pairDoc = (old, neo) => text(JSON.stringify({ old: b64(old), new: b64(neo) }))
const patchDoc = (old, patch) => text(JSON.stringify({ old: b64(old), patch: b64(patch) }))
const report = (output) => JSON.parse(output)
const code = (output) => report(output).error

function thrownCode(fn) {
  try {
    fn()
  } catch (error) {
    const parsed = JSON.parse(error.message)
    eq(parsed.schema_version, 1)
    ok(typeof parsed.error === "string" && parsed.error.length > 0)
    return parsed.error
  }
  throw new Error("expected an error")
}

// Deterministic xorshift64* byte source; no external dependencies.
function prng(seed) {
  let state = BigInt(seed)
  return (n) => {
    const out = new Uint8Array(n)
    for (let i = 0; i < n; i += 1) {
      state ^= state >> 12n
      state ^= (state << 25n) & 0xffffffffffffffffn
      state ^= state >> 27n
      out[i] = Number((state * 0x2545f4914f6cdd1dn) >> 32n & 0xffn)
    }
    return out
  }
}

// ---- binary_compare -------------------------------------------------------

const base = prng(7)(8192)

const identical = report(api.binary_compare(pairDoc(base, base), "{}"))
eq(identical.schema_version, 1)
eq(identical.identical, true)
eq(identical.matched_bytes, 8192)
eq(identical.matching_ratio, 1)
eq(identical.similarity_score, 100)
eq(identical.region_count, 0)
eq(identical.sha256_old, sha256(base))
eq(identical.truncated, false)

const single = base.slice()
single[100] ^= 0xa5
const compared = report(api.binary_compare(pairDoc(base, single), "{}"))
eq(compared.identical, false)
eq(compared.common_prefix, 100)
eq(compared.region_count, 1)
eq(compared.regions[0].offset, 100)
eq(compared.regions[0].old_len, 1)
eq(compared.regions[0].new_len, 1)
eq(compared.regions[0].preview.length <= 64, true)
ok(compared.matching_ratio > 0.99)

const inserted = new Uint8Array(base.length + 300)
inserted.set(base.subarray(0, 1000))
inserted.set(prng(9)(300), 1000)
inserted.set(base.subarray(1000), 1300)
const insReport = report(api.binary_compare(pairDoc(base, inserted), "{}"))
eq(insReport.size_delta, 300)
eq(insReport.common_prefix, 1000)
eq(insReport.region_count, 1)
eq(insReport.regions[0].new_len, 300)
eq(insReport.regions[0].old_len, 0)
ok(insReport.regions[0].new_entropy > 6)

const scattered = base.slice()
for (const offset of [10, 2000, 2001, 4000]) scattered[offset] ^= 0xff
const scatReport = report(api.binary_compare(pairDoc(base, scattered), "{}"))
eq(scatReport.region_count, 3)
eq(scatReport.regions.map((r) => r.offset), [10, 2000, 4000])
eq(scatReport.matched_bytes, 8192 - 4)

// ---- binary_regions --------------------------------------------------------

const regionAligned = report(api.binary_regions(pairDoc(base, single), "{}"))
eq(regionAligned.method, "aligned-scan")
eq(regionAligned.region_count, 1)
eq(regionAligned.regions[0].offset, 100)

const regionInsert = report(api.binary_regions(pairDoc(base, inserted), "{}"))
eq(regionInsert.method, "rolling-hash")
ok(regionInsert.anchor_count >= 1)
eq(regionInsert.region_count, 1)
eq(regionInsert.regions[0].offset, 1000)
eq(regionInsert.regions[0].new_len, 300)
eq(regionInsert.regions[0].old_len, 0)
eq(regionInsert.matched_bytes, base.length)

const deleted = new Uint8Array(base.length - 512)
deleted.set(base.subarray(0, 2048))
deleted.set(base.subarray(2560), 2048)
const regionDelete = report(api.binary_regions(pairDoc(base, deleted), "{}"))
eq(regionDelete.region_count, 1)
eq(regionDelete.regions[0].offset, 2048)
eq(regionDelete.regions[0].old_len, 512)
eq(regionDelete.regions[0].new_len, 0)

// ---- binary_diff / binary_patch round trips --------------------------------

const cases = [
  [new Uint8Array(0), new Uint8Array(0)],
  [new Uint8Array(0), prng(5)(200)],
  [base, new Uint8Array(0)],
  [base, base],
  [text("hello world"), text("hello wasm world")],
  [base, single],
  [base, inserted],
  [base, deleted],
  [base, scattered],
]
for (const [old, neo] of cases) {
  const patch = api.binary_diff(pairDoc(old, neo), "{}")
  ok(patch instanceof Uint8Array)
  eq(Array.from(patch.subarray(0, 8)), [0xdf, 0xb1, 0, 0, 0, 0x10, 0, 0])
  eq(api.binary_patch(patchDoc(old, patch), "{}"), neo)
  // determinism: identical inputs produce identical patch bytes
  eq(api.binary_diff(pairDoc(old, neo), "{}"), patch)
  // patch_info describes the patch
  const info = report(api.binary_patch_info(patch, "{}"))
  eq(info.format, "bipatch")
  eq(info.magic, "0xb1df")
  eq(info.version, "0x1000")
  eq(info.well_formed, true)
  eq(info.complete, true)
  eq(info.output_bytes, neo.length)
  eq(info.patch_bytes, patch.length)
}

// larger round trip through the real module
{
  const old = prng(0xdead)(512 * 1024)
  const neo = new Uint8Array(512 * 1024 + 4096)
  neo.set(old.subarray(0, 100 * 1024))
  neo.set(prng(0xbeef)(4096), 100 * 1024)
  neo.set(old.subarray(100 * 1024), 100 * 1024 + 4096)
  const patch = api.binary_diff(pairDoc(old, neo), "{}")
  eq(api.binary_patch(patchDoc(old, patch), "{}"), neo)
}

// expectedSha256 verification on the real module
{
  const old = text("firmware image v1")
  const neo = text("firmware image v2 extended")
  const patch = api.binary_diff(pairDoc(old, neo), "{}")
  const good = JSON.stringify({ expectedSha256: sha256(neo) })
  eq(api.binary_patch(patchDoc(old, patch), good), neo)
  const bad = JSON.stringify({ expectedSha256: "0".repeat(64) })
  eq(thrownCode(() => api.binary_patch(patchDoc(old, patch), bad)), "checksum_mismatch")
}

// patch tampering
{
  const old = prng(99)(4096)
  const neo = old.slice()
  neo[50] ^= 0x11
  const patch = api.binary_diff(pairDoc(old, neo), "{}")
  eq(thrownCode(() => api.binary_patch(patchDoc(old, patch.subarray(0, patch.length - 3)), "{}")), "invalid_patch")
  const badMagic = patch.slice()
  badMagic[0] ^= 0xff
  eq(thrownCode(() => api.binary_patch(patchDoc(old, badMagic), "{}")), "invalid_patch")
  eq(thrownCode(() => api.binary_patch(patchDoc(old, new Uint8Array(0)), "{}")), "invalid_patch")
  eq(thrownCode(() => api.binary_patch(patchDoc(old, text("BSDIFF40junk")), "{}")), "invalid_patch")
  // silent payload corruption: applies without a checksum, caught with one
  const tampered = patch.slice()
  tampered[patch.length - 4] ^= 0x01
  const wrong = api.binary_patch(patchDoc(old, tampered), "{}")
  eq(wrong.length, neo.length)
  ok(!wrong.every((byte, i) => byte === neo[i]))
  const withChecksum = JSON.stringify({ expectedSha256: sha256(neo) })
  eq(thrownCode(() => api.binary_patch(patchDoc(old, tampered), withChecksum)), "checksum_mismatch")
}

// patch_info triage on non-patches
eq(report(api.binary_patch_info(text("not a patch"), "{}")).format, "unknown")
eq(report(api.binary_patch_info(new Uint8Array([0xdf, 0xb1]), "{}")).warnings[0], "short_header")
const headerOnly = new Uint8Array([0xdf, 0xb1, 0, 0, 0, 0x10, 0, 0])
eq(report(api.binary_patch_info(headerOnly, "{}")).control_count, 0)
eq(api.binary_patch(patchDoc(text("anything"), headerOnly), "{}"), new Uint8Array(0))

// ---- malformed inputs / limits ----------------------------------------------

for (const bad of [new Uint8Array(0), text("not json"), text("[1,2]"), text("42"), text("{}")]) {
  eq(code(api.binary_compare(bad, "{}")), "invalid_input")
  eq(code(api.binary_regions(bad, "{}")), "invalid_input")
  eq(thrownCode(() => api.binary_diff(bad, "{}")), "invalid_input")
  eq(thrownCode(() => api.binary_patch(bad, "{}")), "invalid_input")
}
eq(code(api.binary_compare(text('{"old":5,"new":"AA=="}'), "{}")), "invalid_input")
eq(code(api.binary_compare(text('{"old":"!!!","new":"AA=="}'), "{}")), "invalid_base64")
eq(code(api.binary_compare(text('{"old":"AA==","new":"AA"}'), "{}")), "invalid_base64")

// options limits and shapes
const big = "x".repeat(4097)
eq(code(api.binary_compare(pairDoc(base, base), big)), "options_too_large")
eq(code(api.binary_regions(pairDoc(base, base), big)), "options_too_large")
eq(code(api.binary_patch_info(headerOnly, big)), "options_too_large")
eq(thrownCode(() => api.binary_diff(pairDoc(base, base), big)), "options_too_large")
eq(thrownCode(() => api.binary_patch(patchDoc(base, headerOnly), big)), "options_too_large")
eq(code(api.binary_compare(pairDoc(base, base), "{bad")), "invalid_options")
eq(code(api.binary_compare(pairDoc(base, base), "[1]")), "invalid_options")
eq(code(api.binary_compare(pairDoc(base, base), '{"expectedSha256":"xyz"}')), "invalid_options")

// oversized embedded input: a 32 MiB + 1 field must be rejected before decode
{
  const oversized = new Uint8Array(32 * 1024 * 1024 + 1)
  eq(code(api.binary_compare(pairDoc(oversized, base), "{}")), "input_too_large")
  eq(code(api.binary_regions(pairDoc(base, oversized), "{}")), "input_too_large")
  eq(thrownCode(() => api.binary_diff(pairDoc(oversized, base), "{}")), "input_too_large")
  eq(thrownCode(() => api.binary_patch(patchDoc(base, oversized), "{}")), "input_too_large")
  eq(code(api.binary_patch_info(oversized, "{}")), "input_too_large")
  // and the whole document itself is capped
  eq(code(api.binary_compare(new Uint8Array(92 * 1024 * 1024 + 1), "{}")), "input_too_large")
}

// malformed docs must never panic: garbage in, envelope out
const fuzz = prng(0xfeed)
for (let i = 0; i < 64; i += 1) {
  const garbage = fuzz(1 + (i * 37) % 300)
  eq(report(api.binary_compare(garbage, "{}")).schema_version, 1)
  eq(report(api.binary_regions(garbage, "{}")).schema_version, 1)
  eq(report(api.binary_patch_info(garbage, "{}")).schema_version, 1)
  try { api.binary_diff(garbage, "{}") } catch (error) { eq(JSON.parse(error.message).schema_version, 1) }
  try { api.binary_patch(garbage, "{}") } catch (error) { eq(JSON.parse(error.message).schema_version, 1) }
  checks += 1
}

// maxRegions option bounds the collected list but reports the true count
{
  const old = prng(77)(2048)
  const neo = old.slice()
  for (let i = 0; i < 64; i += 1) neo[i * 16] ^= 0xff
  const capped = report(api.binary_compare(pairDoc(old, neo), '{"maxRegions":4}'))
  eq(capped.region_count, 64)
  eq(capped.regions.length, 4)
  eq(capped.truncated, true)
}

console.log(`binary-diff WASM compatibility verified (${checks} checks)`)
