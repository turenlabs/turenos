import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { parentPort } from "node:worker_threads"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Request, Response } from "./pdf-inspect-runtime"

if (!parentPort) throw new Error("pdf inspect worker requires a parent port")

parentPort.once("message", async (request: Request) => {
  try {
    const root = resolveRoot()
    const api = await import(pathToFileURL(path.join(root, "turen_pdf_inspect_wasm.js")).href)
    await api.default({ module_or_path: await readFile(path.join(root, "turen_pdf_inspect_wasm_bg.wasm")) })
    const report = JSON.parse(api[request.op](request.bytes, JSON.stringify(request.options))) as Record<
      string,
      unknown
    > & { error?: string; message?: string }
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
    path.join(current, "pdf-inspect", "dist"),
    path.join(path.dirname(process.execPath), "pdf-inspect", "dist"),
  ]
  const root = roots.find((candidate) => existsSync(path.join(candidate, "turen_pdf_inspect_wasm.js")))
  if (root) return root
  return path.dirname(fileURLToPath(import.meta.resolve("@turenlabs/pdf-inspect-wasm")))
}
