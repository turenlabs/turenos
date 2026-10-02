#!/usr/bin/env node
// @generated from tools/script-deobfuscate/script/cli.mjs. Do not edit.
import { createReadStream } from "node:fs"
import { parseArgs } from "node:util"
import { Worker } from "node:worker_threads"

const usage = `Usage: script-deobfuscate js <input.js|-> [options]

  --extract-payloads          Recover static arguments to potential execution sinks
  --assume-standard-builtins  Permit supported intrinsic folds under an explicit assumption
  --format code|json         Output readable code (default) or the full evidence report
  --help                     Show this help

All analysis runs inside WASM. Submitted scripts are never executed.
Hard limits cannot be disabled. JavaScript is the only supported language.
`

async function main() {
  const args = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      "extract-payloads": { type: "boolean", default: false },
      "assume-standard-builtins": { type: "boolean", default: false },
      format: { type: "string", default: "code" },
    },
  })
  if (args.values.help) return process.stdout.write(usage)
  if (args.positionals[0] !== "js") throw new Error("The first positional argument must be js")
  if (args.positionals.length !== 2) throw new Error("Exactly one input file or - for stdin is required")
  const input = args.positionals[1]
  const format = args.values.format
  if (format !== "code" && format !== "json") throw new Error("Output format must be code or json")
  const options = {
    language: "js",
    extractPayloads: args.values["extract-payloads"],
    assumeStandardBuiltins: args.values["assume-standard-builtins"],
  }

  const chunks = []
  let size = 0
  const stream = input === "-" ? process.stdin : createReadStream(input)
  for await (const chunk of stream) {
    size += chunk.length
    if (size > 1024 * 1024) {
      stream.destroy()
      throw new Error("Input exceeds the 1 MiB limit")
    }
    chunks.push(chunk)
  }
  const worker = new Worker(new URL("./cli-worker.mjs", import.meta.url))
  const report = await analyze(worker, new Uint8Array(Buffer.concat(chunks, size)), options)
  if (report.error) throw new Error(`${report.error}: ${report.message ?? "Analysis failed"}`)
  if (format === "json") return process.stdout.write(JSON.stringify(report, null, 2) + "\n")
  process.stdout.write(report.code + (report.code.endsWith("\n") ? "" : "\n"))
  for (const warning of report.warnings ?? [])
    process.stderr.write(`warning: ${typeof warning === "string" ? warning : JSON.stringify(warning)}\n`)
  if (report.payloads?.length)
    process.stderr.write(
      `Recovered ${report.payloads.length} potential payloads; use --format json to inspect evidence.\n`,
    )
}

async function analyze(worker, bytes, options) {
  let timer
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Analysis timed out after 30000ms")), 30_000)
      worker.once("error", reject)
      worker.once("exit", (code) => reject(new Error(`Analysis worker exited unexpectedly (${code})`)))
      worker.once("message", (message) => {
        if (message.error) return reject(new Error(message.error))
        if (typeof message.report !== "string" || Buffer.byteLength(message.report) > 4 * 1024 * 1024)
          return reject(new Error("Invalid or oversized analysis report"))
        try {
          resolve(JSON.parse(message.report))
        } catch (error) {
          reject(error)
        }
      })
      worker.postMessage({ bytes, options }, [bytes.buffer])
    })
  } finally {
    clearTimeout(timer)
    await worker.terminate()
  }
}

main().catch((error) => {
  process.stderr.write(`script-deobfuscate: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
