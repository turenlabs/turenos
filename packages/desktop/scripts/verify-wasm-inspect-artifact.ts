#!/usr/bin/env bun

import path from "node:path"
import { Worker } from "node:worker_threads"

const root = path.resolve("out/main/chunks")
const workerPath = path.join(root, "wasm-inspect-worker.js")
const required = [
  workerPath,
  path.join(root, "wasm-inspect/package.json"),
  path.join(root, "wasm-inspect/dist/turen_wasm_inspect_wasm.js"),
  path.join(root, "wasm-inspect/dist/turen_wasm_inspect_wasm.d.ts"),
  path.join(root, "wasm-inspect/dist/turen_wasm_inspect_wasm_bg.wasm"),
]

for (const file of required) {
  if (await Bun.file(file).exists()) continue
  throw new Error(`Desktop WASM inspect artifact is missing: ${file}`)
}

const input = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
const worker = new Worker(workerPath)
let timer: ReturnType<typeof setTimeout> | undefined
try {
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      worker.once("error", reject)
      worker.once("exit", (code) => {
        if (code !== 0) reject(new Error(`Desktop WASM inspect worker exited with code ${code}`))
      })
      worker.once("message", (message) => {
        if (message.type === "failed") {
          reject(new Error(`Desktop WASM inspect worker failed: ${message.error}`))
          return
        }
        const result = message.result
        if (message.type !== "completed" || result?.valid !== true || result.input_bytes !== input.length) {
          reject(new Error(`Desktop WASM inspect worker returned unexpected output: ${JSON.stringify(message)}`))
          return
        }
        resolve()
      })
      worker.postMessage({ bytes: input, options: { maxSections: 16 } })
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Desktop WASM inspect worker timed out")), 15_000)
    }),
  ])
} finally {
  clearTimeout(timer)
  await worker.terminate()
}

console.log("Desktop WASM inspect artifact verified")
