#!/usr/bin/env bun

import path from "node:path"

const sourceRoot = path.resolve("../debug-symbols-wasm")
const outputRoot = path.resolve("out/main/chunks/debug-symbols")
const required = [
  "debug-symbols-worker.js",
  "package.json",
  "dist/turen_debug_symbols_wasm.js",
  "dist/turen_debug_symbols_wasm.d.ts",
  "dist/turen_debug_symbols_wasm_bg.wasm",
]

for (const file of required) {
  if (await Bun.file(path.join(outputRoot, file)).exists()) continue
  throw new Error(`Desktop debug-symbols artifact is missing: ${path.join(outputRoot, file)}`)
}

const metadata = await Bun.file(path.join(outputRoot, "package.json")).json()
if (
  metadata.name !== "@turenlabs/debug-symbols-wasm" ||
  metadata.type !== "module" ||
  metadata.main !== "dist/turen_debug_symbols_wasm.js" ||
  metadata.types !== "dist/turen_debug_symbols_wasm.d.ts"
)
  throw new Error(`Desktop debug-symbols metadata is invalid: ${JSON.stringify(metadata)}`)

for (const file of required.filter((file) => file !== "debug-symbols-worker.js")) {
  const source = await Bun.file(path.join(sourceRoot, file)).bytes()
  const output = await Bun.file(path.join(outputRoot, file)).bytes()
  if (source.length !== output.length || source.some((byte, index) => byte !== output[index]))
    throw new Error(`Desktop debug-symbols artifact is not byte-identical to its package: ${file}`)
}

console.log("Desktop debug-symbols artifact verified")
