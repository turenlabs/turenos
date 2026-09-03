#!/usr/bin/env bun

import path from "node:path"

const sourceRoot = path.resolve("../protocol-inspect-wasm")
const outputRoot = path.resolve("out/main/chunks/protocol-inspect")
const required = [
  "protocol-inspect-worker.js",
  "package.json",
  "dist/turen_protocol_inspect_wasm.js",
  "dist/turen_protocol_inspect_wasm.d.ts",
  "dist/turen_protocol_inspect_wasm_bg.wasm",
]

for (const file of required) {
  if (await Bun.file(path.join(outputRoot, file)).exists()) continue
  throw new Error(`Desktop protocol-inspect artifact is missing: ${path.join(outputRoot, file)}`)
}

const metadata = await Bun.file(path.join(outputRoot, "package.json")).json()
if (
  metadata.name !== "@turenlabs/protocol-inspect-wasm" ||
  metadata.type !== "module" ||
  (metadata.main !== undefined && metadata.main !== "dist/turen_protocol_inspect_wasm.js") ||
  (metadata.types !== undefined && metadata.types !== "dist/turen_protocol_inspect_wasm.d.ts") ||
  (metadata.main === undefined &&
    !JSON.stringify(metadata.exports ?? "").includes("turen_protocol_inspect_wasm.js")) ||
  (metadata.exports !== undefined && !JSON.stringify(metadata.exports).includes("turen_protocol_inspect_wasm.js"))
)
  throw new Error(`Desktop protocol-inspect metadata is invalid: ${JSON.stringify(metadata)}`)

for (const file of required.filter((file) => file !== "protocol-inspect-worker.js")) {
  const source = await Bun.file(path.join(sourceRoot, file)).bytes()
  const output = await Bun.file(path.join(outputRoot, file)).bytes()
  if (source.length !== output.length || source.some((byte, index) => byte !== output[index]))
    throw new Error(`Desktop protocol-inspect artifact is not byte-identical to its package: ${file}`)
}

console.log("Desktop protocol-inspect artifact verified")
