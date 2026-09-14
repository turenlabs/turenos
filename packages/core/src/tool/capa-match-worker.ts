import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { parentPort } from "node:worker_threads"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Request, Response } from "./capa-match-runtime"

if (!parentPort) throw new Error("capa match worker requires a parent port")

parentPort.once("message", async (request: Request) => {
  try {
    const root = resolveRoot()
    const api = await import(pathToFileURL(path.join(root, "turen_capa_match_wasm.js")).href)
    await api.default({
      module_or_path: await readFile(path.join(root, "turen_capa_match_wasm_bg.wasm")),
    })
    const options = JSON.stringify(request.options)
    const report = JSON.parse(
      request.op === "capa_ruleset" ? api.capa_ruleset(options) : api[request.op](request.bytes, options),
    ) as Record<string, unknown> & { error?: string; message?: string }
    if (report.error) throw new Error(typeof report.message === "string" ? report.message : report.error)
    parentPort!.postMessage({ type: "completed", result: report } satisfies Response)
  } catch (cause) {
    parentPort!.postMessage({
      type: "failed",
      error: cause instanceof Error ? cause.message : String(cause),
    } satisfies Response)
  }
})

function resolveRoot() {
  const current = path.dirname(fileURLToPath(import.meta.url))
  const roots = [
    path.join(current, "dist"),
    path.join(current, "capa-match", "dist"),
    path.join(path.dirname(process.execPath), "capa-match", "dist"),
  ]
  const root = roots.find((candidate) => existsSync(path.join(candidate, "turen_capa_match_wasm.js")))
  if (root) return root
  return path.dirname(fileURLToPath(import.meta.resolve("@turenlabs/capa-match-wasm")))
}
