import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { parentPort } from "node:worker_threads"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Request, Response } from "./script-deobfuscate-runtime"

if (!parentPort) throw new Error("script-deobfuscate worker requires a parent port")
parentPort.once("message", async (request: Request) => {
  try {
    const root = resolveRoot()
    const api = await import(pathToFileURL(path.join(root, "turen_script_deobfuscate_wasm.js")).href)
    await api.default({ module_or_path: await readFile(path.join(root, "turen_script_deobfuscate_wasm_bg.wasm")) })
    const report: unknown = api.deobfuscate(request.bytes, JSON.stringify(request.options))
    if (typeof report !== "string" || Buffer.byteLength(report) > 4 * 1024 * 1024)
      throw new Error("Invalid or oversized script-deobfuscate report")
    parentPort!.postMessage({ type: "completed", report } satisfies Response)
  } catch (cause) {
    parentPort!.postMessage({
      type: "failed",
      error: (cause instanceof Error ? cause.message : String(cause)).slice(0, 4096),
    } satisfies Response)
  }
})
function resolveRoot() {
  const current = path.dirname(fileURLToPath(import.meta.url))
  const roots = [
    path.join(current, "dist"),
    path.join(current, "script-deobfuscate", "dist"),
    path.join(path.dirname(process.execPath), "script-deobfuscate", "dist"),
  ]
  const root = roots.find((candidate) => existsSync(path.join(candidate, "turen_script_deobfuscate_wasm.js")))
  if (root) return root
  return path.dirname(fileURLToPath(import.meta.resolve("@turenlabs/script-deobfuscate-wasm")))
}
