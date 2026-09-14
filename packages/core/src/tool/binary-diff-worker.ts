import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { parentPort } from "node:worker_threads"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Request, Response } from "./binary-diff-runtime"

if (!parentPort) throw new Error("binary diff worker requires a parent port")

parentPort.once("message", async (request: Request) => {
  try {
    const root = resolveRoot()
    const api = await import(pathToFileURL(path.join(root, "turen_binary_diff_wasm.js")).href)
    await api.default({ module_or_path: await readFile(path.join(root, "turen_binary_diff_wasm_bg.wasm")) })
    const options = JSON.stringify(request.options)
    if (request.op === "binary_patch_info") {
      const report = JSON.parse(api.binary_patch_info(request.patch, options))
      if (report.error) throw new Error(typeof report.message === "string" ? report.message : report.error)
      parentPort!.postMessage({ type: "completed", result: { type: "report", report } } satisfies Response)
      return
    }
    if (request.op === "binary_patch") {
      const doc = encodeDoc({ old: base64(request.old), patch: base64(request.patch) })
      const bytes = api.binary_patch(doc, options)
      parentPort!.postMessage({ type: "completed", result: { type: "bytes", bytes } } satisfies Response, [bytes.buffer])
      return
    }
    const doc = encodeDoc({ old: base64(request.old), new: base64(request.next) })
    if (request.op === "binary_diff") {
      const bytes = api.binary_diff(doc, options)
      parentPort!.postMessage({ type: "completed", result: { type: "bytes", bytes } } satisfies Response, [bytes.buffer])
      return
    }
    const report = JSON.parse(api[request.op](doc, options))
    if (report.error) throw new Error(typeof report.message === "string" ? report.message : report.error)
    parentPort!.postMessage({ type: "completed", result: { type: "report", report } } satisfies Response)
  } catch (cause) {
    parentPort!.postMessage({
      type: "failed",
      error: cause instanceof Error ? cause.message : String(cause),
    } satisfies Response)
  }
})

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64")
const encodeDoc = (fields: Record<string, string>) => new TextEncoder().encode(JSON.stringify(fields))

function resolveRoot() {
  const current = path.dirname(fileURLToPath(import.meta.url))
  const roots = [
    path.join(current, "dist"),
    path.join(current, "binary-diff", "dist"),
    path.join(path.dirname(process.execPath), "binary-diff", "dist"),
  ]
  const root = roots.find((candidate) => existsSync(path.join(candidate, "turen_binary_diff_wasm.js")))
  if (root) return root
  return path.dirname(fileURLToPath(import.meta.resolve("@turenlabs/binary-diff-wasm")))
}
