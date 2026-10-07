import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

export async function verifyWal(api) {
  const inspect = (bytes, options = {}) => JSON.parse(api.sqlite_wal_inspect(bytes, JSON.stringify(options)))
  const native = await readFile(new URL("./fixtures/native-512.wal", import.meta.url))
  for (const size of [512, 65536]) {
    const bytes = await readFile(new URL(`./fixtures/native-${size}.wal`, import.meta.url))
    const value = inspect(bytes)
    assert.equal(value.error, undefined)
    assert.equal(value.header.pageSize, size)
    assert.equal(value.header.checksumValid, true)
    assert.equal(value.validFrames, 4)
    assert.equal(value.completeFrames, 4)
    assert.equal(value.commitMarkers, 3)
    assert.deepEqual(value.lastCommit, { frame: 4, databasePages: 2 })
    assert.equal(value.uncommittedFrames, 0)
    assert.equal(value.invalidFrame, null)
    assert.equal(value.trailingBytes, 0)
    assert.equal(value.replayed, false)
  }

  // Re-encode checksums for the opposite-endian format and an uncommitted tail.
  const rewrite = (input, little) => {
    const bytes = Buffer.from(input)
    bytes.writeUInt32BE(little ? 0x377f0682 : 0x377f0683, 0)
    let s0 = 0, s1 = 0
    const add = (data) => {
      for (let i = 0; i < data.length; i += 8) {
        const x0 = little ? data.readUInt32LE(i) : data.readUInt32BE(i)
        const x1 = little ? data.readUInt32LE(i + 4) : data.readUInt32BE(i + 4)
        s0 = (s0 + x0 + s1) >>> 0
        s1 = (s1 + x1 + s0) >>> 0
      }
    }
    add(bytes.subarray(0, 24))
    bytes.writeUInt32BE(s0, 24)
    bytes.writeUInt32BE(s1, 28)
    const stride = bytes.readUInt32BE(8) + 24
    for (let i = 32; i + stride <= bytes.length; i += stride) {
      add(bytes.subarray(i, i + 8))
      add(bytes.subarray(i + 24, i + stride))
      bytes.writeUInt32BE(s0, i + 16)
      bytes.writeUInt32BE(s1, i + 20)
    }
    return bytes
  }
  for (const little of [true, false]) {
    const value = inspect(rewrite(native, little))
    assert.equal(value.validFrames, 4)
    assert.equal(value.header.checksumByteOrder, little ? "little-endian" : "big-endian")
  }
  const tail = Buffer.from(native)
  tail.writeUInt32BE(0, 32 + 3 * 536 + 4)
  const uncommitted = inspect(rewrite(tail, true))
  assert.deepEqual(uncommitted.lastCommit, { frame: 3, databasePages: 2 })
  assert.equal(uncommitted.uncommittedFrames, 1)
  assert.equal(uncommitted.commitMarkers, 2)

  for (const [offset, reason] of [[32 + 3 * 536 + 8, "salt_mismatch"], [32 + 3 * 536 + 24, "checksum_mismatch"]]) {
    const bad = Buffer.from(native)
    bad[offset] ^= 1
    const value = inspect(bad)
    assert.equal(value.validFrames, 3)
    assert.equal(value.invalidFrame.reason, reason)
    assert.deepEqual(value.lastCommit, { frame: 3, databasePages: 2 })
  }
  const badHeader = Buffer.from(native)
  badHeader[24] ^= 1
  assert.equal(inspect(badHeader).header.checksumValid, false)
  assert.equal(inspect(badHeader).validFrames, 0)
  assert.equal(inspect(badHeader).lastCommit, null)

  const partial = inspect(native.subarray(0, native.length - 1))
  assert.equal(partial.validFrames, 3)
  assert.equal(partial.trailingBytes, 535)
  assert.equal(partial.lastCommit.frame, 3)
  const capped = inspect(native, { maxItems: 1 })
  assert.equal(capped.frames.length, 1)
  assert.equal(capped.truncated, true)
  assert.equal(capped.validFrames, 4)
  assert.equal(capped.lastCommit.frame, 4)
  const many = Buffer.alloc(32 + 4200 * 536)
  native.copy(many, 0, 0, 32)
  for (let i = 0; i < 4200; i++) native.copy(many, 32 + i * 536, 32 + 3 * 536)
  const hardCap = inspect(rewrite(many, true), { maxItems: 100000 })
  assert.equal(hardCap.frames.length, 4096)
  assert.equal(hardCap.validFrames, 4200)
  assert.equal(hardCap.lastCommit.frame, 4200)
  assert.equal(hardCap.truncated, true)
  assert.ok(JSON.stringify(hardCap).length < 4 * 1024 * 1024)
  const brokenPrefix = Buffer.from(native)
  brokenPrefix[32 + 536 + 24] ^= 1
  const stopped = inspect(brokenPrefix)
  assert.equal(stopped.validFrames, 1)
  assert.equal(stopped.lastCommit, null)
  assert.equal(stopped.invalidFrame.frame, 2)
  assert.equal(inspect(native.subarray(0, 32)).validFrames, 0)
  assert.equal(inspect(new Uint8Array()).error, "empty_input")
  assert.equal(inspect(new Uint8Array(33 * 1024 * 1024)).error, "input_too_large")
  assert.equal(inspect(native, { maxItems: -1 }).error, "invalid_options")
  assert.equal(JSON.parse(api.sqlite_wal_inspect(native, "{")).error, "invalid_options")
  assert.equal(JSON.parse(api.sqlite_wal_inspect(native, " ".repeat(4097))).error, "options_too_large")
  for (const page of [0, 1, 513, 131072]) {
    const bad = Buffer.from(native)
    bad.writeUInt32BE(page, 8)
    assert.equal(inspect(bad).error, "invalid_page_size")
  }
  const badVersion = Buffer.from(native)
  badVersion.writeUInt32BE(1, 4)
  assert.equal(inspect(badVersion).error, "unsupported_wal_version")
  for (const page of [0, 0xffffffff]) {
    const bad = Buffer.from(native)
    bad.writeUInt32BE(page, 32)
    const value = inspect(rewrite(bad, true))
    assert.equal(value.validFrames, 0)
    assert.equal(value.invalidFrame.reason, "invalid_page_number")
  }
  for (let length = 0; length < native.length; length += 7) {
    const value = inspect(native.subarray(0, length))
    assert.equal(value.schema_version, 1)
    assert.notEqual(value.error, "internal_error")
  }
  for (let offset = 0; offset < native.length; offset += 7) {
    const bad = Buffer.from(native)
    bad[offset] ^= 0xff
    const value = inspect(bad)
    assert.equal(value.schema_version, 1)
    assert.notEqual(value.error, "internal_error")
  }
  console.log("sqlite_wal_inspect: native SQLite fixtures, both checksum byte orders, commit boundaries, corruption, limits, and 600+ malformed inputs passed")
}
