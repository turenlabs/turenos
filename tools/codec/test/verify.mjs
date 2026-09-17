import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const directory = path.resolve(process.argv[2] ?? "")
const api = await import(pathToFileURL(path.join(directory, "turen_codec_wasm.js")).href)
await api.default({ module_or_path: await readFile(path.join(directory, "turen_codec_wasm_bg.wasm")) })

let checks = 0
const ok = (...args) => { assert.ok(...args); checks += 1 }
const eq = (...args) => { assert.deepEqual(...args); checks += 1 }
const text = (value) => new TextEncoder().encode(value)
const ascii = (bytes) => new TextDecoder().decode(bytes)

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

function payload(size = 65536) {
  const out = new Uint8Array(size)
  for (let index = 0; index < size; index += 1) out[index] = (index * 7 + (index >> 8)) & 0xff
  return out
}

// ---- compression round trips ---------------------------------------------
const data = payload()
for (const algorithm of ["gzip", "zlib", "deflate", "brotli", "lz4", "lz4-block", "xz", "lzma", "lzma2"]) {
  const compressed = api.compress(algorithm, data, "{}")
  ok(compressed.length > 0, `${algorithm} compressed`)
  eq(api.decompress(algorithm, compressed, "{}"), data, `${algorithm} round trip`)
  eq(api.compress(algorithm, data, "{}"), compressed, `${algorithm} deterministic`)
}

// ---- reference fixtures (not produced by this module) ---------------------
const GZIP_FIXTURE = new Uint8Array([
  0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x03, 0x2b, 0x29, 0x2d, 0x4a,
  0xcd, 0x53, 0x48, 0xce, 0x4f, 0x49, 0x4d, 0x56, 0x48, 0xcb, 0xac, 0x28, 0x01, 0x72,
  0xb9, 0x00, 0x1a, 0x00, 0xc4, 0x69, 0x14, 0x00, 0x00, 0x00,
])
eq(api.decompress("gzip", GZIP_FIXTURE, "{}"), text("turen codec fixture\n"))

const BZIP2_FIXTURE = new Uint8Array([
  0x42, 0x5a, 0x68, 0x39, 0x31, 0x41, 0x59, 0x26, 0x53, 0x59, 0x66, 0x0f, 0xdb, 0x71,
  0x00, 0x00, 0x0a, 0xd9, 0x80, 0x00, 0x10, 0x40, 0x00, 0x10, 0x00, 0x1f, 0x21, 0xd6,
  0x50, 0x20, 0x00, 0x22, 0x26, 0x87, 0xa4, 0x30, 0x8f, 0x50, 0xa1, 0xa6, 0x98, 0x00,
  0x61, 0xc1, 0x0c, 0x16, 0x25, 0xd7, 0x06, 0x59, 0xeb, 0xc8, 0x7a, 0x53, 0x27, 0xe2,
  0xee, 0x48, 0xa7, 0x0a, 0x12, 0x0c, 0xc1, 0xfb, 0x6e, 0x20,
])
eq(api.decompress("bzip2", BZIP2_FIXTURE, "{}"), text("turen codec bzip2 fixture\n"))

const ZSTD_SMALL = Buffer.from("KLUv/QQ4yQAAdHVyZW4gY29kZWMgenN0ZCBmaXh0dXJlCj7L3yw=", "base64")
eq(api.decompress("zstd", ZSTD_SMALL, "{}"), text("turen codec zstd fixture\n"))

const ZSTD_BLOCKS = Buffer.from(
  "KLUv/QQ4RQUAfAQAcmVjb3JkLTAwMCBhYWFhYmJiYmNjY2MKMTIzNDU2Nzg5MTExMTExMTExMTIyMjIyMjIyMjIzMzMzMzMzMzMzNDQ0NDQ0NDQwqBCI8b8fEcwgENH6ARD2xUmsfMMzHMM3HMM3fMM3fNM2bdM2bdM2bdM2bdM2rY3TOBt34zXOxt14jbNxN15zmt/c5ja3uc1tbnObm2xtKCubSPs1spagaVswFgAj/HzT4Q==",
  "base64",
)
const zstdExpected = new Uint8Array(48 * 24)
for (let index = 0; index < 48; index += 1) {
  zstdExpected.set(text(`record-${String(index).padStart(3, "0")} aaaabbbbcccc\n`), index * 24)
}
eq(api.decompress("zstd", ZSTD_BLOCKS, "{}"), zstdExpected)

// decode-only algorithms reject compress
for (const algorithm of ["zstd", "bzip2"]) {
  eq(thrownCode(() => api.compress(algorithm, text("x"), "{}")), "unsupported")
}

// ---- encodings ------------------------------------------------------------
const allBytes = new Uint8Array(256).map((_, index) => index)
for (const encoding of ["hex", "base64", "base64url", "base32", "base32hex", "base58", "base58check", "quoted-printable", "uuencode"]) {
  const encoded = api.encode(encoding, allBytes, "{}")
  eq(api.decode(encoding, encoded, "{}"), allBytes, `${encoding} round trip`)
}
eq(api.decode("z85", api.encode("z85", allBytes.slice(0, 252), "{}"), "{}"), allBytes.slice(0, 252))
eq(ascii(api.encode("hex", text("Hi"), "{}")), "4869")
eq(ascii(api.encode("base64", text("Man"), "{}")), "TWFu")
eq(ascii(api.encode("base64url", new Uint8Array([0xfb, 0xff, 0xfe]), "{}")), "-__-")
eq(ascii(api.encode("base32", text("foo"), "{}")), "MZXW6===")
eq(ascii(api.encode("base58", text("Hello World!"), "{}")), "2NEpo7TZRRrLZSi2U")
eq(ascii(api.encode("z85", new Uint8Array([0x86, 0x4f, 0xd2, 0x6f, 0xb5, 0x59, 0xf7, 0x5b]), "{}")), "HelloWorld")
eq(api.decode("base64", text("TW Fu\n"), "{}"), text("Man"))
eq(api.decode("base64", text("TWE"), "{}"), text("Ma"))
eq(api.decode("hex", text("48 69"), "{}"), text("Hi"))
eq(api.decode("quoted-printable", text("a=3D=00=FFb"), "{}"), new Uint8Array([97, 61, 0, 255, 98]))
eq(ascii(api.encode("quoted-printable", new Uint8Array([120, 32, 10, 121, 32]), "{}")), "x =0Ay=20")

for (const [encoding, bad] of [
  ["hex", "zz"],
  ["hex", "123"],
  ["base64", "!!!*"],
  ["base58", "0OIl"],
]) {
  eq(thrownCode(() => api.decode(encoding, text(bad), "{}")), "decode_failed", `${encoding} rejects ${bad}`)
}
eq(thrownCode(() => api.encode("z85", text("abc"), "{}")), "invalid_input")
eq(thrownCode(() => api.decode("uuencode", text("no begin line"), "{}")), "invalid_input")

// ---- detect ----------------------------------------------------------------
function report(bytes) {
  const parsed = JSON.parse(api.detect(bytes))
  eq(parsed.schema_version, 1)
  eq(parsed.inputBytes, bytes.length)
  ok(Array.isArray(parsed.candidates))
  return parsed
}
const names = (parsed) => parsed.candidates.map((entry) => entry.name)

ok(names(report(new Uint8Array([0x1f, 0x8b, 0x08, 0, 0]))).includes("gzip"))
ok(names(report(new Uint8Array([0x78, 0x9c, 0, 0x11]))).includes("zlib"))
ok(!names(report(new Uint8Array([0x78, 0x9d, 0, 0x11]))).includes("zlib"), "bad FCHECK not zlib")
ok(names(report(new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0]))).includes("xz"))
ok(names(report(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x20]))).includes("zstd"))
ok(names(report(new Uint8Array([0x04, 0x22, 0x4d, 0x18, 0x64]))).includes("lz4"))
ok(names(report(text("BZh91AY&SY"))).includes("bzip2"))
ok(names(report(text("TWFu"))).includes("base64"))
ok(names(report(text("4869ab"))).includes("hex"))
ok(names(report(text("begin 644 x\n#0V%T\n`\nend\n"))).includes("uuencode"))
ok(names(report(text("a=3Db"))).includes("quoted-printable"))
eq(report(new Uint8Array(0)).primary, null)
eq(JSON.parse(api.detect(new Uint8Array(32 * 1024 * 1024 + 1))).error, "input_too_large")

// ---- limits ----------------------------------------------------------------
const oversized = new Uint8Array(32 * 1024 * 1024 + 1)
eq(thrownCode(() => api.decompress("gzip", oversized, "{}")), "input_too_large")
eq(thrownCode(() => api.compress("gzip", oversized, "{}")), "input_too_large")
eq(thrownCode(() => api.encode("hex", oversized, "{}")), "input_too_large")
eq(thrownCode(() => api.decode("base64", oversized, "{}")), "input_too_large")

const bigOptions = `{"pad":"${" ".repeat(4096)}"}`
eq(thrownCode(() => api.decompress("gzip", text("x"), bigOptions)), "options_too_large")
eq(thrownCode(() => api.encode("hex", text("x"), bigOptions)), "options_too_large")

for (const bad of ["{", "not json", "[1,2]", "null", '{"level":-1}', '{"level":"x"}']) {
  eq(thrownCode(() => api.encode("hex", text("x"), bad)), "invalid_options", `options ${bad}`)
}
ok(api.encode("hex", text("x"), "{}").length > 0)
ok(api.encode("hex", text("x"), "").length > 0)
ok(api.encode("hex", text("x"), "   ").length > 0)
ok(api.encode("hex", text("x"), '{"futureOption":123}').length > 0)

const compressedPayload = api.compress("gzip", payload(1 << 20), "{}")
eq(
  thrownCode(() => api.decompress("gzip", compressedPayload, '{"maxOutputBytes":1024}')),
  "output_too_large",
)
eq(
  thrownCode(() => api.decode("hex", api.encode("hex", new Uint8Array(2048), "{}"), '{"maxOutputBytes":1024}')),
  "output_too_large",
)
ok(api.decompress("gzip", compressedPayload, '{"expectedOutputBytes":1048576}').length > 0)

eq(thrownCode(() => api.decompress("rar", text("x"), "{}")), "unknown_algorithm")
eq(thrownCode(() => api.compress("zip", text("x"), "{}")), "unknown_algorithm")
eq(thrownCode(() => api.encode("rot13", text("x"), "{}")), "unknown_encoding")
eq(thrownCode(() => api.decode("rot13", text("x"), "{}")), "unknown_encoding")

// ---- truncation / corruption ------------------------------------------------
const gzipData = api.compress("gzip", payload(), "{}")
const zlibData = api.compress("zlib", payload(), "{}")
const deflateData = api.compress("deflate", payload(), "{}")
const brotliData = api.compress("brotli", payload(), "{}")
const lz4Data = api.compress("lz4", payload(), "{}")
const xzData = api.compress("xz", payload(), "{}")
const lzmaData = api.compress("lzma", payload(), "{}")
const lzma2Data = api.compress("lzma2", payload(), "{}")
for (const [algorithm, stream] of [
  ["gzip", gzipData],
  ["zlib", zlibData],
  ["deflate", deflateData],
  ["brotli", brotliData],
  ["lz4", lz4Data],
  ["xz", xzData],
  ["lzma", lzmaData],
  ["lzma2", lzma2Data],
  ["bzip2", BZIP2_FIXTURE],
  ["zstd", ZSTD_BLOCKS],
]) {
  for (const cut of [Math.floor(stream.length / 2), stream.length - 1]) {
    ok(
      thrownCode(() => api.decompress(algorithm, stream.slice(0, cut), "{}")).length > 0,
      `${algorithm} truncated at ${cut} fails`,
    )
  }
}

// wrong algorithm on gzip bytes must fail for every decoder
for (const algorithm of ["zlib", "deflate", "brotli", "lz4", "xz", "lzma", "lzma2", "zstd", "bzip2"]) {
  ok(
    thrownCode(() => api.decompress(algorithm, gzipData, "{}")).length > 0,
    `${algorithm} rejects gzip bytes`,
  )
}

// garbage input: no panics, always a structured error or an answer
let seed = 0x12345678
for (let index = 0; index < 256; index += 1) {
  const garbage = new Uint8Array(64)
  for (let offset = 0; offset < garbage.length; offset += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0
    garbage[offset] = seed >>> 24
  }
  for (const algorithm of ["gzip", "zlib", "deflate", "brotli", "lz4", "lz4-block", "xz", "lzma", "lzma2", "zstd", "bzip2"]) {
    try {
      api.decompress(algorithm, garbage, "{}")
    } catch (error) {
      eq(JSON.parse(error.message).schema_version, 1)
    }
  }
}

// determinism on detect and a repeated decompress
eq(api.detect(text("TWFu")), api.detect(text("TWFu")))
eq(api.decompress("gzip", gzipData, "{}"), api.decompress("gzip", gzipData, "{}"))

console.log(`codec WASM verified (${checks} checks)`)
