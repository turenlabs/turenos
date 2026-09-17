import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { deflateSync } from "node:zlib"

const directory = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, "../pkg"))
const api = await import(pathToFileURL(path.join(directory, "turen_pdf_inspect_wasm.js")).href)
await api.default({ module_or_path: await readFile(path.join(directory, "turen_pdf_inspect_wasm_bg.wasm")) })

const encoder = new TextEncoder()

// Build a minimal PDF byte buffer with a correct xref table. Objects is a
// list of [id, body] where body is a string or Uint8Array; streams are given
// as { dict, content }.
function buildPdf(objects) {
  const parts = []
  const push = (part) => parts.push(typeof part === "string" ? encoder.encode(part) : part)
  const size = () => parts.reduce((n, p) => n + p.length, 0)
  push("%PDF-1.5\n")
  const offsets = []
  for (const [id, body] of objects) {
    offsets.push([id, size()])
    push(`${id} 0 obj\n`)
    if (body instanceof Uint8Array) push(body)
    else if (body && typeof body === "object" && "content" in body) {
      const stream = body.content
      push(`<< ${body.dict ?? ""} /Length ${stream.length} >>\nstream\n`)
      push(stream)
      push("\nendstream")
    } else push(String(body))
    push("\nendobj\n")
  }
  const xref = size()
  const max = objects.length + 1
  push(`xref\n0 ${max}\n0000000000 65535 f \n`)
  for (const [, offset] of offsets) push(`${String(offset).padStart(10, "0")} 00000 n \n`)
  push(`trailer\n<< /Size ${max} /Root 1 0 R /Info 10 0 R >>\nstartxref\n${xref}\n%%EOF`)
  const total = size()
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const helloContent = encoder.encode("BT /F1 12 Tf 100 700 Td (Hello Turen) Tj ET")
const flatedJs = deflateSync(encoder.encode("var s = 'flate-decoded-js';"))
const ahexPayload = encoder.encode("ahex decoded payload")
const ahexContent = encoder.encode(
  Buffer.from(ahexPayload).toString("hex").toUpperCase() + ">",
)

const pdf = buildPdf([
  [1, "<< /Type /Catalog /Pages 2 0 R /OpenAction 6 0 R /Names << /JavaScript << /Names [(boot) 6 0 R] >> >> >>"],
  [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
  [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Annots [11 0 R] /Resources << /Font << /F1 5 0 R >> >> >>"],
  [4, { dict: "", content: helloContent }],
  [5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"],
  [6, "<< /Type /Action /S /JavaScript /JS (app.alert('x')) >>"],
  [7, { dict: "/Filter /FlateDecode", content: flatedJs }],
  [8, { dict: "/Filter /ASCIIHexDecode", content: ahexContent }],
  [9, { dict: "/Filter /DCTDecode", content: encoder.encode("fake jpeg") }],
  [10, "<< /Producer (verify-mjs) /Creator (pdf-inspect) >>"],
  [11, "<< /Type /Annot /Subtype /Link /A << /S /URI /URI (https://verify.example/x) >> >>"],
])

const parse = (text) => JSON.parse(text)
const ok = (text) => {
  const value = parse(text)
  assert.equal(value.error, undefined, text)
  return value
}

// ---- pdf_inspect ----
const summary = ok(api.pdf_inspect(pdf, "{}"))
assert.equal(summary.schema_version, 1)
assert.equal(summary.version, "1.5")
assert.equal(summary.page_count, 1)
assert.equal(summary.object_count, 11)
assert.equal(summary.encrypted, false)
assert.equal(summary.decrypted_on_load, false)
assert.equal(summary.linearized, false)
assert.equal(summary.xref_type, "table")
assert.equal(summary.info.producer, "verify-mjs")
assert.equal(summary.info.creator, "pdf-inspect")
assert.equal(summary.input_sha256.length, 64)
assert.ok(summary.catalog_keys.includes("OpenAction"))
assert.ok(summary.catalog_keys.includes("Names"))
const codes = summary.findings.map((finding) => finding.code)
for (const expected of ["javascript", "open_action", "uri_action", "names_dictionary", "external_url"])
  assert.ok(codes.includes(expected), `missing finding ${expected}`)
assert.ok(summary.urls.includes("https://verify.example/x"))
assert.equal(summary.truncated, false)

// findings cap
const capped = ok(api.pdf_inspect(pdf, JSON.stringify({ max_findings: 1 })))
assert.equal(capped.findings.length, 1)
assert.ok(capped.findings_total > 1)
assert.equal(capped.truncated, true)

// ---- pdf_objects ----
const table = ok(api.pdf_objects(pdf, "{}"))
assert.equal(table.object_count, 11)
assert.equal(table.returned, 11)
const fontRow = table.objects.find((row) => row.type === "Font")
assert.equal(fontRow.subtype, "Type1")
const streamRows = table.objects.filter((row) => row.stream)
assert.equal(streamRows.length, 4)
assert.ok(streamRows.every((row) => row.stream_length > 0))
const flateRow = table.objects.find((row) => row.object_id[0] === 7)
assert.deepEqual(flateRow.filters, ["FlateDecode"])
const catalogRow = table.objects.find((row) => row.object_id[0] === 1)
for (const key of ["OpenAction", "Names", "JavaScript"])
  assert.ok(catalogRow.suspicious_keys.includes(key), `missing suspicious key ${key}`)

const filtered = ok(api.pdf_objects(pdf, JSON.stringify({ type: "font" })))
assert.equal(filtered.returned, 1)
assert.equal(filtered.objects[0].type, "Font")
const kindStreams = ok(api.pdf_objects(pdf, JSON.stringify({ kind: "stream" })))
assert.equal(kindStreams.returned, 4)
const single = ok(api.pdf_objects(pdf, JSON.stringify({ object_id: 5 })))
assert.equal(single.returned, 1)
assert.deepEqual(single.objects[0].object_id, [5, 0])
const cappedObjects = ok(api.pdf_objects(pdf, JSON.stringify({ max_results: 3 })))
assert.equal(cappedObjects.returned, 3)
assert.equal(cappedObjects.matched, 11)
assert.equal(cappedObjects.truncated, true)
const missingObject = parse(api.pdf_objects(pdf, JSON.stringify({ object_id: 99 })))
assert.equal(missingObject.error, "object_not_found")

// ---- pdf_stream_decode ----
const raw = ok(api.pdf_stream_decode(pdf, JSON.stringify({ object_id: 4 })))
assert.equal(raw.decoded_length, helloContent.length)
assert.deepEqual(Buffer.from(raw.data_base64, "base64"), Buffer.from(helloContent))
assert.deepEqual(raw.filters, [])
assert.equal(raw.truncated, false)

const flate = ok(api.pdf_stream_decode(pdf, JSON.stringify({ object_id: 7 })))
assert.deepEqual(flate.filters, ["FlateDecode"])
assert.ok(Buffer.from(flate.data_base64, "base64").includes("flate-decoded-js"))

const ahex = ok(api.pdf_stream_decode(pdf, JSON.stringify({ object_id: 8 })))
assert.deepEqual(Buffer.from(ahex.data_base64, "base64"), Buffer.from(ahexPayload))

const unsupported = parse(api.pdf_stream_decode(pdf, JSON.stringify({ object_id: 9 })))
assert.equal(unsupported.error, "unsupported_filter")
assert.deepEqual(unsupported.unsupported_filters, ["DCTDecode"])

for (const [options, error] of [
  [{}, "missing_object_id"],
  [{ object_id: 99 }, "object_not_found"],
  [{ object_id: 5 }, "not_a_stream"],
  [{ object_id: 4, max_output_bytes: 8 }, "decoded_stream_too_large"],
]) {
  const report = parse(api.pdf_stream_decode(pdf, JSON.stringify(options)))
  assert.equal(report.error, error, JSON.stringify(options))
}

// ---- pdf_text ----
const text = ok(api.pdf_text(pdf, "{}"))
assert.ok(text.text.includes("Hello Turen"), text.text)
assert.equal(text.page_count, 1)
assert.equal(text.pages_processed, 1)
assert.equal(text.truncated, false)
const cutText = ok(api.pdf_text(pdf, JSON.stringify({ max_chars: 5 })))
assert.ok(cutText.text.length <= 5)
assert.equal(cutText.truncated, true)

// ---- malformed / bounded input ----
assert.equal(parse(api.pdf_inspect(encoder.encode("not a pdf"), "{}")).error, "invalid_pdf")
const corrupt = pdf.slice()
corrupt[1] = 0x58
assert.equal(parse(api.pdf_inspect(corrupt, "{}")).error, "invalid_pdf")
assert.equal(parse(api.pdf_inspect(new Uint8Array(), "{}")).error, "empty_input")
const tooBig = new Uint8Array(32 * 1024 * 1024 + 1)
for (const op of ["pdf_inspect", "pdf_objects", "pdf_text", "pdf_stream_decode"])
  assert.equal(parse(api[op](tooBig, "{}")).error, "input_too_large", op)
const bigOptions = `{"pad":"${"x".repeat(4096)}"}`
assert.equal(parse(api.pdf_inspect(pdf, bigOptions)).error, "options_too_large")
for (const bad of ["not json", "[1]", "42"])
  assert.equal(parse(api.pdf_inspect(pdf, bad)).error, "invalid_options", bad)

// truncated pdf still returns a schema_version'd body and never traps
const truncatedPdf = pdf.slice(0, Math.floor(pdf.length / 2))
assert.equal(parse(api.pdf_inspect(truncatedPdf, "{}")).schema_version, 1)

// ---- determinism ----
assert.equal(api.pdf_inspect(pdf, "{}"), api.pdf_inspect(pdf, "{}"))
assert.equal(api.pdf_objects(pdf, "{}"), api.pdf_objects(pdf, "{}"))
assert.equal(api.pdf_text(pdf, "{}"), api.pdf_text(pdf, "{}"))
assert.equal(
  api.pdf_stream_decode(pdf, JSON.stringify({ object_id: 4 })),
  api.pdf_stream_decode(pdf, JSON.stringify({ object_id: 4 })),
)

console.log("pdf-inspect WASM verified")
