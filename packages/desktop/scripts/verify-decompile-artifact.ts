#!/usr/bin/env bun

import path from "node:path"
import { Worker } from "node:worker_threads"
import { missingTreeSitterAssets, referencedWasmAssets } from "./wasm-assets"

const workerPath = path.resolve("out/main/chunks/decompiler-worker.js")
const required = [
  workerPath,
  path.resolve("out/main/chunks/ghidra-decompiler/package.json"),
  path.resolve("out/main/chunks/ghidra-decompiler/dist/ghidra_decompiler.js"),
  path.resolve("out/main/chunks/ghidra-decompiler/dist/ghidra_decompiler.wasm"),
  path.resolve("out/main/chunks/ghidra-decompiler/dist/Processors/x86/data/languages/x86-64.sla"),
]

for (const file of required) {
  if (await Bun.file(file).exists()) continue
  throw new Error(`Desktop decompile artifact is missing: ${file}`)
}

const mainOutput = path.resolve("out/main")
const wasmAssets = await referencedWasmAssets(mainOutput)
const missingParserRuntimes = missingTreeSitterAssets(wasmAssets)
if (missingParserRuntimes.length > 0)
  throw new Error(`Desktop Tree-sitter artifacts are missing: ${missingParserRuntimes.join(", ")}`)
for (const file of wasmAssets) {
  if (await Bun.file(path.join(mainOutput, file)).exists()) continue
  throw new Error(`Desktop bundle references a missing WASM artifact: ${file}`)
}

const lifecycle: string[] = []
const worker = new Worker(workerPath)

try {
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      worker.on("error", reject)
      worker.on("exit", (code) => {
        if (code !== 0) reject(new Error(`Desktop decompile worker exited with code ${code}`))
      })
      worker.on("message", (message) => {
        lifecycle.push(message.type)
        if (message.type === "failed") {
          reject(new Error(`Desktop decompile worker failed: ${message.error}`))
          return
        }
        if (message.type !== "completed") return
        if (!message.code.includes("return param_1 + param_2")) {
          reject(new Error(`Desktop decompile worker returned unexpected pseudo-C: ${message.code}`))
          return
        }
        resolve()
      })
      worker.postMessage({
        id: 1,
        input: {
          bytes: Uint8Array.from(Buffer.from("554889e5897dfc8975f88b45fc0345f85dc3", "hex")),
          architecture: "x86_64",
          endianness: "little",
          baseAddress: 0x1000,
          address: 0x1000,
        },
      })
    }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Desktop decompile worker timed out after lifecycle: ${lifecycle.join(" -> ")}`)),
        15_000,
      ),
    ),
  ])
} finally {
  await worker.terminate()
}

if (lifecycle.join(" -> ") !== "started -> completed")
  throw new Error(`Unexpected desktop decompile lifecycle: ${lifecycle.join(" -> ")}`)

console.log(`Desktop decompile artifact verified: ${lifecycle.join(" -> ")}`)
