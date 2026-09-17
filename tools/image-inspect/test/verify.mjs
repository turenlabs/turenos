import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { deflateSync } from "node:zlib"

const directory = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, "../pkg"))
const api = await import(pathToFileURL(path.join(directory, "turen_image_inspect_wasm.js")).href)
await api.default({ module_or_path: await readFile(path.join(directory, "turen_image_inspect_wasm_bg.wasm")) })

const encoder = new TextEncoder()

// Minimal CRC32 (PNG uses the reflected polynomial).
const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
const crc32 = (bytes) => {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const u32be = (value) => {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value)
  return out
}

const pngChunk = (type, payload) => {
  const typed = encoder.encode(type)
  const chunk = concat(u32be(payload.length), typed, payload)
  return concat(chunk, u32be(crc32(chunk.subarray(4))))
}

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// 2x2 RGB8 PNG: IHDR, one tEXt, one IDAT, IEND.
const ihdr = new Uint8Array(13)
new DataView(ihdr.buffer).setUint32(0, 2)
new DataView(ihdr.buffer).setUint32(4, 2)
ihdr[8] = 8 // bit depth
ihdr[9] = 2 // color type: truecolor
const scanlines = concat(
  new Uint8Array([0, 255, 0, 0, 0, 255, 0]),
  new Uint8Array([0, 0, 0, 255, 255, 255, 0]),
)
const png = concat(
  PNG_SIGNATURE,
  pngChunk("IHDR", ihdr),
  pngChunk("tEXt", encoder.encode("Comment\x00hidden payload")),
  pngChunk("IDAT", deflateSync(scanlines)),
  pngChunk("IEND", new Uint8Array(0)),
)

// 4x4 baseline JPEG (ffmpeg-generated, carries a COM marker "Lavc62.28.101").
const jpeg = new Uint8Array(
  Buffer.from(
    "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMQD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYG" +
      "BgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABoAAEBAAAAAAAAAAAAAAA" +
      "AAAACBgEBAQAAAAAAAAAAAAAAAAAABAYQAAEFAAMAAwEAAAAAAAAAAAMBBgQFAgAREnaxEzMRAAEEAQQBBQEA" +
      "AAAAAAAAAAMEAgUBBgARBxMSdrQ3dbU2/8AAEQgABAAEAwESAAISAAMSAP/aAAwDAQACEQMRAD8AnnCS3bUdu" +
      "wqW/cFVGVu1JVjwbE0MClUSj2VRRvzwpC+E0XfXrWu1Xifv9G58aqfovKzieBw/L8OFKTWHYhILbWyKd6hTCI" +
      "lJiMTKiBZbyqRlI51tbu67dt5Xd1VaRwD8dB+1mv0DaXGxbVsrlSEitbVQuSScOE7DbKVacPUYD1pLZfaVOI7" +
      "UQHNaxo0SZOFrdh6VA/0/JHrmX9sh1//Z",
    "base64",
  ),
)

const parse = (text) => JSON.parse(text)
const ok = (text) => {
  const value = parse(text)
  assert.equal(value.error, undefined, text)
  return value
}
const failing = (text, code) => {
  const value = parse(text)
  assert.equal(value.schema_version, 1, text)
  assert.equal(value.error, code, text)
  return value
}

// ---- image_inspect: PNG ----
const pngReport = ok(api.image_inspect(png, "{}"))
assert.equal(pngReport.schema_version, 1)
assert.equal(pngReport.format, "png")
assert.equal(pngReport.width, 2)
assert.equal(pngReport.height, 2)
assert.equal(pngReport.bit_depth, 8)
assert.equal(pngReport.color_type, "rgb")
assert.equal(pngReport.chunks.length, 4)
assert.deepEqual(
  pngReport.chunks.map((chunk) => chunk.name),
  ["IHDR", "tEXt", "IDAT", "IEND"],
)
assert.ok(pngReport.chunks.every((chunk) => chunk.crc_valid === true))
assert.equal(pngReport.chunks[1].offset, 33)
assert.equal(pngReport.trailing_bytes, null)
assert.equal(pngReport.exif_present, false)
assert.equal(pngReport.text_chunks.length, 1)
assert.equal(pngReport.text_chunks[0].keyword, "Comment")
assert.equal(pngReport.text_chunks[0].text, "hidden payload")
assert.equal(pngReport.input_size, png.length)
assert.match(pngReport.input_sha256, /^[0-9a-f]{64}$/)

// ---- image_inspect: JPEG ----
const jpegReport = ok(api.image_inspect(jpeg, "{}"))
assert.equal(jpegReport.format, "jpeg")
assert.equal(jpegReport.width, 4)
assert.equal(jpegReport.height, 4)
assert.ok(jpegReport.segments.length >= 4)
assert.equal(jpegReport.segments[0].name, "SOI")
assert.ok(jpegReport.segments.some((segment) => segment.name === "COM"))
assert.ok(jpegReport.segments.some((segment) => segment.name.startsWith("SOF")))
assert.ok(jpegReport.segments.some((segment) => segment.name === "SOS"))

// ---- image_exif ----
const noExif = ok(api.image_exif(png, "{}"))
assert.equal(noExif.format, "png")
assert.equal(noExif.exif_present, false)
const jpegExif = ok(api.image_exif(jpeg, "{}"))
assert.equal(jpegExif.format, "jpeg")
assert.equal(jpegExif.exif_present, false)

// ---- image_text_chunks ----
const pngText = ok(api.image_text_chunks(png, "{}"))
assert.equal(pngText.format, "png")
assert.equal(pngText.entries.length, 1)
assert.equal(pngText.entries[0].location, "png:tEXt")
assert.equal(pngText.entries[0].keyword, "Comment")
assert.equal(pngText.entries[0].text, "hidden payload")
const jpegText = ok(api.image_text_chunks(jpeg, "{}"))
assert.equal(jpegText.format, "jpeg")
assert.ok(jpegText.entries.some((entry) => entry.location === "jpeg:COM" && entry.text.includes("Lavc")))

// ---- image_pixel_stats ----
const pngStats = ok(api.image_pixel_stats(png, "{}"))
assert.equal(pngStats.format, "png")
assert.equal(pngStats.width, 2)
assert.equal(pngStats.height, 2)
assert.equal(pngStats.decoded, true)
assert.equal(pngStats.luma_histogram.length, 16)
assert.equal(
  pngStats.luma_histogram.reduce((a, b) => a + b, 0),
  pngStats.sampled_pixels,
)
assert.ok(pngStats.channel_means.red > 0)
assert.ok(pngStats.channel_means.alpha > 0)
const jpegStats = ok(api.image_pixel_stats(jpeg, "{}"))
assert.equal(jpegStats.format, "jpeg")
assert.equal(jpegStats.width, 4)
assert.equal(jpegStats.height, 4)
assert.equal(jpegStats.luma_histogram.length, 16)

// Pixel decode refuses non-PNG/JPEG formats.
const gif = encoder.encode("GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;")
failing(api.image_pixel_stats(gif, "{}"), "unsupported_format")

// Pixel decode refuses oversized declared dimensions before decoding.
const hugeIhdr = new Uint8Array(13)
new DataView(hugeIhdr.buffer).setUint32(0, 5000)
new DataView(hugeIhdr.buffer).setUint32(4, 5000)
hugeIhdr[8] = 8
hugeIhdr[9] = 2
const hugePng = concat(PNG_SIGNATURE, pngChunk("IHDR", hugeIhdr), pngChunk("IEND", new Uint8Array(0)))
const refused = failing(api.image_pixel_stats(hugePng, "{}"), "image_too_large")
assert.equal(refused.width, 5000)

// ---- error paths ----
failing(api.image_inspect(new Uint8Array(0), "{}"), "empty_input")
failing(api.image_inspect(new Uint8Array([1, 2, 3, 4, 5]), "{}"), "unknown_format")
failing(api.image_inspect(png, "["), "invalid_options")
failing(api.image_inspect(png, "[]"), "invalid_options")
failing(api.image_inspect(png, `{${" ".repeat(4100)}}`), "options_too_large")
const tooBig = new Uint8Array(33_554_433)
tooBig.set(PNG_SIGNATURE)
failing(api.image_inspect(tooBig, "{}"), "input_too_large")

// Options must apply: include_text drops text collection.
const noText = ok(api.image_inspect(png, '{"include_text":false}'))
assert.equal(noText.text_chunks.length, 0)
assert.equal(noText.texts_total, 1)

// Truncated input inside a chunk reports structural anomalies, not a panic.
const truncated = ok(api.image_inspect(png.subarray(0, png.length - 4), "{}"))
assert.equal(truncated.format, "png")
assert.ok(truncated.anomalies.length > 0)
const cutHeader = ok(api.image_inspect(png.subarray(0, 40), "{}"))
assert.equal(cutHeader.format, "png")
assert.ok(cutHeader.anomalies.some((anomaly) => anomaly.includes("truncated")))

// ---- determinism ----
assert.equal(api.image_inspect(png, "{}"), api.image_inspect(png, "{}"))
assert.equal(api.image_text_chunks(jpeg, "{}"), api.image_text_chunks(jpeg, "{}"))
assert.equal(api.image_pixel_stats(png, "{}"), api.image_pixel_stats(png, "{}"))
assert.equal(api.image_exif(jpeg, "{}"), api.image_exif(jpeg, "{}"))

console.log("image-inspect WASM compatibility verified")
