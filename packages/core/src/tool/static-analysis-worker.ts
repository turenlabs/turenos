import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { parentPort } from "node:worker_threads"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Input, Result } from "./static-analysis-runtime"

if (!parentPort) throw new Error("static analysis worker requires a parent port")
const port = parentPort

port.once("message", async (request: Input) => {
  try {
    const result = await execute(request)
    port.postMessage({ type: "completed", result })
  } catch (cause) {
    port.postMessage({ type: "failed", error: cause instanceof Error ? cause.message : String(cause) })
  }
})

async function execute(request: Input): Promise<Result> {
  const root = resolveRoot()
  const api = await import(pathToFileURL(path.join(root, "turen_static_analysis_wasm.js")).href)
  await api.default({ module_or_path: await readFile(path.join(root, "turen_static_analysis_wasm_bg.wasm")) })
  return JSON.parse(api.analyze(request.operation, request.bytes, JSON.stringify(request.options ?? {})))
}

function resolveRoot() {
  const current = path.dirname(fileURLToPath(import.meta.url))
  const roots = [
    path.join(current, "dist"),
    path.join(current, "static-analysis", "dist"),
    path.join(path.dirname(process.execPath), "static-analysis", "dist"),
  ]
  const bundled = roots.find((candidate) => existsSync(path.join(candidate, "turen_static_analysis_wasm.js")))
  if (bundled) return bundled
  return path.dirname(fileURLToPath(import.meta.resolve("@turenlabs/static-analysis-wasm")))
}
