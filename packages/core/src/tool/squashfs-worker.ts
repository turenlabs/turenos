import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { parentPort } from "node:worker_threads"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Request, Response } from "./squashfs-runtime"

if (!parentPort) throw new Error("squashfs worker requires a parent port")

parentPort.once("message", async (request: Request) => {
  try {
    const root = resolveRoot()
    const api = await import(pathToFileURL(path.join(root, "turen_squashfs_wasm.js")).href)
    await api.default({ module_or_path: await readFile(path.join(root, "turen_squashfs_wasm_bg.wasm")) })
    const options = JSON.stringify(request.options)
    if (request.op === "squashfs_extract") {
      const report = JSON.parse(api.squashfs_extract(request.bytes, options)) as Record<string, unknown>
      const content = report.contentBase64
      if (typeof content !== "string") throw new Error("squashfs_extract returned no contentBase64 payload")
      const { contentBase64: _, ...meta } = report
      const bytes = new Uint8Array(Buffer.from(content, "base64"))
      parentPort!.postMessage({ type: "completed", result: { type: "bytes", bytes, report: meta } } satisfies Response, [
        bytes.buffer,
      ])
      return
    }
    const report = JSON.parse(api.squashfs_list(request.bytes, options)) as Record<string, unknown>
    parentPort!.postMessage({ type: "completed", result: { type: "report", report } } satisfies Response)
  } catch (cause) {
    parentPort!.postMessage({ type: "failed", error: describe(cause) } satisfies Response)
  }
})

// Expected failures arrive as a thrown JsError whose message is a JSON report
// {"schema_version":1,"error":"<code>","message"?:"<detail>"}.
function describe(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause)
  try {
    const parsed = JSON.parse(message) as { error?: unknown; message?: unknown }
    if (typeof parsed.error === "string")
      return typeof parsed.message === "string" ? `${parsed.error}: ${parsed.message}` : parsed.error
  } catch {}
  return message
}

function resolveRoot() {
  const current = path.dirname(fileURLToPath(import.meta.url))
  const roots = [
    path.join(current, "dist"),
    path.join(current, "squashfs", "dist"),
    path.join(path.dirname(process.execPath), "squashfs", "dist"),
  ]
  const root = roots.find((candidate) => existsSync(path.join(candidate, "turen_squashfs_wasm.js")))
  if (root) return root
  return path.dirname(fileURLToPath(import.meta.resolve("@turenlabs/squashfs-wasm")))
}
