import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { parentPort } from "node:worker_threads"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Request, Response } from "./git-inspect-runtime"

if (!parentPort) throw new Error("git inspect worker requires a parent port")

parentPort.once("message", async (request: Request) => {
  try {
    const root = resolveRoot()
    const api = await import(pathToFileURL(path.join(root, "turen_git_inspect_wasm.js")).href)
    await api.default({
      module_or_path: await readFile(path.join(root, "turen_git_inspect_wasm_bg.wasm")),
    })
    const options = JSON.stringify(request.options)
    if (request.op === "git_pack_entry_raw") {
      const bytes = new Uint8Array(api.git_pack_entry_raw(request.bytes, options))
      parentPort!.postMessage(
        { type: "completed", result: { type: "bytes", bytes } } satisfies Response,
        [bytes.buffer],
      )
      return
    }
    const report = JSON.parse(
      request.op === "git_identify" ? api.git_identify(request.bytes) : api[request.op](request.bytes, options),
    ) as Record<string, unknown>
    // JSON ops return {"schema_version":1,"error":"<code>"} on expected failures.
    if (typeof report.error === "string") throw new Error(report.error)
    parentPort!.postMessage({ type: "completed", result: { type: "report", report } } satisfies Response)
  } catch (cause) {
    parentPort!.postMessage({ type: "failed", error: describe(cause) } satisfies Response)
  }
})

// git_pack_entry_raw rejects with a bare error-code string; other thrown
// JsErrors may carry a JSON report message — decode either shape.
function describe(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause)
  try {
    const parsed = JSON.parse(message) as { error?: unknown; message?: unknown; detail?: unknown }
    if (typeof parsed.error === "string") {
      const detail =
        typeof parsed.message === "string"
          ? parsed.message
          : typeof parsed.detail === "string"
            ? parsed.detail
            : undefined
      return detail ? `${parsed.error}: ${detail}` : parsed.error
    }
  } catch {}
  return message
}

function resolveRoot() {
  const current = path.dirname(fileURLToPath(import.meta.url))
  const roots = [
    path.join(current, "dist"),
    path.join(current, "git-inspect", "dist"),
    path.join(path.dirname(process.execPath), "git-inspect", "dist"),
  ]
  const root = roots.find((candidate) => existsSync(path.join(candidate, "turen_git_inspect_wasm.js")))
  if (root) return root
  return path.dirname(fileURLToPath(import.meta.resolve("@turenlabs/git-inspect-wasm")))
}
