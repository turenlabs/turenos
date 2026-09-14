import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { parentPort } from "node:worker_threads"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Request, Response } from "./sourcemap-runtime"

if (!parentPort) throw new Error("sourcemap worker requires a parent port")

parentPort.once("message", async (request: Request) => {
  try {
    const root = resolveRoot()
    const api = await import(pathToFileURL(path.join(root, "turen_sourcemap_wasm.js")).href)
    await api.default({ module_or_path: await readFile(path.join(root, "turen_sourcemap_wasm_bg.wasm")) })
    const output = api[request.op](request.bytes, JSON.stringify(request.options))
    if (typeof output === "string") {
      const report = JSON.parse(output) as Record<string, unknown>
      if (report.error) throw new Error(errorText(report))
      parentPort!.postMessage({ type: "completed", result: { type: "report", report } } satisfies Response)
      return
    }
    parentPort!.postMessage({ type: "completed", result: { type: "bytes", bytes: output } } satisfies Response, [
      output.buffer,
    ])
  } catch (cause) {
    parentPort!.postMessage({ type: "failed", error: errorMessage(cause) } satisfies Response)
  }
})

// Expected sourcemap errors are a JSON document: {"schema_version":1,"error":"<code>","message":"..."}
const errorText = (doc: Record<string, unknown>) =>
  typeof doc.message === "string" ? doc.message : typeof doc.detail === "string" ? doc.detail : String(doc.error)

function errorMessage(cause: unknown) {
  const text = cause instanceof Error ? cause.message : String(cause)
  try {
    return errorText(JSON.parse(text) as Record<string, unknown>)
  } catch {
    return text
  }
}

function resolveRoot() {
  const current = path.dirname(fileURLToPath(import.meta.url))
  const roots = [
    path.join(current, "dist"),
    path.join(current, "sourcemap", "dist"),
    path.join(path.dirname(process.execPath), "sourcemap", "dist"),
  ]
  const root = roots.find((candidate) => existsSync(path.join(candidate, "turen_sourcemap_wasm.js")))
  if (root) return root
  return path.dirname(fileURLToPath(import.meta.resolve("@turenlabs/sourcemap-wasm")))
}
