import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const directory = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, "../pkg"))
const api = await import(pathToFileURL(path.join(directory, "turen_rtf_inspect_wasm.js")).href)
await api.default({ module_or_path: await readFile(path.join(directory, "turen_rtf_inspect_wasm_bg.wasm")) })

let checks = 0
const encoder = new TextEncoder()
const report = (out) => JSON.parse(out)
const ok = (out) => {
  const value = report(out)
  assert.equal(value.error, undefined, out.slice(0, 300))
  return value
}
const eq = (...args) => { assert.deepEqual(...args); checks += 1 }
const is = (...args) => { assert.ok(...args); checks += 1 }
const code = (out) => report(out).error
const rtf = (s) => encoder.encode(s)
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")
const kinds = (value) => value.findings.map((f) => f.kind)

// A hostile-ish document exercising every destination and finding class.
const OLE_MAGIC = "d0cf11e0a6b11ae1"
const malicious = rtf(
  "{\\rtf1\\ansi\\deff0\\ansicpg1252{\\fonttbl{\\f0\\froman\\fcharset0\\fprq2 Times New Roman;}{\\f1\\fswiss Arial;}}" +
  "{\\colortbl;\\red255\\green0\\blue0;}" +
  "{\\stylesheet{\\s0 Normal;}{\\*\\cs1 Default Paragraph Font;}}" +
  "{\\info{\\title Q3 Report}{\\author jdoe}{\\creatim\\yr2024\\mo11\\dy4\\hr8\\min15}{\\nofpages12}}" +
  "{\\*\\generator Microsoft Office Word}" +
  "{\\*\\template http://templates.example/normal.dotm}" +
  "{\\*\\password 9f86d0}" +
  "{\\*\\filetbl{\\file\\fid0{\\*\\fname invoice.scr}{\\*\\frelative C:\\\\Temp}}}" +
  "{\\*\\datastore\\msdef 01020304}" +
  "Report body \\par second line \\'e9nd." +
  "{\\field{\\*\\fldinst HYPERLINK \"http://evil.example/d\"}{\\fldrslt link}}" +
  "{\\field{\\*\\fldinst INCLUDETEXT \"\\\\\\\\fileserver\\\\share\\\\x\"}{\\fldrslt r}}" +
  "{\\object\\objemb\\objw400\\objh200{\\*\\objclass Package}{\\*\\objdata " + OLE_MAGIC + "41424344}{\\result{\\pict\\wmetafile8 0102}}}" +
  "{\\pict\\jpegblip\\picw100\\pich50 ffd8ffe1aabb}}" +
  "TRAILING-GARBAGE")

// ---- rtf_inspect ---------------------------------------------------------

const sum = ok(api.rtf_inspect(malicious, "{}"))
eq(sum.schema_version, 1)
eq(sum.valid_rtf, true)
eq(sum.rtf_version, 1)
eq(sum.charset, "ansi")
eq(sum.ansicpg, 1252)
eq(sum.codepage, 1252)
eq(sum.deff, 0)
eq(sum.input_sha256, sha256(malicious))
eq(sum.info.title, "Q3 Report")
eq(sum.info.author, "jdoe")
eq(sum.info.creatim, "2024-11-04 08:15:00")
eq(sum.info.nofpages, "12")
eq(sum.generator, "Microsoft Office Word")
eq(sum.template, "http://templates.example/normal.dotm")
eq(sum.password_protection, true)
eq(sum.data_stores, 1)
eq(sum.font_table.count, 2)
eq(sum.font_table.fonts[0].name, "Times New Roman")
eq(sum.font_table.fonts[0].family, "roman")
eq(sum.font_table.fonts[1].name, "Arial")
eq(sum.style_sheet.count, 2)
eq(sum.style_sheet.styles[1].kind, "character")
eq(sum.color_table.count, 2) // auto entry + one declared color
eq(sum.color_table.colors[1].r, 255)
eq(sum.file_table.count, 1)
eq(sum.file_table.files[0].name, "invoice.scr")
eq(sum.fields.count, 2)
eq(sum.fields.items[0].keyword, "HYPERLINK")
eq(sum.fields.items[0].url, "http://evil.example/d")
eq(sum.objects.count, 1)
eq(sum.objects.items[0].objclass, "Package")
eq(sum.objects.items[0].ole_magic, true)
eq(sum.pictures.count, 2) // object \result pict + standalone pict
eq(sum.groups.trailing_bytes > 0, true)
eq(sum.groups.max_depth >= 4, true)
is(sum.control_words.top.length > 0, "histogram empty")
eq(sum.control_words.top[0].name.length <= 32, true)
is(sum.text_preview.includes("Report body"), sum.text_preview)

// option bounds on inspect
const top1 = ok(api.rtf_inspect(malicious, JSON.stringify({ top: 1 })))
eq(top1.control_words.top.length, 1)
const prev = ok(api.rtf_inspect(malicious, JSON.stringify({ preview_chars: 4 })))
eq(prev.text_preview.length, 4)

// ---- rtf_objects ---------------------------------------------------------

const objs = ok(api.rtf_objects(malicious, "{}"))
eq(objs.object_count, 1)
eq(objs.returned, 1)
const obj = objs.objects[0]
eq(obj.type, "emb")
eq(obj.objclass, "Package")
eq(obj.declared_w, 400)
eq(obj.declared_h, 200)
eq(obj.result.present, true)
eq(obj.result.contains_pict, true)
eq(obj.objdata.present, true)
eq(obj.objdata.ole_magic, true)
eq(obj.objdata.decoded_bytes, 12)
eq(obj.objdata.preview_hex, OLE_MAGIC + "41424344")
eq(obj.objdata.sha256, sha256(Buffer.from(OLE_MAGIC + "41424344", "hex")))
eq(obj.objdata.odd_hex, false)
eq(obj.objdata.bad_chars, 0)
eq(obj.objdata.payload_hex, null) // gated by option

const withPayload = ok(api.rtf_objects(malicious, JSON.stringify({ include_payload_hex: true })))
eq(withPayload.objects[0].objdata.payload_hex, OLE_MAGIC + "41424344")

// multi-object documents keep their own payloads
const twoObj = rtf(
  "{\\rtf1{\\object{\\*\\objclass Equation.3}{\\*\\objdata d0cf11e0a6b11ae1}}" +
  "{\\object{\\*\\objclass OLE2Link}{\\*\\objdata 4d5a9000}}}")
const two = ok(api.rtf_objects(twoObj, "{}"))
eq(two.object_count, 2)
eq(two.objects[0].objclass, "Equation.3")
eq(two.objects[0].objdata.ole_magic, true)
eq(two.objects[1].objclass, "OLE2Link")
eq(two.objects[1].objdata.ole_magic, false)

// corrupt objdata streams report errors, never fail
const badData = ok(api.rtf_objects(rtf("{\\rtf1{\\object{\\*\\objdata d0cf11ezz5f}}}"), "{}"))
eq(badData.objects[0].objdata.bad_chars, 2)
eq(badData.objects[0].objdata.odd_hex, true)
eq(badData.objects[0].objdata.present, true)

const cappedObjects = ok(api.rtf_objects(twoObj, JSON.stringify({ max_results: 1 })))
eq(cappedObjects.returned, 1)
eq(cappedObjects.object_count, 2)
eq(cappedObjects.truncated, true)

// ---- rtf_audit -----------------------------------------------------------

const audit = ok(api.rtf_audit(malicious, "{}"))
eq(audit.valid_rtf, true)
eq(audit.input_sha256, sha256(malicious))
for (const expected of [
  "objdata_payload", "ole_compound_object", "suspicious_objclass",
  "file_table", "embedded_file", "datastore", "template_path",
  "password_protection", "field_external_ref", "trailing_data",
]) {
  is(kinds(audit).includes(expected), `missing finding ${expected}: ${kinds(audit)}`)
}
const sev = Object.fromEntries(audit.findings.map((f) => [f.kind, f.severity]))
eq(sev.suspicious_objclass, "high")
eq(sev.template_path, "high")
eq(sev.ole_compound_object, "high")
eq(sev.objdata_payload, "medium")
eq(audit.stats.objects, 1)
eq(audit.stats.embedded_files, 1)
eq(audit.stats.trailing_bytes > 0, true)
// every finding carries a byte offset
for (const f of audit.findings) eq(typeof f.offset, "number")
// counts_by_kind covers all emitted kinds
eq(audit.counts_by_kind.objdata_payload >= 1, true)

const highOnly = ok(api.rtf_audit(malicious, JSON.stringify({ min_severity: "high" })))
is(highOnly.findings.every((f) => f.severity === "high"), "severity filter leaked lower findings")
eq(highOnly.matched >= 1, true)

const auditCap = ok(api.rtf_audit(malicious, JSON.stringify({ max_findings: 3 })))
eq(auditCap.findings.length, 3)
eq(auditCap.finding_count > 3, true)
eq(auditCap.truncated, true)

// structural findings on crafted inputs
const deepDoc = "{\\rtf1" + "{".repeat(70) + "x" + "}".repeat(71)
const deep = ok(api.rtf_audit(rtf(deepDoc), "{}"))
is(kinds(deep).includes("deep_nesting"), "no deep_nesting")
is(kinds(deep).includes("extreme_nesting"), "no extreme_nesting")
eq(deep.stats.max_depth, 71)

const unbal = ok(api.rtf_audit(rtf("{\\rtf1{a{a"), "{}"))
is(kinds(unbal).includes("unbalanced_braces"), "no unbalanced_braces")
eq(unbal.stats.unclosed_groups, 3)
const stray = ok(api.rtf_audit(rtf("{\\rtf1 ok}}"), "{}"))
is(kinds(stray).includes("stray_closing_brace"), "no stray_closing_brace")

const hexHeavy = "{\\rtf1 " + "\\'4d".repeat(48) + "}"
is(kinds(ok(api.rtf_audit(rtf(hexHeavy), "{}"))).includes("hex_heavy_region"), "no hex_heavy_region")

const frag = ok(api.rtf_audit(rtf("{\\rtf1 o b f u s c a t e d}"), "{}"))
is(kinds(frag).includes("fragmented_text"), "no fragmented_text")

const binBlob = ok(api.rtf_audit(rtf("{\\rtf1 a\\bin10 0123456789b}"), "{}"))
is(kinds(binBlob).includes("binary_blob"), "no binary_blob")
eq(binBlob.stats.bin_bytes, 10)

const noHeader = ok(api.rtf_audit(rtf("just some text, no rtf"), "{}"))
eq(noHeader.valid_rtf, false)
is(kinds(noHeader).includes("missing_rtf_header"), "no missing_rtf_header")

// ---- rtf_text ------------------------------------------------------------

const txt = ok(api.rtf_text(malicious, "{}"))
is(txt.text.includes("Report body"), txt.text)
is(txt.text.includes("second line \u00e9nd"), txt.text)
is(txt.text.includes("link"), txt.text) // field result kept
is(!txt.text.includes("Times New Roman"), "font table leaked into text")
is(!txt.text.includes("Q3 Report"), "info leaked into text")
is(!txt.text.includes("invoice.scr"), "file table leaked into text")
is(!txt.text.includes("HYPERLINK"), "field instruction leaked into text")
eq(txt.truncated, false)
is(txt.paragraphs >= 1, "paragraph count low")

const cut = ok(api.rtf_text(malicious, JSON.stringify({ max_chars: 8 })))
eq(cut.chars, 8)
eq(cut.truncated, true)

// \uN resolution incl. uc fallback and negative wrap
const uni = ok(api.rtf_text(rtf("{\\rtf1\\ansi caf\\u233? \\u-151?z \\uc2 a\\u65bc def}"), "{}"))
is(uni.text.includes("caf\u00e9"), uni.text)
is(uni.text.includes("\uff69z"), uni.text) // \u-151 wraps to \uff69, '?' fallback skipped
is(uni.text.includes("a\u0041"), uni.text) // \u65 = 'A', 'bc' skipped (\uc2)

// ---- malformed / bounded input -------------------------------------------

eq(code(api.rtf_inspect(new Uint8Array(), "{}")), "empty_input")
eq(code(api.rtf_text(new Uint8Array(), "{}")), "empty_input")
const tooBig = new Uint8Array(16 * 1024 * 1024 + 1)
for (const op of ["rtf_inspect", "rtf_objects", "rtf_audit", "rtf_text"])
  eq(code(api[op](tooBig, "{}")), "input_too_large", op)
const bigOptions = `{"pad":"${"x".repeat(4096)}"}`
eq(code(api.rtf_inspect(malicious, bigOptions)), "options_too_large")
for (const bad of ["not json", "[1]", "42", "\"x\""])
  eq(code(api.rtf_inspect(malicious, bad)), "invalid_options", bad)

// 200+ malformed/truncated/fuzz inputs: error JSON or clean result, never trap
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
const ops = ["rtf_inspect", "rtf_objects", "rtf_audit", "rtf_text"]
const fuzz = prng(0xdeadbeef)
let fuzzChecks = 0
for (let i = 0; i < 96; i += 1) {
  const input = fuzz(1 + (i * 37) % 900)
  for (const op of ops) eq(report(api[op](input, "{}")).schema_version, 1)
  fuzzChecks += 1
}
// truncations of the real document at every 97th byte boundary
for (let i = 1; i < malicious.length; i += 97) {
  const part = malicious.slice(0, i)
  for (const op of ops) eq(report(api[op](part, "{}")).schema_version, 1)
  fuzzChecks += 1
}
// single-byte corruptions of the real document
for (let i = 0; i < 64; i += 1) {
  const off = (i * 53) % malicious.length
  const mut = malicious.slice()
  mut[off] = [0x7b, 0x7d, 0x5c, 0x00, 0xff, 0x27][i % 6]
  for (const op of ops) eq(report(api[op](mut, "{}")).schema_version, 1)
  fuzzChecks += 1
}
// grammar-flavored fuzz: shuffled RTF control tokens
const tokens = ["{", "}", "\\", "\\par", "\\'hh", "\\*", "\\objdata", "\\bin", "zz", " "]
for (let i = 0; i < 64; i += 1) {
  let s = ""
  const len = 1 + (i * 29) % 60
  for (let j = 0; j < len; j += 1) s += tokens[(i * 7 + j * 13) % tokens.length]
  for (const op of ops) eq(report(api[op](encoder.encode(s), "{}")).schema_version, 1)
  fuzzChecks += 1
}
is(fuzzChecks >= 200, `only ${fuzzChecks} fuzz inputs`)

// determinism
eq(api.rtf_inspect(malicious, "{}"), api.rtf_inspect(malicious, "{}"))
eq(api.rtf_objects(malicious, "{}"), api.rtf_objects(malicious, "{}"))
eq(api.rtf_audit(malicious, "{}"), api.rtf_audit(malicious, "{}"))
eq(api.rtf_text(malicious, "{}"), api.rtf_text(malicious, "{}"))

console.log(`rtf-inspect WASM verified (${checks + fuzzChecks} checks)`)
