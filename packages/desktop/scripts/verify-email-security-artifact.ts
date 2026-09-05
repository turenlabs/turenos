#!/usr/bin/env bun

import path from "node:path"
import { Worker } from "node:worker_threads"

const root = path.resolve("out/main/chunks")
const workerPath = path.join(root, "email-security-worker.js")
const required = [
  workerPath,
  path.join(root, "email-security/package.json"),
  path.join(root, "email-security/dist/turen_email_security_wasm.js"),
  path.join(root, "email-security/dist/turen_email_security_wasm_bg.wasm"),
]

for (const file of required) {
  if (await Bun.file(file).exists()) continue
  throw new Error(`Desktop email-security artifact is missing: ${file}`)
}

const worker = new Worker(workerPath)
let timer: ReturnType<typeof setTimeout> | undefined
try {
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      worker.on("error", reject)
      worker.on("exit", (code) => {
        if (code !== 0) reject(new Error(`Email security worker exited with code ${code}`))
      })
      worker.on("message", (message) => {
        if (message.type === "failed") return reject(new Error(`Email security worker failed: ${message.error}`))
        const report = message.result
        if (
          report?.subject !== "Desktop Email" ||
          report.attachments?.[0]?.name !== "invoice.exe" ||
          !report.iocs?.some((ioc: { kind: string }) => ioc.kind === "url")
        )
          return reject(new Error(`Email security worker returned unexpected output: ${JSON.stringify(message)}`))
        resolve()
      })
      worker.postMessage({
        kind: "inspect",
        input: {
          bytes: new TextEncoder().encode(
          [
            "From: alice@example.test",
            "To: bob@example.test",
            "Date: Sat, 29 Aug 2026 12:00:00 +0000",
            "Message-ID: <desktop@example.test>",
            "Subject: Desktop Email",
            'Content-Type: multipart/mixed; boundary="desktop-boundary"',
            "",
            "--desktop-boundary",
            "Content-Type: text/plain",
            "",
            "Open https://example.test/login",
            "--desktop-boundary",
            'Content-Type: application/octet-stream; name="invoice.exe"',
            'Content-Disposition: attachment; filename="invoice.exe"',
            "",
            "payload",
            "--desktop-boundary--",
            "",
            ].join("\r\n"),
          ),
          includeBodies: true,
          includeAttachmentData: false,
          maxIocs: 2048,
        },
      })
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Desktop email security worker timed out")), 15_000)
    }),
  ])
} finally {
  clearTimeout(timer)
  await worker.terminate()
}

console.log("Desktop email security artifact verified")
