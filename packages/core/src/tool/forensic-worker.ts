import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { parentPort } from "node:worker_threads"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Input, Result } from "./forensic-runtime"

if (!parentPort) throw new Error("forensic worker requires a parent port")
const port = parentPort

port.once("message", async (request: Input) => {
  try {
    const result = await execute(request)
    port.postMessage({ type: "completed", result })
  } catch (cause) {
    port.postMessage({ type: "failed", error: cause instanceof Error ? cause.message : String(cause) })
  }
})

async function execute(request: Input): Promise<Result> {
  const crate = request.target.replaceAll("-", "_")
  const marker = `turen_${crate}_wasm.js`
  const root = resolveRoot(request.target, marker, `@turenlabs/${request.target}-wasm`)
  const api = await import(pathToFileURL(path.join(root, marker)).href)
  await api.default({ module_or_path: await readFile(path.join(root, `turen_${crate}_wasm_bg.wasm`)) })
  return JSON.parse(api.analyze(request.bytes, JSON.stringify(request.options ?? {})))
}

function resolveRoot(directory: string, marker: string, packageName: string) {
  const current = path.dirname(fileURLToPath(import.meta.url))
  const roots = [
    path.join(current, directory, "dist"),
    path.join(current, "forensic-tools", directory, "dist"),
    path.join(path.dirname(process.execPath), "forensic-tools", directory, "dist"),
    path.join(path.dirname(process.execPath), directory, "dist"),
  ]
  const bundled = roots.find((candidate) => existsSync(path.join(candidate, marker)))
  if (bundled) return bundled
  return path.dirname(fileURLToPath(import.meta.resolve(packageName)))
}
