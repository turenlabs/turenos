import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { parentPort } from "node:worker_threads"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Request, Response } from "./jwt-audit-runtime"

if (!parentPort) throw new Error("JWT audit worker requires a parent port")
parentPort.once("message", async (request: Request) => {
  try {
    const current = path.dirname(fileURLToPath(import.meta.url))
    const roots = [
      path.join(current, "dist"),
      path.join(current, "jwt-audit", "dist"),
      path.join(path.dirname(process.execPath), "jwt-audit", "dist"),
    ]
    const root =
      roots.find((candidate) => existsSync(path.join(candidate, "turen_jwt_audit_wasm.js"))) ??
      path.dirname(fileURLToPath(import.meta.resolve("@turenlabs/jwt-audit-wasm")))
    const api = await import(pathToFileURL(path.join(root, "turen_jwt_audit_wasm.js")).href)
    await api.default({ module_or_path: await readFile(path.join(root, "turen_jwt_audit_wasm_bg.wasm")) })
    const parsed: unknown = JSON.parse(
      request.op === "jwt_verify"
        ? api.jwt_verify(request.bytes, request.jwk, JSON.stringify(request.options))
        : api.jwt_inspect(request.bytes),
    )
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("JWT WASM returned a non-object report")
    const report: Record<string, unknown> = Object.fromEntries(Object.entries(parsed))
    if (typeof report.error === "string") throw new Error(report.error)
    parentPort!.postMessage({ type: "completed", result: report } satisfies Response)
  } catch (cause) {
    parentPort!.postMessage({
      type: "failed",
      error: cause instanceof Error ? cause.message : String(cause),
    } satisfies Response)
  }
})
