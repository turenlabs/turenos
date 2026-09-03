import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { parentPort } from "node:worker_threads"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Input, Result } from "./protocol-inspect-runtime"

if (!parentPort) throw new Error("protocol inspector worker requires a parent port")
const port = parentPort

type WasmApi = {
  readonly default: (input: { readonly module_or_path: Uint8Array }) => Promise<unknown>
  readonly inspect: (bytes: Uint8Array, linkType: number, optionsJson: string) => string
}

port.once("message", async (request: Input) => {
  try {
    const root = resolveRoot()
    const api = (await import(pathToFileURL(path.join(root, "turen_protocol_inspect_wasm.js")).href)) as unknown as WasmApi
    await api.default({ module_or_path: await readFile(path.join(root, "turen_protocol_inspect_wasm_bg.wasm")) })
    const decoded: unknown = JSON.parse(api.inspect(request.bytes, request.linkType, JSON.stringify({})))
    if (!isRecord(decoded)) throw new Error("protocol inspector returned invalid JSON")
    if (typeof decoded.error === "string" && decoded.error.length > 0) throw new Error(decoded.error)
    port.postMessage({ type: "completed", result: decoded as Result })
  } catch (cause) {
    port.postMessage({ type: "failed", error: cause instanceof Error ? cause.message : String(cause) })
  }
})

function resolveRoot() {
  const current = path.dirname(fileURLToPath(import.meta.url))
  const roots = [
    path.join(current, "dist"),
    path.join(current, "protocol-inspect", "dist"),
    path.join(current, "binary-tools", "protocol-inspect", "dist"),
    path.join(path.dirname(process.execPath), "protocol-inspect", "dist"),
  ]
  const bundled = roots.find((candidate) => existsSync(path.join(candidate, "turen_protocol_inspect_wasm.js")))
  if (bundled) return bundled
  return path.dirname(fileURLToPath(import.meta.resolve("@turenlabs/protocol-inspect-wasm")))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
