#!/usr/bin/env bun

import assert from "node:assert/strict"
import path from "node:path"
import { Worker } from "node:worker_threads"

const root = path.resolve("out/main/chunks")
const staticWorker = path.join(root, "static-analysis/static-analysis-worker.js")
const emailWorker = path.join(root, "email-security-worker.js")
const extensionWasm = "static-analysis/dist/extensions/turen_static_analysis_wasm_bg.wasm"
const emailWasm = "email-security/dist/turen_email_security_wasm_bg.wasm"
const required = [
  "static-analysis/static-analysis-worker.js",
  "email-security-worker.js",
  "static-analysis/package.json",
  "static-analysis/dist/turen_static_analysis_wasm.js",
  "static-analysis/dist/turen_static_analysis_wasm_bg.wasm",
  "static-analysis/dist/extensions/turen_static_analysis_wasm.js",
  extensionWasm,
  "static-analysis/SOURCE-106.json",
  "static-analysis/LICENSE-DIE",
  "static-analysis/THIRD-PARTY-106.txt",
  "email-security/package.json",
  "email-security/dist/turen_email_security_wasm.js",
  emailWasm,
  "email-security/SOURCE-106.json",
]
for (const file of required) {
  assert(await Bun.file(path.join(root, file)).exists(), `Desktop security artifact is missing: ${file}`)
}
verifyMemory(new Uint8Array(await Bun.file(path.join(root, extensionWasm)).arrayBuffer()), extensionWasm)

const arm = record(
  await run(staticWorker, {
    operation: "disassemble",
    bytes: Buffer.from("1f2003d5c0035fd6", "hex"),
    options: { architecture: "arm64", offset: 0, length: 8 },
  }),
)
assert(Array.isArray(arm.instructions), "ARM64 instructions missing")
assert.equal(arm.instructions.length, 2)
assert.match(String(record(arm.instructions[0]).text), /^nop(?:\s|$)/i)
assert.match(String(record(arm.instructions[1]).text), /^ret(?:\s|$)/i)

const flow = record(
  await run(staticWorker, {
    operation: "function_flow",
    bytes: Buffer.from("90c3", "hex"),
    options: { architecture: "x86", bitness: 64, offset: 0, length: 2 },
  }),
)
assert(Array.isArray(flow.blocks) && flow.blocks.length === 1, "Expected one x86 basic block")
assert.equal(record(flow.blocks[0]).instructionCount, 2)
assert(
  Array.isArray(flow.edges) && flow.edges.some((edge: unknown) => record(edge).kind === "return"),
  "Return edge missing",
)

const packer = record(await run(staticWorker, { operation: "detect_packer", bytes: Buffer.from("UPX!") }))
assert(
  Array.isArray(packer.matches) &&
    packer.matches.some((match: unknown) => {
      const indicator = record(match)
      return (
        indicator.name === "UPX" &&
        Array.isArray(indicator.evidence) &&
        indicator.evidence.some((entry: unknown) => {
          const evidence = record(entry)
          return evidence.kind === "raw_marker" && evidence.marker === "UPX!" && evidence.offset === 0
        })
      )
    }),
  "Raw UPX indicator missing",
)

// Regular SysV ar member: fixed-width 60-byte header and even-sized content.
const arHeader = [
  ["hello.txt/", 16],
  ["0", 12],
  ["0", 6],
  ["0", 6],
  ["100644", 8],
  ["2", 10],
] as const
const archive = record(
  await run(staticWorker, {
    operation: "list_archive",
    bytes: Buffer.from(`!<arch>\n${arHeader.map(([value, width]) => value.padEnd(width)).join("")}\x60\nhi`),
  }),
)
assert.equal(archive.format, "ar")
assert.deepEqual(archive.entries, [{ index: 0, name: "hello.txt", size: 2, directory: false }])

const attachment = await run(emailWorker, {
  kind: "extract",
  input: {
    bytes: new TextEncoder().encode(
      [
        "From: alice@example.test",
        "To: bob@example.test",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="desktop-boundary"',
        "",
        "--desktop-boundary",
        "Content-Type: text/plain",
        "",
        "Desktop attachment smoke test",
        "--desktop-boundary",
        'Content-Type: application/octet-stream; name="tiny.bin"',
        'Content-Disposition: attachment; filename="tiny.bin"',
        "Content-Transfer-Encoding: base64",
        "",
        "AQID",
        "--desktop-boundary--",
        "",
      ].join("\r\n"),
    ),
    index: 0,
    maxOutputBytes: 3,
  },
})
assert(attachment instanceof Uint8Array, "Attachment result must contain bytes")
assert.deepEqual(Array.from(attachment), [1, 2, 3])
console.log("Desktop security extensions artifact verified")

function record(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "Expected worker result object")
  return value as Record<string, unknown>
}

async function run(workerPath: string, request: unknown): Promise<unknown> {
  const worker = new Worker(workerPath)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<unknown>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${workerPath} timed out`)), 15_000)
      worker.once("error", reject)
      worker.once("exit", (code) => reject(new Error(`${workerPath} exited before completing (code ${code})`)))
      worker.once("message", (message: unknown) => {
        if (message === null || typeof message !== "object" || !("type" in message)) {
          reject(new Error(`${workerPath} returned an invalid message`))
          return
        }
        if (message.type === "completed" && "result" in message)
          return resolve(workerPath === staticWorker ? record(message.result).result : message.result)
        reject(new Error(`${workerPath} failed: ${JSON.stringify(message)}`))
      })
      worker.postMessage(request)
    })
  } finally {
    clearTimeout(timer)
    await worker.terminate()
  }
}

function verifyMemory(bytes: Uint8Array, file: string) {
  // Validate without instantiation, then inspect the defined memory limits. Imported
  // memory is forbidden so no host-provided memory can bypass this check.
  const module = new WebAssembly.Module(bytes)
  assert(!WebAssembly.Module.imports(module).some((entry) => entry.kind === "memory"), `${file}: imported memory`)
  let offset = 8
  let end = bytes.length
  function u32() {
    let value = 0
    for (let shift = 0; shift <= 28; shift += 7) {
      assert(offset < end, `${file}: truncated LEB128`)
      const byte = bytes[offset++]!
      assert(shift !== 28 || byte <= 15, `${file}: invalid u32`)
      value += (byte & 127) * 2 ** shift
      if (!(byte & 128)) return value
    }
    throw new Error(`${file}: invalid LEB128`)
  }
  while (offset < bytes.length) {
    const section = bytes[offset++]!
    const size = u32()
    end = offset + size
    assert(end <= bytes.length, `${file}: truncated section`)
    if (section === 5) {
      assert.equal(u32(), 1, `${file}: expected exactly one memory`)
      assert.equal(u32(), 1, `${file}: expected unshared wasm32 memory with an explicit maximum`)
      const initial = u32()
      const maximum = u32()
      assert(initial <= maximum && maximum <= 4096, `${file}: memory exceeds 256 MiB`)
      assert.equal(offset, end, `${file}: unexpected memory metadata`)
      return
    }
    offset = end
    end = bytes.length
  }
  throw new Error(`${file}: memory section missing`)
}
