#!/usr/bin/env bun

import path from "node:path"
import { cp, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import { Worker } from "node:worker_threads"

const outputRoot = path.resolve("out/main/chunks/binwalk-scan")
const workerPath = path.join(outputRoot, "binwalk-scan-worker.js")
const required = [
  workerPath,
  "package.json",
  "dist/turen_binwalk_scan_wasm.js",
  "dist/turen_binwalk_scan_wasm.d.ts",
  "dist/turen_binwalk_scan_wasm_bg.wasm",
]

for (const file of required) {
  const target = path.isAbsolute(file) ? file : path.join(outputRoot, file)
  if (await Bun.file(target).exists()) continue
  throw new Error(`Desktop binwalk-scan artifact is missing: ${target}`)
}

const metadata = await Bun.file(path.join(outputRoot, "package.json")).json()
if (metadata.name !== "@turenlabs/binwalk-scan-wasm" || metadata.type !== "module")
  throw new Error(`Desktop binwalk-scan metadata is invalid: ${JSON.stringify(metadata)}`)

const isolated = await mkdtemp(path.join(os.tmpdir(), "turen-binwalk-scan-"))
await cp(outputRoot, isolated, { recursive: true })
const input = new Uint8Array(64)
input.set(new TextEncoder().encode("HDR0"))
new DataView(input.buffer).setUint32(4, 28, true)
const worker = new Worker(path.join(isolated, "binwalk-scan-worker.js"))
try {
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      worker.once("error", reject)
      worker.once("exit", (code) => {
        if (code !== 0) reject(new Error(`Desktop binwalk scan worker exited with code ${code}`))
      })
      worker.once("message", (message) => {
        if (message.type === "failed") return reject(new Error(`Desktop binwalk scan worker failed: ${message.error}`))
        if (message.type !== "completed" || message.result?.findings?.[0]?.signature !== "broadcom-trx")
          return reject(new Error(`Desktop binwalk scan worker returned unexpected output: ${JSON.stringify(message)}`))
        resolve()
      })
      worker.postMessage({ bytes: input, options: { maxFindings: 16 } })
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Desktop binwalk scan worker timed out")), 20_000)),
  ])
} finally {
  await worker.terminate()
  await rm(isolated, { recursive: true, force: true })
}

console.log("Desktop binwalk-scan artifact verified")
