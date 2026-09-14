import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { parentPort } from "node:worker_threads"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Request, Result } from "./json-query-runtime"

if (!parentPort) throw new Error("json query worker requires a parent port")

parentPort.once("message", async (request: Request) => {
  try {
    const root = resolveRoot()
    const api = await import(pathToFileURL(path.join(root, "turen_json_query_wasm.js")).href)
    await api.default({ module_or_path: await readFile(path.join(root, "turen_json_query_wasm_bg.wasm")) })
    const output =
      "options" in request
        ? api[request.op](request.bytes, JSON.stringify(request.options))
        : api[request.op](request.bytes)
    const result = JSON.parse(output) as Result
    // json_validate reports an invalid verdict in-band; a mid-stream eval_error
    // keeps the results it already collected. Bare error documents are failures.
    if (typeof result.error === "string" && request.op !== "json_validate" && !("results" in result))
      throw new Error(typeof result.message === "string" ? result.message : result.error)
    parentPort!.postMessage({ type: "completed", result })
  } catch (cause) {
    parentPort!.postMessage({
      type: "failed",
      error: cause instanceof Error ? cause.message : String(cause),
    })
  }
})

function resolveRoot() {
  const current = path.dirname(fileURLToPath(import.meta.url))
  const roots = [
    path.join(current, "dist"),
    path.join(current, "json-query", "dist"),
    path.join(path.dirname(process.execPath), "json-query", "dist"),
  ]
  const root = roots.find((candidate) => existsSync(path.join(candidate, "turen_json_query_wasm.js")))
  if (root) return root
  return path.dirname(fileURLToPath(import.meta.resolve("@turenlabs/json-query-wasm")))
}
