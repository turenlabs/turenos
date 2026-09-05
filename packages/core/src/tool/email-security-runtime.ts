export * as EmailSecurityRuntime from "./email-security-runtime"

import { existsSync } from "node:fs"
import path from "node:path"
import { Worker } from "node:worker_threads"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Context, Effect, Layer, Semaphore } from "effect"
import { makeGlobalNode } from "../effect/app-node"

export interface Result {
  readonly schema_version: number
  readonly subject?: string
  readonly from: ReadonlyArray<Record<string, string | undefined>>
  readonly to: ReadonlyArray<Record<string, string | undefined>>
  readonly reply_to: ReadonlyArray<Record<string, string | undefined>>
  readonly headers: ReadonlyArray<Record<string, string>>
  readonly attachments: ReadonlyArray<Record<string, unknown>>
  readonly bodies: ReadonlyArray<Record<string, string>>
  readonly iocs: ReadonlyArray<Record<string, string>>
  readonly signals: ReadonlyArray<Record<string, string>>
  readonly truncated: boolean
  readonly warnings: ReadonlyArray<string>
}

export interface Input {
  readonly bytes: Uint8Array
  readonly includeBodies: boolean
  readonly includeAttachmentData: boolean
  readonly maxIocs: number
}

export interface SanitizedHtml {
  readonly schema_version: number
  readonly html: string
  readonly truncated: boolean
}

export interface ExtractInput {
  readonly bytes: Uint8Array
  readonly index: number
  readonly maxOutputBytes: number
}

export interface Interface {
  readonly extractAttachment: (input: ExtractInput) => Effect.Effect<Uint8Array, Error>
  readonly inspect: (input: Input) => Effect.Effect<Result, Error>
  readonly sanitizeHtml: (html: string) => Effect.Effect<SanitizedHtml, Error>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/EmailSecurityRuntime") {}

type Response =
  | { readonly type: "completed"; readonly result: unknown }
  | { readonly type: "failed"; readonly error: string }
type Request =
  | { readonly kind: "extract"; readonly input: ExtractInput }
  | { readonly kind: "inspect"; readonly input: Input }
  | { readonly kind: "sanitize"; readonly html: string }

const layer = Layer.effect(
  Service,
  Effect.sync(() => {
    const execution = Semaphore.makeUnsafe(1)
    const run = <A>(request: Request) =>
      execution.withPermit(
        Effect.tryPromise({
          try: (signal) =>
            new Promise<A>((resolve, reject) => {
              const worker = new Worker(workerURL())
              let settled = false
              const finish = (result: { readonly value?: A; readonly error?: Error }) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                signal.removeEventListener("abort", onAbort)
                worker.removeAllListeners()
                void worker.terminate().then(
                  () => (result.error ? reject(result.error) : resolve(result.value!)),
                  (cause) => reject(cause instanceof Error ? cause : new Error(String(cause))),
                )
              }
              const onAbort = () =>
                finish({
                  error: signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"),
                })
              const timer = setTimeout(
                () => finish({ error: new Error("email security analysis timed out after 15000ms") }),
                15_000,
              )
              worker.once("error", (error) => finish({ error }))
              worker.once("exit", (code) => {
                if (code !== 0) finish({ error: new Error(`email security worker exited with code ${code}`) })
              })
              worker.once("message", (message: Response) => {
                if (message.type === "completed") finish({ value: message.result as A })
                else finish({ error: new Error(message.error) })
              })
              signal.addEventListener("abort", onAbort, { once: true })
              if (signal.aborted) return onAbort()
              if (request.kind === "inspect" || request.kind === "extract") {
                const bytes = new Uint8Array(request.input.bytes)
                worker.postMessage({ ...request, input: { ...request.input, bytes } }, [bytes.buffer])
                return
              }
              worker.postMessage(request)
            }),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        }),
      )

    return Service.of({
      extractAttachment: (input) => {
        if (!Number.isInteger(input.index) || input.index < 0 || input.index >= 256)
          return Effect.fail(new Error("invalid_attachment_index"))
        if (
          !Number.isInteger(input.maxOutputBytes) ||
          input.maxOutputBytes < 1 ||
          input.maxOutputBytes > 8 * 1024 * 1024
        )
          return Effect.fail(new Error("invalid_max_output_bytes"))
        if (input.bytes.length === 0 || input.bytes.length > 32 * 1024 * 1024)
          return Effect.fail(new Error("Email input must be between 1 byte and 32 MiB"))
        return run<Uint8Array>({ kind: "extract", input })
      },
      inspect: (input) => run<Result>({ kind: "inspect", input }),
      sanitizeHtml: (html) => run<SanitizedHtml>({ kind: "sanitize", html }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })

function workerURL() {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const packaged = resources ? path.join(resources, "email-security", "email-security-worker.js") : undefined
  if (packaged && existsSync(packaged)) return pathToFileURL(packaged)
  const executable = path.join(path.dirname(process.execPath), "email-security-worker.js")
  if (existsSync(executable)) return pathToFileURL(executable)
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js"
  return new URL(`./email-security-worker.${extension}`, import.meta.url)
}
