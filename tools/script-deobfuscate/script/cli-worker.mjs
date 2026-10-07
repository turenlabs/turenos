import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parentPort } from "node:worker_threads"

if (!parentPort) throw new Error("CLI worker requires a parent port")
parentPort.once("message", async (request) => {
  try {
    const root = path.dirname(fileURLToPath(import.meta.url))
    const dist = path.basename(root) === "script" ? path.join(root, "..", "pkg") : path.join(root, "dist")
    const api = await import(pathToFileURL(path.join(dist, "turen_script_deobfuscate_wasm.js")).href)
    await api.default({ module_or_path: await readFile(path.join(dist, "turen_script_deobfuscate_wasm_bg.wasm")) })
    const report = api.deobfuscate(request.bytes, JSON.stringify(request.options))
    if (typeof report !== "string" || Buffer.byteLength(report) > 4 * 1024 * 1024)
      throw new Error("Invalid or oversized analysis report")
    parentPort.postMessage({ report })
  } catch (error) {
    parentPort.postMessage({ error: (error instanceof Error ? error.message : String(error)).slice(0, 4096) })
  }
})
