// Real-WASM verification for capa-match. Exercises the compiled
// wasm-bindgen module — never mocks — against stable file-scope rules from
// the embedded capa-rules ruleset, plus every documented boundary.
//
//   node test/verify.mjs <dir containing turen_capa_match_wasm.js>
//
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const directory = path.resolve(process.argv[2] ?? path.join(path.dirname(new URL(import.meta.url).pathname), "../pkg"))
const api = await import(pathToFileURL(path.join(directory, "turen_capa_match_wasm.js")).href)
await api.default({ module_or_path: await readFile(path.join(directory, "turen_capa_match_wasm_bg.wasm")) })

let checks = 0
const ok = (...args) => { assert.ok(...args); checks += 1 }
const eq = (...args) => { assert.deepEqual(...args); checks += 1 }
const text = (value) => new TextEncoder().encode(value)
const report = (output) => JSON.parse(output)
const code = (output) => report(output).error
const RULES_COMMIT = "805f9eaccfb6a4e1ddffc809d71d1e2b5ccc15e5"

// Every entry point returns a JSON string that must always parse to a
// schema-versioned document — the boundary never throws.
function call(fn, ...args) {
  const out = fn(...args)
  eq(typeof out, "string")
  const doc = report(out)
  eq(doc.schema_version, 1)
  return doc
}

// Deterministic xorshift64* byte source for fuzzing.
function prng(seed) {
  let state = BigInt(seed)
  return (n) => {
    const out = new Uint8Array(n)
    for (let i = 0; i < n; i += 1) {
      state ^= state >> 12n
      state ^= (state << 25n) & 0xffffffffffffffffn
      state ^= state >> 27n
      out[i] = Number(((state * 0x2545f4914f6cdd1dn) >> 32n) & 0xffn)
    }
    return out
  }
}

const w16 = (b, o, v) => { b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff }
const w32 = (b, o, v) => { w16(b, o, v & 0xffff); w16(b, o + 2, (v >> 16) & 0xffff) }
const put = (b, o, bytes) => b.set(bytes, o)

// Minimal PE32 DLL: .text holding an export directory with one forwarded
// export (NTDLL.RtlAllocateHeap) plus a plain export, and a .tls section.
// Mirrors the fixture in src/tests.rs so goblin-derived file-scope rules
// (section:, characteristic: forwarded export) fire through the real module.
function testPe() {
  const TEXT_RAW = 0x200
  const TEXT_RVA = 0x1000
  const TEXT_SIZE = 0x600
  const rva = (off) => TEXT_RVA + off
  const file = new Uint8Array(0xa00)

  const section = new Uint8Array(TEXT_SIZE)
  let cur = 0x40
  const edt = cur; cur += 40
  const addrTab = cur; cur += 8
  const namePtr = cur; cur += 8
  const ords = cur; cur += 4
  const nameA = cur; cur += "ServiceMain".length + 1
  const nameB = cur; cur += "FwdFunc".length + 1
  const fwdStr = cur; cur += "NTDLL.RtlAllocateHeap".length + 1
  const libName = cur; cur += "test.dll".length + 1
  const exportDirRva = rva(edt)
  const exportDirSize = cur - edt

  w32(section, edt + 12, rva(libName))
  w32(section, edt + 16, 1) // ordinal base
  w32(section, edt + 20, 2) // address table entries
  w32(section, edt + 24, 2) // name pointers
  w32(section, edt + 28, rva(addrTab))
  w32(section, edt + 32, rva(namePtr))
  w32(section, edt + 36, rva(ords))
  // ServiceMain -> code RVA; FwdFunc -> forwarder string inside export dir.
  w32(section, addrTab, 0x2000)
  w32(section, addrTab + 4, rva(fwdStr))
  w32(section, namePtr, rva(nameA))
  w32(section, namePtr + 4, rva(nameB))
  w16(section, ords, 0); w16(section, ords + 2, 1)
  put(section, nameA, text("ServiceMain"))
  put(section, nameB, text("FwdFunc"))
  put(section, fwdStr, text("NTDLL.RtlAllocateHeap"))
  put(section, libName, text("test.dll"))

  const optSize = 0xe0
  put(file, 0, text("MZ"))
  w32(file, 0x3c, 0x80)
  put(file, 0x80, text("PE\0\0"))
  const coff = 0x84
  w16(file, coff, 0x14c) // i386
  w16(file, coff + 2, 2) // two sections
  w16(file, coff + 16, optSize)
  w16(file, coff + 18, 0x2102) // EXECUTABLE_IMAGE | 32BIT | DLL
  const opt = coff + 20
  w16(file, opt, 0x10b) // PE32
  w32(file, opt + 0x10, 0x2000)
  w32(file, opt + 0x1c, 0x400000)
  w32(file, opt + 0x20, 0x1000)
  w32(file, opt + 0x24, 0x200)
  w32(file, opt + 0x38, 0x3000)
  w32(file, opt + 0x3c, 0x200)
  w16(file, opt + 0x44, 3)
  w32(file, opt + 0x5c, 16)
  w32(file, opt + 0x60, exportDirRva)
  w32(file, opt + 0x64, exportDirSize)
  const sh = opt + optSize
  put(file, sh, text(".text\0\0\0"))
  w32(file, sh + 8, TEXT_SIZE); w32(file, sh + 12, TEXT_RVA)
  w32(file, sh + 16, TEXT_SIZE); w32(file, sh + 20, TEXT_RAW)
  w32(file, sh + 36, 0x60000020)
  put(file, sh + 40, text(".tls\0\0\0\0"))
  w32(file, sh + 48, 0x40); w32(file, sh + 52, 0x2000)
  w32(file, sh + 56, 0x200); w32(file, sh + 60, 0x800)
  w32(file, sh + 76, 0x40000040)
  file.set(section, TEXT_RAW)
  return file
}

const names = (doc) => (doc.capabilities ?? []).map((c) => c.name)

// ---- capa_ruleset: provenance and embedded ruleset integrity ----------------

const ruleset = call(api.capa_ruleset, "{}")
eq(ruleset.imported, true)
eq(ruleset.commit, RULES_COMMIT)
ok(ruleset.rule_count >= 1000, `expected ~1k imported rules, got ${ruleset.rule_count}`)
eq(ruleset.parse_error_count, 0)
ok(ruleset.evaluable_count > 0)
ok(ruleset.skipped_count > 0)
ok(ruleset.skipped_by_reason["static-scope-unsupported"] > 0)
ok(ruleset.unsupported_feature_kinds.includes("mnemonic"))
ok(ruleset.unsupported_feature_kinds.includes("number"))
ok(ruleset.namespace_count > 100)
ok(ruleset.exact_byte_patterns > 0)
eq(ruleset.truncated, false)

const verboseRules = call(api.capa_ruleset, '{"verbose":true}')
eq(verboseRules.rules.length, verboseRules.rule_count)
ok(verboseRules.rules.every((r) => typeof r.name === "string" && typeof r.scope === "string"))
ok(verboseRules.rules.some((r) => r.skip_reason === "static-scope-unsupported"))

// ---- capa_match: stable file-scope rules on crafted inputs ------------------

// "contains PDB path" — file scope, regex `:\.*\.pdb` over the string table.
{
  const input = text("junk prefix C:\\build\\agent.pdb junk suffix")
  const doc = call(api.capa_match, input, "{}")
  eq(doc.input.size, input.length)
  ok(names(doc).includes("contains PDB path"))
  eq(doc.ruleset.commit, RULES_COMMIT)
  eq(doc.ruleset.imported, true)
  const hit = doc.capabilities.find((c) => c.name === "contains PDB path")
  eq(hit.namespace, "executable/pe/pdb")
  eq(hit.scope, "file")
  ok(hit.hits >= 1)
  ok(Array.isArray(hit.evidence) && hit.evidence.length >= 1)
}

// "contain an embedded PE file" — file scope, characteristic embedded pe.
// The carver starts at offset 1, so an MZ at offset 0 does not count; embed
// a second MZ/PE header inside a larger buffer.
{
  const input = new Uint8Array(0x400)
  put(input, 0, text("outer container padding"))
  put(input, 0x100, text("MZ"))
  w32(input, 0x100 + 0x3c, 0x40) // e_lfanew
  put(input, 0x140, text("PE\0\0"))
  const doc = call(api.capa_match, input, "{}")
  ok(names(doc).includes("contain an embedded PE file"))
  ok(doc.features.embedded_pe_count >= 1)
}

// ".tls section" + "forwarded export" — file scope features needing a real
// PE parse through the vendored goblin.
{
  const doc = call(api.capa_match, testPe(), "{}")
  ok(doc.features.formats.includes("pe"))
  ok(names(doc).includes("contain a thread local storage (.tls) section"))
  ok(names(doc).includes("forwarded export"))
}

// Honesty boundary: "access AWS credentials" is function-scope in the
// ruleset — unsatisfiable statically — so the string alone must NOT fabricate
// a match; the rule stays skipped.
{
  const doc = call(api.capa_match, text("reading ~/.aws/credentials now"), "{}")
  ok(!names(doc).includes("access AWS credentials"))
  ok(doc.skipped_by_reason["static-scope-unsupported"] > 0)
  const withSkipped = call(api.capa_match, text("reading ~/.aws/credentials now"), '{"includeSkipped":true}')
  ok(withSkipped.skipped_rules.some((r) => r.name === "access AWS credentials"))
}

// ---- options validation -----------------------------------------------------

const pe = testPe()
eq(code(api.capa_match(pe, "x".repeat(4097))), "options_too_large")
eq(code(api.capa_features(pe, "x".repeat(4097))), "options_too_large")
eq(code(api.capa_ruleset("x".repeat(4097))), "options_too_large")
for (const bad of ["{bad", "[1]", "42", '"str"', "null"]) {
  eq(code(api.capa_match(pe, bad)), "invalid_options")
  eq(code(api.capa_ruleset(bad)), "invalid_options")
}
eq(code(api.capa_match(pe, '{"maxResults":"x"}')), "invalid_options")
eq(code(api.capa_match(pe, '{"includeLib":1}')), "invalid_options")

// maxResults bounds the emitted list but reports the true count.
{
  const input = testPe()
  const full = call(api.capa_match, input, "{}")
  ok(full.capability_count >= 2, `expected >=2 matches on the PE fixture, got ${full.capability_count}`)
  const capped = call(api.capa_match, input, '{"maxResults":1}')
  eq(capped.capability_count, full.capability_count)
  eq(capped.capabilities.length, 1)
  eq(capped.results_truncated, true)
  eq(capped.truncated, true)
}

// includeEvidence:false drops per-rule evidence.
{
  const doc = call(api.capa_match, text("C:\\x\\y.pdb"), '{"includeEvidence":false}')
  ok(doc.capability_count >= 1)
  ok(doc.capabilities.every((c) => c.evidence === undefined))
}

// ---- input boundaries -------------------------------------------------------

// Oversized input rejected before parsing — no allocation of the buffer's
// contents, just the declared length check.
{
  const oversized = new Uint8Array(32 * 1024 * 1024 + 1)
  eq(code(api.capa_match(oversized, "{}")), "input_too_large")
  eq(code(api.capa_features(oversized, "{}")), "input_too_large")
  const atLimit = call(api.capa_match, new Uint8Array(32 * 1024 * 1024), "{}")
  eq(atLimit.schema_version, 1)
  eq(atLimit.error, undefined)
}

// Empty input is a clean report, never an error.
{
  const doc = call(api.capa_match, new Uint8Array(0), "{}")
  eq(doc.schema_version, 1)
  eq(doc.error, undefined)
  ok(Number.isInteger(doc.capability_count) && doc.capability_count >= 0)
  const feats = call(api.capa_features, new Uint8Array(0), "{}")
  eq(feats.formats.length, 0)
  eq(feats.strings.distinct, 0)
}

// ---- malformed/truncated inputs never throw ----------------------------------

for (const bad of [
  text("MZ"),
  text("MZ" + "\0".repeat(60)),
  (() => { const b = text("MZ" + "\0".repeat(0x80)); w32(b, 0x3c, 0x40); put(b, 0x40, text("PE")); return b })(),
  new Uint8Array([0x7f, 0x45, 0x4c, 0x46]),
  new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]),
  text("\xcf\xfa\xed\xfe"),
  text("!<arch>\n"),
  text("PK\x03\x04"),
]) {
  const doc = call(api.capa_match, bad, "{}")
  eq(doc.schema_version, 1)
  call(api.capa_features, bad, "{}")
}

// ---- fuzz: 200+ random/truncated buffers, envelope-or-clean every time -------

const fuzz = prng(0xfeed)
for (let i = 0; i < 240; i += 1) {
  const size = 1 + ((i * 37) % 4096)
  let buf = fuzz(size)
  // Half the cases get a plausible-looking magic prefix so deeper parse
  // paths (PE/ELF/Mach-O/archive) are exercised on garbage.
  if (i % 2 === 0) {
    const magics = [text("MZ"), new Uint8Array([0x7f, 0x45, 0x4c, 0x46]), text("PE\0\0"), new Uint8Array([0xfe, 0xed, 0xfa, 0xce]), text("!<arch>\n"), text("PK\x03\x04")]
    const magic = magics[i % magics.length]
    buf.set(magic.subarray(0, buf.length))
  }
  if (i % 5 === 0) buf = buf.subarray(0, 1 + (i % buf.length))
  const doc = call(api.capa_match, buf, "{}")
  eq(doc.schema_version, 1)
  // either an error envelope or a clean report — nothing else, no throw
  if (doc.error !== undefined) {
    ok(typeof doc.message === "string")
  } else {
    ok(Number.isInteger(doc.capability_count))
    ok(Array.isArray(doc.capabilities))
  }
  call(api.capa_features, buf, "{}")
}

// Determinism: identical input produces byte-identical JSON.
{
  const a = api.capa_match(testPe(), "{}")
  const b = api.capa_match(testPe(), "{}")
  eq(a, b)
}

console.log(`capa-match WASM compatibility verified (${checks} checks)`)
