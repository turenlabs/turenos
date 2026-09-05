import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { parentPort } from "node:worker_threads"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { ExtractInput, Input, Result, SanitizedHtml } from "./email-security-runtime"

if (!parentPort) throw new Error("email security worker requires a parent port")
const port = parentPort

type Request =
  | { readonly kind: "extract"; readonly input: ExtractInput }
  | { readonly kind: "inspect"; readonly input: Input }
  | { readonly kind: "sanitize"; readonly html: string }

port.once("message", async (request: Request) => {
  try {
    const root = resolveRoot()
    const api = await import(pathToFileURL(path.join(root, "turen_email_security_wasm.js")).href)
    await api.default({ module_or_path: await readFile(path.join(root, "turen_email_security_wasm_bg.wasm")) })
    if (request.kind === "extract") {
      const result: Uint8Array = api.extract_attachment(
        request.input.bytes,
        request.input.index,
        request.input.maxOutputBytes,
      )
      if (
        !(result instanceof Uint8Array) ||
        result.length > request.input.maxOutputBytes ||
        result.length > 8 * 1024 * 1024
      )
        throw new Error("Invalid attachment extraction result")
      const bytes = new Uint8Array(result)
      port.postMessage({ type: "completed", result: bytes }, [bytes.buffer])
      return
    }
    const result = JSON.parse(
      request.kind === "inspect"
        ? api.inspect(
            request.input.bytes,
            JSON.stringify({
              include_bodies: request.input.includeBodies,
              include_attachment_data: request.input.includeAttachmentData,
              max_iocs: request.input.maxIocs,
            }),
          )
        : api.sanitize_html(request.html),
    ) as (Result | SanitizedHtml) & { error?: string }
    if (result.error) throw new Error(result.error)
    port.postMessage({ type: "completed", result })
  } catch (cause) {
    port.postMessage({ type: "failed", error: cause instanceof Error ? cause.message : String(cause) })
  }
})

function resolveRoot() {
  const current = path.dirname(fileURLToPath(import.meta.url))
  const roots = [
    path.join(current, "dist"),
    path.join(current, "email-security", "dist"),
    path.join(path.dirname(process.execPath), "email-security", "dist"),
  ]
  const bundled = roots.find((candidate) => existsSync(path.join(candidate, "turen_email_security_wasm.js")))
  if (bundled) return bundled
  return path.dirname(fileURLToPath(import.meta.resolve("@turenlabs/email-security-wasm")))
}
