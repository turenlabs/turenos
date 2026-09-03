import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { parentPort } from "node:worker_threads"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Result } from "./binwalk-scan-runtime"

if (!parentPort) throw new Error("binwalk scan worker requires a parent port")

parentPort.once(
  "message",
  async (request: { readonly bytes: Uint8Array; readonly options: { readonly maxFindings: number } }) => {
    try {
      const root = resolveRoot()
      const api = await import(pathToFileURL(path.join(root, "turen_binwalk_scan_wasm.js")).href)
      await api.default({ module_or_path: await readFile(path.join(root, "turen_binwalk_scan_wasm_bg.wasm")) })
      const result = JSON.parse(api.binwalk_scan(request.bytes, JSON.stringify(request.options))) as Result & {
        error?: string
      }
      if (result.error) throw new Error(result.error)
      parentPort!.postMessage({ type: "completed", result })
    } catch (cause) {
      parentPort!.postMessage({ type: "failed", error: cause instanceof Error ? cause.message : String(cause) })
    }
  },
)

function resolveRoot() {
  const current = path.dirname(fileURLToPath(import.meta.url))
  const roots = [
    path.join(current, "dist"),
    path.join(current, "binwalk-scan", "dist"),
    path.join(path.dirname(process.execPath), "binwalk-scan", "dist"),
  ]
  const root = roots.find((candidate) => existsSync(path.join(candidate, "turen_binwalk_scan_wasm.js")))
  if (root) return root
  return path.dirname(fileURLToPath(import.meta.resolve("@turenlabs/binwalk-scan-wasm")))
}
