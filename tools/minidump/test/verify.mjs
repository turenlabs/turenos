import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const directory = path.resolve(process.argv[2] ?? "")
const api = await import(pathToFileURL(path.join(directory, "turen_minidump_wasm.js")).href)
await api.default({
  module_or_path: await readFile(path.join(directory, "turen_minidump_wasm_bg.wasm")),
})

const inspect = (bytes, options = "{}") =>
  JSON.parse(api.minidump_inspect(bytes, options))
const stream = (bytes, options) => JSON.parse(api.minidump_stream(bytes, options))
const memRead = (bytes, options) => JSON.parse(api.minidump_memory_read(bytes, options))
const modules = (bytes, options = "{}") =>
  JSON.parse(api.minidump_modules(bytes, options))

// ---------------------------------------------------------------------------
// Fabricate a minimal MDMP in memory: header + 5 streams + tail blobs.
// Layout mirrors the Rust unit-test dump.
// ---------------------------------------------------------------------------
const STACK_BASE = 0x7fff0000
const STREAM_SYSINFO = 7
const STREAM_MODULES = 4
const STREAM_THREADS = 3
const STREAM_EXCEPTION = 6
const STREAM_MEMORY = 5

function utf16Blob(text) {
  const buf = Buffer.alloc(4 + text.length * 2)
  buf.writeUInt32LE(text.length * 2, 0)
  for (let i = 0; i < text.length; i++) buf.writeUInt16LE(text.charCodeAt(i), 4 + i * 2)
  return buf
}

function sampleDump() {
  const csd = utf16Blob("Service Pack 1")
  const name1 = utf16Blob("app.exe")
  const name2 = utf16Blob("ntdll.dll")
  const stack = Buffer.alloc(256, 0xab)
  const ctxLen = 716
  const ctx = Buffer.alloc(ctxLen)
  ctx.writeUInt32LE(0x00010007, 0) // CONTEXT_X86 | CONTROL | INTEGER | SEGMENTS
  ctx.writeUInt32LE(0x11223344, 176) // eax
  ctx.writeUInt32LE(0x00401234, 184) // eip
  ctx.writeUInt32LE(STACK_BASE + 0x80, 196) // esp
  const excCtx = Buffer.from(ctx)

  // stream sizes
  const sysinfoLen = 56
  const moduleLen = 4 + 2 * 108
  const threadLen = 4 + 48
  const exceptionLen = 168
  const memoryLen = 4 + 16
  const headerLen = 32
  const dirLen = 5 * 12
  let rva = headerLen + dirLen
  const sysinfoRva = rva
  rva += sysinfoLen
  const modulesRva = rva
  rva += moduleLen
  const threadsRva = rva
  rva += threadLen
  const exceptionRva = rva
  rva += exceptionLen
  const memoryRva = rva
  rva += memoryLen
  const csdRva = rva
  rva += csd.length
  const name1Rva = rva
  rva += name1.length
  const name2Rva = rva
  rva += name2.length
  const stackRva = rva
  rva += stack.length
  const ctxRva = rva
  rva += ctx.length
  const excCtxRva = rva

  const sysinfo = Buffer.alloc(sysinfoLen)
  sysinfo.writeUInt16LE(0, 0) // arch x86
  sysinfo.writeUInt16LE(6, 2) // level
  sysinfo.writeUInt16LE(0x1a01, 4) // revision
  sysinfo.writeUInt8(4, 6) // number_of_processors
  sysinfo.writeUInt8(1, 7) // product_type
  sysinfo.writeUInt32LE(10, 8) // major
  sysinfo.writeUInt32LE(0, 12) // minor
  sysinfo.writeUInt32LE(19045, 16) // build
  sysinfo.writeUInt32LE(2, 20) // platform WIN32_NT
  sysinfo.writeUInt32LE(csdRva, 24) // csd_version_rva
  sysinfo.writeUInt16LE(0x100, 28) // suite_mask

  const modList = Buffer.alloc(moduleLen)
  modList.writeUInt32LE(2, 0)
  const names = [name1Rva, name2Rva]
  for (let i = 0; i < 2; i++) {
    const off = 4 + i * 108
    modList.writeBigUInt64LE(BigInt(0x400000 + i * 0x100000), off)
    modList.writeUInt32LE(0x20000, off + 8) // size_of_image
    modList.writeUInt32LE(0, off + 12) // checksum
    modList.writeUInt32LE(0x5f00, off + 16) // time_date_stamp
    modList.writeUInt32LE(names[i], off + 20) // module_name_rva
  }

  const threads = Buffer.alloc(threadLen)
  threads.writeUInt32LE(1, 0)
  threads.writeUInt32LE(0x1234, 4) // thread_id
  threads.writeBigUInt64LE(BigInt(0x7ff00000), 20) // teb
  threads.writeBigUInt64LE(BigInt(STACK_BASE), 28) // stack start
  threads.writeUInt32LE(stack.length, 36)
  threads.writeUInt32LE(stackRva, 40)
  threads.writeUInt32LE(ctxLen, 44)
  threads.writeUInt32LE(ctxRva, 48)

  const exc = Buffer.alloc(exceptionLen)
  exc.writeUInt32LE(0x1234, 0) // thread_id
  exc.writeUInt32LE(0xc0000005, 8) // EXCEPTION_ACCESS_VIOLATION
  exc.writeBigUInt64LE(BigInt(0x00401234), 24) // exception_address
  exc.writeUInt32LE(2, 32) // number_parameters
  exc.writeBigUInt64LE(1n, 40) // info[0] = write
  exc.writeBigUInt64LE(BigInt(0xdeadbeef), 48) // info[1] = fault address
  exc.writeUInt32LE(ctxLen, 160)
  exc.writeUInt32LE(excCtxRva, 164)

  const mem = Buffer.alloc(memoryLen)
  mem.writeUInt32LE(1, 0)
  mem.writeBigUInt64LE(BigInt(STACK_BASE), 4)
  mem.writeUInt32LE(stack.length, 12)
  mem.writeUInt32LE(stackRva, 16)

  const streams = [
    [STREAM_SYSINFO, sysinfo, sysinfoRva],
    [STREAM_MODULES, modList, modulesRva],
    [STREAM_THREADS, threads, threadsRva],
    [STREAM_EXCEPTION, exc, exceptionRva],
    [STREAM_MEMORY, mem, memoryRva],
  ]

  const dump = Buffer.alloc(rva + excCtx.length)
  dump.write("MDMP", 0, "ascii")
  dump.writeUInt32LE(0xa793, 4) // version
  dump.writeUInt32LE(streams.length, 8) // stream_count
  dump.writeUInt32LE(headerLen, 12) // directory rva
  dump.writeUInt32LE(0, 16) // checksum
  dump.writeUInt32LE(1700000000, 20) // time_date_stamp
  streams.forEach(([type, data, at], i) => {
    const dOff = headerLen + i * 12
    dump.writeUInt32LE(type, dOff)
    dump.writeUInt32LE(data.length, dOff + 4)
    dump.writeUInt32LE(at, dOff + 8)
    data.copy(dump, at)
  })
  csd.copy(dump, csdRva)
  name1.copy(dump, name1Rva)
  name2.copy(dump, name2Rva)
  stack.copy(dump, stackRva)
  ctx.copy(dump, ctxRva)
  excCtx.copy(dump, excCtxRva)
  return new Uint8Array(dump)
}

const dump = sampleDump()

// --- inspect -----------------------------------------------------------------
{
  const out = inspect(dump)
  assert.equal(out.schema_version, 1)
  assert.equal(out.valid, true)
  assert.equal(out.endian, "little")
  assert.equal(out.header.signature, "0x504d444d")
  assert.equal(out.streams.count, 5)
  assert.equal(out.system_info.os, "windows")
  assert.equal(out.system_info.csd_version, "Service Pack 1")
  assert.equal(out.exception.exception_code, "0xc0000005")
  assert.equal(out.exception.crash_address, "0xdeadbeef")
  assert.equal(out.threads.count, 1)
  assert.equal(out.threads.items[0].thread_id, 0x1234)
  assert.equal(out.threads.items[0].context.instruction_pointer, "0x401234")
  assert.equal(out.modules.count, 2)
  assert.equal(out.modules.items[0].name, "app.exe")
  assert.equal(out.memory_regions.count, 1)
}

// --- stream ------------------------------------------------------------------
{
  const out = stream(dump, JSON.stringify({ stream: 7 }))
  assert.equal(out.decoded, true)
  assert.equal(out.content.os, "windows")
  const byName = stream(dump, JSON.stringify({ name: "ModuleListStream" }))
  assert.equal(byName.decoded, true)
  assert.equal(byName.content.count, 2)
  const hexSel = stream(dump, JSON.stringify({ stream: "0x4" }))
  assert.equal(hexSel.decoded, true)
  const missing = stream(dump, JSON.stringify({ stream: 99 }))
  assert.equal(missing.error, "stream_not_found")
  const absent = stream(dump, "{}")
  assert.equal(absent.error, "missing_stream")
}

// --- memory_read --------------------------------------------------------------
{
  const hit = memRead(
    dump,
    JSON.stringify({ address: `0x${STACK_BASE.toString(16)}`, length: 16 }),
  )
  assert.equal(hit.coverage, "full")
  assert.equal(hit.bytes_read, 16)
  assert.equal(hit.region.source, "memory_list")
  assert.equal(Buffer.from(hit.data_base64, "base64").length, 16)
  const partial = memRead(
    dump,
    JSON.stringify({ address: `0x${STACK_BASE.toString(16)}`, length: 300 }),
  )
  assert.equal(partial.coverage, "partial")
  assert.equal(partial.bytes_read, 256)
  const miss = memRead(dump, JSON.stringify({ address: "0x41414141", length: 16 }))
  assert.equal(miss.error, "unmapped_address")
  const badAddr = memRead(dump, JSON.stringify({ length: 16 }))
  assert.equal(badAddr.error, "invalid_address")
  const tooLong = memRead(dump, JSON.stringify({ address: "0x1000", length: 70000 }))
  assert.equal(tooLong.error, "invalid_length")
}

// --- modules -------------------------------------------------------------------
{
  const out = modules(dump)
  assert.equal(out.schema_version, 1)
  assert.equal(out.count, 2)
  assert.equal(out.items[1].name, "ntdll.dll")
}

// --- malformed / hostile input -------------------------------------------------
{
  const bad = new Uint8Array(64)
  bad.set([0x4e, 0x4f, 0x50, 0x45], 0)
  assert.equal(inspect(bad).error, "parse_failed")
  assert.equal(inspect(new Uint8Array(8)).error, "parse_failed")

  // directory beyond EOF
  const d = Buffer.alloc(32)
  d.write("MDMP", 0, "ascii")
  d.writeUInt32LE(0xa793, 4)
  d.writeUInt32LE(4, 8)
  d.writeUInt32LE(0xfffffff0, 12)
  assert.equal(inspect(new Uint8Array(d)).error, "parse_failed")

  // hostile UTF-16 RVA is neutralized, not a panic
  const hostile = Buffer.from(dump)
  const strRva = hostile.length
  hostile.writeUInt32LE(strRva, 92 + 24) // csd_version_rva
  const ext = Buffer.concat([hostile, Buffer.from([0, 0xff, 0xff, 0xff, 0, 0, 0, 0])])
  const out = inspect(new Uint8Array(ext))
  assert.equal(out.valid, true)
  assert.equal(out.system_info.csd_version, null)
}

// --- caps ----------------------------------------------------------------------
{
  const big = new Uint8Array(32 * 1024 * 1024 + 1)
  assert.equal(inspect(big).error, "input_too_large")
  const bigOpts = JSON.stringify({ pad: "x".repeat(4096) })
  assert.equal(inspect(dump, bigOpts).error, "options_too_large")
  assert.equal(inspect(dump, "{not json").error, "options_invalid")
}

// --- determinism -----------------------------------------------------------------
{
  const first = api.minidump_inspect(dump, "{}")
  for (let i = 0; i < 3; i++) assert.equal(api.minidump_inspect(dump, "{}"), first)
  const opts = JSON.stringify({ address: `0x${STACK_BASE.toString(16)}`, length: 16 })
  const firstRead = api.minidump_memory_read(dump, opts)
  for (let i = 0; i < 3; i++) assert.equal(api.minidump_memory_read(dump, opts), firstRead)
}

console.log("verify.mjs: all real-WASM checks passed")
