import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { parentPort } from "node:worker_threads"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Request, Response } from "./firmware-formats-runtime"

if (!parentPort) throw new Error("firmware formats worker requires a parent port")

parentPort.once("message", async (request: Request) => {
  try {
    const root = resolveRoot()
    const api = await import(pathToFileURL(path.join(root, "turen_firmware_formats_wasm.js")).href)
    await api.default({
      module_or_path: await readFile(path.join(root, "turen_firmware_formats_wasm_bg.wasm")),
    })
    const options = JSON.stringify(request.options)
    if (
      request.op === "android_sparse_expand" ||
      request.op === "ihex_flatten" ||
      request.op === "srec_flatten"
    ) {
      const bytes = new Uint8Array(api[request.op](request.bytes, options))
      parentPort!.postMessage(
        { type: "completed", result: { type: "bytes", bytes } } satisfies Response,
        [bytes.buffer],
      )
      return
    }
    const report = JSON.parse(api[request.op](request.bytes, options)) as Record<string, unknown>
    if (typeof report.error === "string") throw new Error(report.error)
    parentPort!.postMessage({ type: "completed", result: { type: "report", report } } satisfies Response)
  } catch (cause) {
    parentPort!.postMessage({ type: "failed", error: describe(cause) } satisfies Response)
  }
})

// Expected failures arrive as a thrown JsError whose message is a JSON report
// {"schema_version":1,"error":"<code>","detail"?:"<detail>"}.
function describe(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause)
  try {
    const parsed = JSON.parse(message) as { error?: unknown; message?: unknown; detail?: unknown }
    if (typeof parsed.error === "string") {
      const detail =
        typeof parsed.detail === "string"
          ? parsed.detail
          : typeof parsed.message === "string"
            ? parsed.message
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
    path.join(current, "firmware-formats", "dist"),
    path.join(path.dirname(process.execPath), "firmware-formats", "dist"),
  ]
  const root = roots.find((candidate) => existsSync(path.join(candidate, "turen_firmware_formats_wasm.js")))
  if (root) return root
  return path.dirname(fileURLToPath(import.meta.resolve("@turenlabs/firmware-formats-wasm")))
}
