#!/usr/bin/env bun

import path from "node:path"
import { Worker } from "node:worker_threads"

const workerPath = path.resolve("out/main/chunks/yara-worker.js")
const required = [
  workerPath,
  path.resolve("out/main/chunks/yara-x/package.json"),
  path.resolve("out/main/chunks/yara-x/dist/yara_x_js.js"),
  path.resolve("out/main/chunks/yara-x/dist/yara_x_js_bg.wasm"),
]

for (const file of required) {
  if (await Bun.file(file).exists()) continue
  throw new Error(`Desktop YARA artifact is missing: ${file}`)
}

const worker = new Worker(workerPath)
let timer: ReturnType<typeof setTimeout> | undefined
try {
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      worker.on("error", reject)
      worker.on("exit", (code) => {
        if (code !== 0) reject(new Error(`Desktop YARA worker exited with code ${code}`))
      })
      worker.on("message", (message) => {
        if (message.type === "failed") return reject(new Error(`Desktop YARA worker failed: ${message.error}`))
        const matches = message.result?.matches
        if (!Array.isArray(matches) || matches[0]?.identifier !== "desktop_yara")
          return reject(new Error(`Desktop YARA worker returned unexpected output: ${JSON.stringify(message)}`))
        resolve()
      })
      worker.postMessage({
        bytes: new TextEncoder().encode("abc"),
        rules: 'rule desktop_yara { strings: $a = "abc" condition: $a }',
        timeoutMs: 1_000,
        maxMatchesPerPattern: 1,
        maxRules: 1,
      })
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Desktop YARA worker timed out")), 15_000)
    }),
  ])
} finally {
  clearTimeout(timer)
  await worker.terminate()
}

console.log("Desktop YARA artifact verified")
