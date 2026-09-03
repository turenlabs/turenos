import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { parentPort } from "node:worker_threads"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Input, Result } from "./debug-symbols-runtime"

if (!parentPort) throw new Error("debug symbols worker requires a parent port")

const workerDirectory = path.dirname(fileURLToPath(import.meta.url))
const roots = [
  (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    ? path.join((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath!, "debug-symbols", "dist")
    : undefined,
  path.join(path.dirname(process.execPath), "debug-symbols", "dist"),
  path.join(workerDirectory, "debug-symbols", "dist"),
  workerDirectory,
].filter((root): root is string => root !== undefined)
const root = roots.find((candidate) => existsSync(path.join(candidate, "turen_debug_symbols_wasm.js")))
if (!root) throw new Error("debug symbols WASM package is unavailable")

const api = await import(pathToFileURL(path.join(root, "turen_debug_symbols_wasm.js")).href)
await api.default({ module_or_path: await readFile(path.join(root, "turen_debug_symbols_wasm_bg.wasm")) })

parentPort.once("message", (input: Input) => {
  const result = JSON.parse(api.inspect(input.bytes, JSON.stringify(input.options))) as Result & { error?: string }
  if (result.error) parentPort?.postMessage({ type: "failed", error: result.error })
  else parentPort?.postMessage({ type: "completed", result })
})
