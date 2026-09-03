import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { parentPort } from "node:worker_threads"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Input, Result } from "./email-authenticate-runtime"

if (!parentPort) throw new Error("email authentication worker requires a parent port")

const roots = [
  (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    ? path.join((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath!, "email-authenticate", "dist")
    : undefined,
  path.join(path.dirname(process.execPath), "email-authenticate", "dist"),
  path.join(path.dirname(fileURLToPath(import.meta.url)), "email-authenticate", "dist"),
  path.dirname(fileURLToPath(import.meta.url)),
].filter((root): root is string => root !== undefined)
const root = roots.find((candidate) => exists(candidate))
if (!root) throw new Error("email authentication WASM package is unavailable")

const api = await import(pathToFileURL(path.join(root, "turen_email_authenticate_wasm.js")).href)
await api.default({ module_or_path: await readFile(path.join(root, "turen_email_authenticate_wasm_bg.wasm")) })

parentPort.once("message", (input: Input) => {
  const result = JSON.parse(api.authenticate(input.bytes, JSON.stringify(input.request))) as Result & { error?: string }
  if (result.error) parentPort?.postMessage({ type: "failed", error: result.error })
  else parentPort?.postMessage({ type: "completed", result })
})

function exists(candidate: string) {
  return existsSync(path.join(candidate, "turen_email_authenticate_wasm.js"))
}
