import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const directory = path.resolve(process.argv[2] ?? "")
const api = await import(
  pathToFileURL(path.join(directory, "turen_unicode_audit_wasm.js")).href
)
await api.default({
  module_or_path: await readFile(
    path.join(directory, "turen_unicode_audit_wasm_bg.wasm"),
  ),
})

const enc = new TextEncoder()
const detect = (bytes, options = "{}") =>
  JSON.parse(api.text_detect(bytes, options))
const transcode = (bytes, options = "{}") =>
  JSON.parse(api.text_transcode(bytes, options))
const audit = (bytes, options = "{}") =>
  JSON.parse(api.unicode_audit(bytes, options))
const stats = (bytes, options = "{}") =>
  JSON.parse(api.text_stats(bytes, options))
const findingsOf = (doc, kind) => doc.findings.filter((f) => f.kind === kind)

// --- text_detect -------------------------------------------------------------
{
  const out = detect(enc.encode("hello w\u00F6rl|d \u2014 \u00FCn\u00EFcod\u00E9"))
  assert.equal(out.schema_version, 1)
  assert.equal(out.encoding, "UTF-8")
  assert.equal(out.utf8_valid, true)
  assert.equal(out.confidence, "high")
  assert.equal(out.bom, null)

  // cp1252 "cafe "hi" code" \u2014 0xE9 e-acute and smart quotes defeat UTF-8.
  const cp1252 = new Uint8Array([
    0x63, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x68, 0x69, 0x94, 0x20, 0x63, 0x6f,
    0x64, 0x65,
  ])
  const legacy = detect(cp1252)
  assert.equal(legacy.encoding, "windows-1252")
  assert.equal(legacy.utf8_valid, false)
  assert.equal(legacy.ascii_only, false)

  // BOMs.
  assert.equal(detect(new Uint8Array([0xef, 0xbb, 0xbf, 0x41])).bom, "utf-8")
  const u16le = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])
  assert.equal(detect(u16le).bom, "utf-16le")
  assert.equal(detect(u16le).encoding, "UTF-16LE")
  const u16be = new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69])
  assert.equal(detect(u16be).bom, "utf-16be")
  assert.equal(detect(u16be).encoding, "UTF-16BE")

  // BOM-less UTF-16LE heuristic via null-byte parity.
  const units = Array.from("plain ascii text, long enough").map((c) =>
    c.codePointAt(0),
  )
  const le = new Uint8Array(units.length * 2)
  units.forEach((u, i) => {
    le[i * 2] = u & 0xff
    le[i * 2 + 1] = u >> 8
  })
  const heur = detect(le)
  assert.equal(heur.utf16_le_likely, true)
  assert.equal(heur.utf16_be_likely, false)
  assert.ok(heur.null_byte_ratio > 0.3)

  // A bad TLD is rejected as invalid options, not a panic.
  assert.equal(
    detect(enc.encode("abc"), '{"tld":"EXAMPLE.COM"}').error,
    "options_invalid",
  )
  assert.equal(
    detect(enc.encode("abc"), '{"tld":"xn--nxasmq6b"}').error,
    undefined,
  )
}

// --- text_transcode ----------------------------------------------------------
{
  const cp1252 = new Uint8Array([0x63, 0x61, 0x66, 0xe9])
  const out = transcode(cp1252, '{"from":"windows-1252"}')
  assert.equal(out.from, "windows-1252")
  assert.equal(out.to, "utf-8")
  assert.equal(out.text, "caf\u00E9")
  assert.equal(out.had_errors, false)

  const auto = transcode(cp1252, '{"from":"auto"}')
  assert.equal(auto.from, "windows-1252")
  assert.ok(auto.text.includes("\u00E9"))

  // Decomposed 'e' + U+0301 combining acute normalizes to composed '\u00E9'.
  const nfc = transcode(enc.encode("cafe\u0301"), '{"normalize":"nfc"}')
  assert.equal(nfc.text, "caf\u00E9")
  assert.equal(nfc.normalize, "nfc")
  // Ligature '\uFB00' and fullwidth '\uFF21' normalize to ASCII.
  const nfkc = transcode(enc.encode("\uFB00\uFF21"), '{"normalize":"nfkc"}')
  assert.equal(nfkc.text, "ffA")

  const bad = transcode(new Uint8Array([0x61, 0xff, 0xfe, 0x62]),
    '{"from":"utf-8"}')
  assert.equal(bad.had_errors, true)
  assert.ok(bad.replacement_chars >= 1)
  assert.ok(bad.text.includes(""))

  // UTF-16LE with BOM, explicit label.
  const u16 = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])
  assert.equal(transcode(u16, '{"from":"utf-16"}').text, "hi")

  assert.equal(transcode(enc.encode("abc"), '{"from":"bogus-enc"}').error,
    "unknown_encoding")
  assert.equal(transcode(enc.encode("abc"), '{"to":"utf-16le"}').error,
    "unsupported_target_encoding")
  assert.equal(transcode(enc.encode("abc"), '{"normalize":"bogus"}').error,
    "invalid_normalize")
}

// --- unicode_audit -------------------------------------------------------------
{
  // CVE-2021-42574 shape: RLO + isolates reorder a comment's display.
  const trojan = enc.encode(
    "if (admin) {\n    /* begin \u202E } \u2066 return true ; \u2069 end */\n    return false;\n}\n",
  )
  const out = audit(trojan)
  assert.equal(out.schema_version, 1)
  assert.equal(out.risk, "high")
  const bidi = findingsOf(out, "bidi_control")
  assert.equal(bidi.length, 3)
  const names = bidi.map((f) => f.name)
  assert.ok(names.includes("RIGHT-TO-LEFT OVERRIDE"))
  assert.ok(names.includes("LEFT-TO-RIGHT ISOLATE"))
  assert.ok(names.includes("POP DIRECTIONAL ISOLATE"))
  const rlo = bidi.find((f) => f.name === "RIGHT-TO-LEFT OVERRIDE")
  assert.equal(rlo.codepoint, "U+202E")
  assert.equal(rlo.line, 2)
  assert.ok(rlo.offset > 10)
  assert.ok(typeof rlo.context === "string")

  // Cyrillic '\u0430' (U+0430) inside an otherwise Latin identifier.
  const mixed = audit(enc.encode("const v\u0430lid = true;\n"))
  const ids = findingsOf(mixed, "mixed_script_identifier")
  assert.equal(ids.length, 1)
  assert.equal(ids[0].identifier, "v\u0430lid")
  assert.equal(ids[0].codepoint, "U+0430")
  assert.deepEqual([...ids[0].scripts].sort(), ["Cyrillic", "Latin"])

  // ZWSP, soft hyphen, and tag characters U+E0001 / U+E0041.
  const invis = audit(enc.encode("a\u200Bb\u00ADc\u{E0001}d\u{E0041}"))
  const invisNames = findingsOf(invis, "invisible_char").map((f) => f.name)
  assert.ok(invisNames.includes("ZERO WIDTH SPACE"))
  assert.ok(invisNames.includes("SOFT HYPHEN"))
  assert.equal(invisNames.filter((n) => n === "TAG CHARACTER").length, 2)

  // NBSP, figure space, ideographic space in code.
  const ws = audit(enc.encode("if (x\u00A0==\u20071)\u3000{\n}"))
  const wsNames = findingsOf(ws, "unusual_whitespace").map((f) => f.name)
  assert.ok(wsNames.includes("NO-BREAK SPACE"))
  assert.ok(wsNames.includes("FIGURE SPACE"))
  assert.ok(wsNames.includes("IDEOGRAPHIC SPACE"))

  // Stray controls BEL, NEL, ESC; tab/newline are not findings.
  const ctl = audit(enc.encode("a\tb\nc\u0007d\u0085e\u001B"))
  const ctlNames = findingsOf(ctl, "control_char").map((f) => f.name)
  assert.equal(ctlNames.length, 3)
  assert.ok(ctlNames.includes("BELL"))
  assert.ok(ctlNames.includes("NEXT LINE"))
  assert.ok(ctlNames.includes("ESCAPE"))

  // Natural RTL run inside an LTR line reorders display vs storage.
  const span = audit(enc.encode('let s = "\u05D0\u05D1\u05D2";\n'))
  const spans = findingsOf(span, "bidi_reorder_span")
  assert.equal(spans.length, 1)
  assert.equal(spans[0].length, 6)
  assert.deepEqual(spans[0].scripts, ["Hebrew"])

  // All-Hebrew line is not flagged as a reorder span.
  assert.equal(
    findingsOf(audit(enc.encode("\u05D0\u05D1\u05D2\n")), "bidi_reorder_span").length,
    0,
  )

  // Malformed UTF-8 audits lossily instead of failing.
  const lossy = audit(new Uint8Array([0x61, 0xff, 0x0a, 0x80, 0x80, 0x62]))
  assert.equal(lossy.decoded_had_errors, true)
  assert.ok(lossy.replacement_chars >= 1)

  // Findings cap.
  const capped = audit(enc.encode("\u200B".repeat(8)), '{"maxFindings":3}')
  assert.equal(capped.findings.length, 3)
  assert.equal(capped.findings_dropped, 5)
  assert.equal(capped.truncated, true)

  // Clean input.
  const clean = audit(enc.encode("fn main() {\n    return 0;\n}\n"))
  assert.equal(clean.risk, "none")
  assert.equal(clean.findings.length, 0)
}

// --- text_stats -----------------------------------------------------------------
{
  const text = "hello world\nlet \u03C0 = 3;\n\u0410\u0411\u0412\n"
  const out = stats(enc.encode(text))
  assert.equal(out.schema_version, 1)
  assert.equal(out.encoding, "UTF-8")
  assert.equal(out.lines, 3)
  assert.equal(out.codepoints, Array.from(text).length)
  const names = out.scripts.map((s) => s.script)
  assert.ok(names.includes("Latin"))
  assert.ok(names.includes("Greek"))
  assert.ok(names.includes("Cyrillic"))
  assert.equal(out.longest_line.line, 1)
  assert.equal(out.longest_line.codepoints, 11)

  const noisy = stats(enc.encode("a\u0007b\u200Bc\u202Ed"))
  assert.equal(noisy.control_chars, 1)
  assert.equal(noisy.nonprintable_chars, 3)

  const empty = stats(new Uint8Array(0))
  assert.equal(empty.lines, 0)
  assert.equal(empty.codepoints, 0)
}

// --- limits and errors ----------------------------------------------------------
{
  const big = new Uint8Array(32 * 1024 * 1024 + 1)
  assert.equal(audit(big).error, "input_too_large")
  assert.equal(detect(big).error, "input_too_large")
  assert.equal(transcode(big).error, "input_too_large")
  assert.equal(stats(big).error, "input_too_large")

  const bigOpts = JSON.stringify({ pad: "x".repeat(4096) })
  const small = enc.encode("abc")
  assert.equal(audit(small, bigOpts).error, "options_too_large")
  assert.equal(detect(small, bigOpts).error, "options_too_large")
  assert.equal(transcode(small, bigOpts).error, "options_too_large")
  assert.equal(stats(small, bigOpts).error, "options_too_large")

  assert.equal(audit(small, "{not json").error, "options_invalid")
}

// --- determinism ------------------------------------------------------------------
{
  const trojan = enc.encode("/* x \u202E } \u2066 y \u2069 */")
  const first = api.unicode_audit(trojan, "{}")
  for (let i = 0; i < 3; i++) assert.equal(api.unicode_audit(trojan, "{}"), first)
  const firstDetect = api.text_detect(trojan, "{}")
  for (let i = 0; i < 3; i++)
    assert.equal(api.text_detect(trojan, "{}"), firstDetect)
  const firstStats = api.text_stats(trojan, "{}")
  for (let i = 0; i < 3; i++)
    assert.equal(api.text_stats(trojan, "{}"), firstStats)
  const cp = new Uint8Array([0x63, 0x61, 0x66, 0xe9])
  const firstTr = api.text_transcode(cp, '{"from":"windows-1252"}')
  for (let i = 0; i < 3; i++)
    assert.equal(api.text_transcode(cp, '{"from":"windows-1252"}'), firstTr)
}

console.log("verify.mjs: all real-WASM checks passed")
