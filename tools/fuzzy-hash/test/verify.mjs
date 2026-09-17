import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const directory = path.resolve(process.argv[2] ?? "")
const api = await import(pathToFileURL(path.join(directory, "turen_fuzzy_hash_wasm.js")).href)
await api.default({ module_or_path: await readFile(path.join(directory, "turen_fuzzy_hash_wasm_bg.wasm")) })

const encode = (value) => new TextEncoder().encode(value)

// hash_all: known-answer vectors over "abc" and the empty input
const abc = JSON.parse(api.hash_all(encode("abc")))
assert.equal(abc.schema_version, 1)
assert.equal(abc.bytes, 3)
assert.equal(abc.md5, "900150983cd24fb0d6963f7d28e17f72")
assert.equal(abc.sha1, "a9993e364706816aba3e25717850c26c9cd0d89d")
assert.equal(abc.sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
assert.equal(
  abc.sha512,
  "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
)
assert.equal(abc.blake3, "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85")
assert.equal(abc.xxh64, "44bc2cf5ad770999")
assert.equal(abc.imphash, null)

const empty = JSON.parse(api.hash_all(new Uint8Array(0)))
assert.equal(empty.md5, "d41d8cd98f00b204e9800998ecf8427e")
assert.equal(empty.sha256, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
assert.equal(empty.blake3, "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262")
assert.equal(empty.xxh64, "ef46db3751d8e999")
assert.equal(empty.imphash, null)

// hash_all: imphash on a synthetic minimal PE built in-test (no binaries)
const pe = minimalPe()
const peHashes = JSON.parse(api.hash_all(pe))
assert.equal(peHashes.imphash, "0c4f73a6f9ca4a45523c3f5eaf83360d")
const truncated = JSON.parse(api.hash_all(pe.subarray(0, 200)))
assert.equal(truncated.schema_version, 1)
assert.equal(truncated.imphash, null)
assert.match(truncated.md5, /^[0-9a-f]{32}$/)

// fuzzy_hash: ssdeep and TLSH known answers, plus expected errors
const ssdeep = JSON.parse(api.fuzzy_hash("ssdeep", encode("this is our test data!")))
assert.equal(ssdeep.algorithm, "ssdeep")
assert.equal(ssdeep.hash, "3:YKKGhR0tn:YRGRmn")
assert.equal(JSON.parse(api.fuzzy_hash("ssdeep", new Uint8Array(0))).hash, "3::")

const tlsh = JSON.parse(api.fuzzy_hash("tlsh", encode("Lorem ipsum dolor sit amet, consectetur adipiscing elit")))
assert.equal(tlsh.algorithm, "tlsh")
assert.equal(tlsh.hash, "T12D900249414E0BD59A46503F3ADA802AE50825242B2590561CF690599112214C051556")
assert.equal(JSON.parse(api.fuzzy_hash("tlsh", encode("too small"))).error, "insufficient_data")
assert.equal(JSON.parse(api.fuzzy_hash("md5", encode("abc"))).error, "unknown_algorithm")

// fuzzy_compare: ssdeep scores and TLSH distances on the real module
assert.equal(
  JSON.parse(
    api.fuzzy_compare(
      "ssdeep",
      "96:U57GjXnLt9co6pZwvLhJluvrszNgMFwO6MFG8SvkpjTWf:Hj3BeoEcNJ0TspgIG8SvkpjTg",
      "96:U57GjXnLt9co6pZwvLhJluvrs1eRTxYARdEallia:Hj3BeoEcNJ0TsI9xYeia3R",
    ),
  ).score,
  63,
)
assert.equal(JSON.parse(api.fuzzy_compare("ssdeep", ssdeep.hash, ssdeep.hash)).score, 100)
const dissimilar = JSON.parse(api.fuzzy_hash("ssdeep", new Uint8Array(8192).fill(7)))
assert.ok(JSON.parse(api.fuzzy_compare("ssdeep", ssdeep.hash, dissimilar.hash)).score <= 40)
assert.equal(JSON.parse(api.fuzzy_compare("ssdeep", "3:YKKGhR0tn:YRGRmn", "6144:YKKGhR0tn:YRGRmn")).score, 0)

const tlsh2Hash = JSON.parse(
  api.fuzzy_hash(
    "tlsh",
    encode(
      "Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia",
    ),
  ),
)
assert.equal(JSON.parse(api.fuzzy_compare("tlsh", tlsh.hash, tlsh.hash)).distance, 0)
assert.equal(JSON.parse(api.fuzzy_compare("tlsh", tlsh.hash, tlsh2Hash.hash)).distance, 280)

// malformed hash strings and boundary errors
for (const bad of ["", "garbage", "1:2", "3:a", "0:abc:def", "2147483648:abc:def", "3:a%$:def", ":abc:def"]) {
  assert.equal(JSON.parse(api.fuzzy_compare("ssdeep", bad, ssdeep.hash)).error, "invalid_hash", bad)
  assert.equal(JSON.parse(api.fuzzy_compare("ssdeep", ssdeep.hash, bad)).error, "invalid_hash", bad)
}
assert.equal(JSON.parse(api.fuzzy_compare("tlsh", "T1", tlsh.hash)).error, "invalid_hash")
assert.equal(JSON.parse(api.fuzzy_compare("tlsh", tlsh.hash, "nope")).error, "invalid_hash")
assert.equal(JSON.parse(api.fuzzy_compare("blake3", "a", "b")).error, "unknown_algorithm")

const oversized = new Uint8Array(32 * 1024 * 1024 + 1)
assert.equal(JSON.parse(api.hash_all(oversized)).error, "input_too_large")
assert.equal(JSON.parse(api.fuzzy_hash("ssdeep", oversized)).error, "input_too_large")
assert.equal(JSON.parse(api.fuzzy_compare("ssdeep", "3:" + "a".repeat(5000), ssdeep.hash)).error, "options_too_large")
assert.equal(JSON.parse(api.fuzzy_hash("x".repeat(5000), encode("a"))).error, "options_too_large")

// malformed byte inputs never throw and always return the schema
for (let length = 0; length < 4096; length += 97) {
  const input = Uint8Array.from({ length }, (_, index) => (index * 31) & 0xff)
  for (const output of [api.hash_all(input), api.fuzzy_hash("ssdeep", input), api.fuzzy_hash("tlsh", input)]) {
    assert.equal(JSON.parse(output).schema_version, 1)
  }
}

// determinism across every op
assert.equal(api.hash_all(pe), api.hash_all(pe))
assert.equal(api.fuzzy_hash("ssdeep", pe), api.fuzzy_hash("ssdeep", pe))
assert.equal(api.fuzzy_hash("tlsh", encode("Lorem ipsum dolor sit amet, consectetur adipiscing elit")), api.fuzzy_hash("tlsh", encode("Lorem ipsum dolor sit amet, consectetur adipiscing elit")))
assert.equal(api.fuzzy_compare("ssdeep", ssdeep.hash, dissimilar.hash), api.fuzzy_compare("ssdeep", ssdeep.hash, dissimilar.hash))

console.log("fuzzy-hash WASM compatibility verified")

// Minimal PE32 with KERNEL32.dll (CreateFileA + ordinal 60) and WS2_32.DLL
// (recv + ordinal 115). RVAs 0x1000..0x13ff map onto file bytes 0x200..0x5ff.
function minimalPe() {
  const pe = new Uint8Array(0x600)
  const view = new DataView(pe.buffer)
  const text = (offset, value) => pe.set(encode(value), offset)
  pe[0] = 0x4d // M
  pe[1] = 0x5a // Z
  view.setUint32(0x3c, 0x80, true)
  text(0x80, "PE\0\0")
  view.setUint16(0x84, 0x14c, true) // machine: i386
  view.setUint16(0x86, 1, true) // number of sections
  view.setUint16(0x94, 0xe0, true) // size of optional header
  view.setUint16(0x96, 0x010f, true) // characteristics
  view.setUint16(0x98, 0x10b, true) // PE32 magic
  view.setUint32(0x98 + 32, 0x1000, true) // section alignment
  view.setUint32(0x98 + 36, 0x200, true) // file alignment
  view.setUint32(0x98 + 56, 0x2000, true) // size of image
  view.setUint32(0x98 + 60, 0x200, true) // size of headers
  view.setUint16(0x98 + 68, 3, true) // subsystem: console
  view.setUint32(0x98 + 92, 16, true) // number of rva and sizes
  view.setUint32(0x98 + 104, 0x1000, true) // import directory rva
  view.setUint32(0x98 + 108, 60, true) // import directory size
  text(0x178, ".text\0\0\0")
  view.setUint32(0x178 + 8, 0x400, true) // virtual size
  view.setUint32(0x178 + 12, 0x1000, true) // virtual address
  view.setUint32(0x178 + 16, 0x400, true) // size of raw data
  view.setUint32(0x178 + 20, 0x200, true) // pointer to raw data
  view.setUint32(0x200, 0x1040, true) // KERNEL32 import lookup table rva
  view.setUint32(0x20c, 0x1080, true) // KERNEL32 name rva
  view.setUint32(0x210, 0x1060, true) // KERNEL32 import address table rva
  view.setUint32(0x214, 0x10c0, true) // WS2_32 import lookup table rva
  view.setUint32(0x220, 0x10a0, true) // WS2_32 name rva
  view.setUint32(0x224, 0x10e0, true) // WS2_32 import address table rva
  view.setUint32(0x240, 0x1090, true) // KERNEL32 ILT: CreateFileA hint/name
  view.setUint32(0x244, 0x8000003c, true) // KERNEL32 ILT: ordinal 60
  view.setUint32(0x260, 0x1090, true) // KERNEL32 IAT
  view.setUint32(0x264, 0x8000003c, true)
  view.setUint32(0x2c0, 0x1100, true) // WS2_32 ILT: recv hint/name
  view.setUint32(0x2c4, 0x80000073, true) // WS2_32 ILT: ordinal 115
  view.setUint32(0x2e0, 0x1100, true) // WS2_32 IAT
  view.setUint32(0x2e4, 0x80000073, true)
  text(0x280, "KERNEL32.dll")
  text(0x292, "CreateFileA") // hint 0 at 0x290
  text(0x2a0, "WS2_32.DLL")
  text(0x302, "recv") // hint 0 at 0x300
  return pe
}
