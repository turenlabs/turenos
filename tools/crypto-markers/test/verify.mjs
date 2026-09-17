import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const directory = path.resolve(process.argv[2] ?? "")
const api = await import(pathToFileURL(path.join(directory, "turen_crypto_markers_wasm.js")).href)
await api.default({ module_or_path: await readFile(path.join(directory, "turen_crypto_markers_wasm_bg.wasm")) })

const operations = ["crypto_constants", "entropy_map", "xor_probe", "byte_stats"]

// AES S-box (FIPS-197 Figure 7) embedded at a known offset.
const AES_SBOX = Uint8Array.from([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
])

// --- crypto_constants -------------------------------------------------------
const carrier = new Uint8Array(1024)
carrier.set(AES_SBOX, 128)
const constants = JSON.parse(api.crypto_constants(carrier, "{}"))
assert.equal(constants.schema_version, 1)
assert.ok(constants.signatures_checked > 0)
assert.ok(
  constants.findings.some(
    (finding) =>
      finding.algorithm === "aes" && /s-?box/i.test(finding.constant_name) && finding.offset === 128,
  ),
  "AES S-box must be reported at offset 128",
)
for (const finding of constants.findings) {
  assert.ok(finding.algorithm && finding.constant_name && finding.endianness && finding.confidence)
  assert.equal(typeof finding.offset, "number")
}

const chacha = new Uint8Array(64)
chacha.set(new TextEncoder().encode("expand 32-byte k"), 16)
assert.ok(
  JSON.parse(api.crypto_constants(chacha, "{}"))
    .findings.some((finding) => finding.algorithm.includes("chacha20")),
)

// --- entropy_map ------------------------------------------------------------
const zeros = JSON.parse(api.entropy_map(new Uint8Array(8192), "{}"))
assert.equal(zeros.schema_version, 1)
assert.equal(zeros.overall.entropy, 0)
assert.equal(zeros.regions.length, 2)
assert.ok(zeros.lowest_entropy_region && zeros.highest_entropy_region)

const prng = new Uint8Array(8192)
let state = 0x9e3779b9
for (let index = 0; index < prng.length; index++) {
  state ^= (state << 13) >>> 0
  state ^= state >>> 17
  state ^= (state << 5) >>> 0
  prng[index] = state & 0xff
}
const high = JSON.parse(api.entropy_map(prng, JSON.stringify({ windowSize: 2048, stride: 2048 })))
assert.ok(high.overall.entropy > 7.0, `expected high entropy, got ${high.overall.entropy}`)
assert.equal(high.regions.length, 4)
for (const region of high.regions) {
  assert.equal(region.size, 2048)
  assert.ok(region.entropy >= 0 && region.entropy <= 8)
  assert.ok(region.ascii >= 0 && region.null >= 0 && region.high >= 0)
}
assert.ok(high.assessment.length > 0)

// --- xor_probe --------------------------------------------------------------
// XOR'd MZ payload: MZ + "This program cannot be run in DOS mode" stub text.
const plaintext = new TextEncoder().encode(
  "MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff\x00\x00" +
    "This program cannot be run in DOS mode.\r\r\n$" +
    "PE\x00\x00 kernel32.dll\x00GetProcAddress\x00http://malware.example/beacon\x00",
)
const xorKey = 0x5a
const encoded = plaintext.map((byte) => byte ^ xorKey)
const probe = JSON.parse(api.xor_probe(encoded, "{}"))
assert.equal(probe.schema_version, 1)
assert.equal(probe.scanned_bytes, encoded.length)
assert.ok(probe.candidates.length > 0)
const recovered = probe.candidates.find((candidate) => candidate.key === "5a")
assert.ok(recovered, `key 0x5a not in candidates: ${JSON.stringify(probe.candidates.slice(0, 4))}`)
assert.equal(recovered.length, 1)
assert.ok(recovered.magic_hits.includes("mz"))
assert.ok(recovered.preview_hex.length <= 128)

const provided = JSON.parse(api.xor_probe(encoded, JSON.stringify({ keys: ["5a"], topK: 4 })))
assert.ok(provided.candidates.some((candidate) => candidate.key === "5a" && candidate.method === "provided"))

// Multi-byte key via known-plaintext crib.
const multiPlain = new TextEncoder().encode(
  "GET /index.html HTTP/1.1\r\nHost: example.com\r\nUser-Agent: test\r\n\r\n",
)
const multiKey = [0xde, 0xad, 0xbe, 0xef]
const multiEncoded = multiPlain.map((byte, index) => byte ^ multiKey[index % multiKey.length])
const multi = JSON.parse(
  api.xor_probe(multiEncoded, JSON.stringify({ maxKeyLength: 4, crib: "Host: ", topK: 8 })),
)
assert.ok(
  multi.candidates.some(
    (candidate) => candidate.key === "deadbeef" && candidate.length === 4 && candidate.method === "crib",
  ),
)

// --- byte_stats -------------------------------------------------------------
const statsInput = new TextEncoder().encode("hello world\r\nsecond line\nthird\rmore\x00\x00\x00\x00")
const stats = JSON.parse(api.byte_stats(statsInput, "{}"))
assert.equal(stats.schema_version, 1)
assert.equal(stats.length, statsInput.length)
assert.ok(stats.entropy > 0 && stats.entropy <= 8)
assert.equal(stats.unique_bytes > 0, true)
assert.deepEqual(stats.line_endings, { lf: 1, crlf: 1, cr_only: 1 })
assert.equal(stats.longest_run.length, 4)
assert.equal(stats.longest_run.byte, 0)
assert.ok(stats.top_bytes.length > 0)
assert.ok(stats.null_ratio > 0)
assert.ok(stats.strings.ascii_count >= 4)

// --- malformed options, every operation -------------------------------------
for (const operation of operations) {
  const report = JSON.parse(api[operation](new Uint8Array([1, 2, 3]), "{not json"))
  assert.equal(report.schema_version, 1)
  assert.equal(report.error, "options_invalid", `${operation} malformed options`)

  const hugeOptions = JSON.parse(api[operation](new Uint8Array([0]), " ".repeat(4097)))
  assert.equal(hugeOptions.error, "options_too_large", `${operation} oversized options`)

  const oversized = JSON.parse(api[operation](new Uint8Array(32 * 1024 * 1024 + 1), "{}"))
  assert.equal(oversized.error, "input_too_large", `${operation} oversized input`)

  const empty = JSON.parse(api[operation](new Uint8Array(0), "{}"))
  assert.equal(empty.schema_version, 1)
  assert.equal(empty.error, undefined, `${operation} empty input must not error`)
}

// --- determinism -------------------------------------------------------------
for (const operation of operations) {
  const first = api[operation](carrier, "{}")
  const second = api[operation](carrier, "{}")
  assert.equal(first, second, `${operation} must be deterministic`)
}

console.log("crypto markers verified")
