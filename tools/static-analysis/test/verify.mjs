import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { deflateRawSync } from "node:zlib"

const directory = path.resolve(process.argv[2] ?? "")
const api = await import(pathToFileURL(path.join(directory, "turen_static_analysis_wasm.js")).href)
const instance = await api.default({ module_or_path: await readFile(path.join(directory, "turen_static_analysis_wasm_bg.wasm")) })
assert.throws(() => instance.memory.grow(4096), RangeError, "The extension must enforce its 256 MiB memory maximum")

const operations = [
  "identify_file",
  "hash_digest",
  "entropy_scan",
  "fuzzy_hash",
  "import_hash",
  "disassemble",
  "scan_embedded",
  "detect_packer",
  "list_archive",
  "extract_archive_entry",
  "parse_pdf",
  "parse_ole",
  "office_inspect",
  "parse_exif",
  "parse_certificate",
  "parse_plist",
  "parse_lnk",
  "parse_minidump",
  "demangle_symbol",
  "parse_dotnet",
  "inspect_overlay",
  "function_flow",
  "vba_extract",
  "dotnet_methods",
]
assert.equal(operations.length, 24)

const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<< /JavaScript 2 0 R >>\nendobj\ntrailer\n%%EOF\n")
const identified = JSON.parse(api.analyze("identify_file", pdf, "{}"))
assert.equal(identified.operation, "identify_file")
assert.equal(identified.result.magic, "pdf")

const hashed = JSON.parse(api.analyze("hash_digest", pdf, JSON.stringify({ algorithm: "sha256" })))
assert.equal(hashed.result.algorithm, "sha256")
assert.equal(hashed.result.digest.length, 64)

const entropy = JSON.parse(api.analyze("entropy_scan", pdf, JSON.stringify({ window: 32 })))
assert.ok(entropy.result.overall > 0)

const fuzzy = JSON.parse(api.analyze("fuzzy_hash", new Uint8Array(64).map((_, index) => index), "{}"))
assert.equal(fuzzy.result.algorithm, "tlsh")

const zip = zipBytes({ "hello.txt": "hello wasm" })
const listed = JSON.parse(api.analyze("list_archive", zip, "{}"))
assert.equal(listed.result.format, "zip")
assert.equal(listed.result.entries[0].name, "hello.txt")

const extracted = JSON.parse(api.analyze("extract_archive_entry", zip, JSON.stringify({ index: 0, maxOutputBytes: 1024 })))
assert.equal(extracted.result.name, "hello.txt")
assert.equal(extracted.result.size, 10)

const disassembled = JSON.parse(api.analyze("disassemble", Uint8Array.from([0x90, 0xc3]), JSON.stringify({ bitness: 64, length: 2 })))
assert.ok(disassembled.result.instructions.length >= 1)
assert.match(disassembled.result.instructions[0].text, /nop|ret/i)

const arm = JSON.parse(api.analyze("disassemble", Uint8Array.from([0x1f, 0x20, 0x03, 0xd5, 0xc0, 0x03, 0x5f, 0xd6]), JSON.stringify({ architecture: "arm64", length: 8 })))
assert.equal(arm.result.architecture, "arm64")
assert.match(arm.result.instructions[0].text, /nop/i)
assert.match(arm.result.instructions[1].text, /ret/i)
const flow = JSON.parse(api.analyze("function_flow", Uint8Array.from([0x90, 0xc3]), JSON.stringify({ length: 2, bitness: 64 })))
assert.ok(flow.result.blocks.length > 0)
assert.ok(flow.result.edges.some((edge) => edge.kind === "return"))
const packers = JSON.parse(api.analyze("detect_packer", new TextEncoder().encode("UPX!"), "{}"))
assert.ok(packers.result.matches.some((match) => match.name === "UPX" && match.confidence === "low"))
for (const operation of ["vba_extract", "dotnet_methods"])
  assert.throws(() => api.analyze(operation, pdf, "{}"), (error) => error instanceof Error && !/unsupported operation/i.test(error.message))

const demangled = JSON.parse(api.analyze("demangle_symbol", new Uint8Array([1]), JSON.stringify({ symbol: "_ZN3foo3barE" })))
assert.ok(["c++", "rust"].includes(demangled.result.language))
assert.ok(String(demangled.result.output).includes("foo"))

const lnk = new Uint8Array(0x4c + 8)
lnk.set([0x4c, 0, 0, 0])
const parsedLnk = JSON.parse(api.analyze("parse_lnk", lnk, "{}"))
assert.equal(parsedLnk.result.headerSize, 76)

const minidump = new Uint8Array(32)
minidump.set([0x4d, 0x44, 0x4d, 0x50])
const parsedDump = JSON.parse(api.analyze("parse_minidump", minidump, "{}"))
assert.equal(parsedDump.result.streamCount, 0)

const parsedPdf = JSON.parse(api.analyze("parse_pdf", pdf, "{}"))
assert.equal(parsedPdf.result.javascript, true)

const office = JSON.parse(api.analyze("office_inspect", zipBytes({
  "[Content_Types].xml": "<Types xmlns=\"urn:schemas-microsoft-com:package:2006\"><Override ContentType=\"application/vnd.ms-word.document.macroEnabled.main+xml\"/></Types>",
  "word/_rels/document.xml.rels": "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.example.test/hyperlink\" Target=\"https://example.test/payload\" TargetMode=\"External\"/></Relationships>",
  "word/vbaProject.bin": "synthetic macro marker",
}), "{}"))
assert.equal(office.result.format, "ooxml")
assert.equal(office.result.detections.macro.status, "present")
assert.equal(office.result.detections.externalLinks.status, "present")

console.log("Static analysis WASM compatibility verified")

function zipBytes(files) {
  const encoder = new TextEncoder()
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = encoder.encode(name)
    const data = encoder.encode(text)
    const compressed = deflateRawSync(data)
    const crc = crc32(data)
    const local = new Uint8Array(30 + nameBytes.length + compressed.length)
    const view = new DataView(local.buffer)
    view.setUint32(0, 0x04034b50, true)
    view.setUint16(4, 20, true)
    view.setUint16(8, 8, true)
    view.setUint32(14, crc, true)
    view.setUint32(18, compressed.length, true)
    view.setUint32(22, data.length, true)
    view.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    local.set(compressed, 30 + nameBytes.length)
    const central = new Uint8Array(46 + nameBytes.length)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(10, 8, true)
    centralView.setUint32(16, crc, true)
    centralView.setUint32(20, compressed.length, true)
    centralView.setUint32(24, data.length, true)
    centralView.setUint16(28, nameBytes.length, true)
    centralView.setUint32(42, offset, true)
    central.set(nameBytes, 46)
    locals.push(local)
    centrals.push(central)
    offset += local.length
  }
  const centralStart = offset
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, locals.length, true)
  endView.setUint16(10, locals.length, true)
  endView.setUint32(12, centrals.reduce((sum, item) => sum + item.length, 0), true)
  endView.setUint32(16, centralStart, true)
  const total = locals.reduce((sum, item) => sum + item.length, 0) + centrals.reduce((sum, item) => sum + item.length, 0) + end.length
  const output = new Uint8Array(total)
  let cursor = 0
  for (const part of [...locals, ...centrals, end]) {
    output.set(part, cursor)
    cursor += part.length
  }
  return output
}

function crc32(bytes) {
  let crc = ~0
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}
