export * as ScriptDeobfuscateRuntime from "./script-deobfuscate-runtime"

import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import path from "node:path"
import { Worker } from "node:worker_threads"
import { pathToFileURL } from "node:url"
import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import { makeGlobalNode } from "../effect/app-node"

export const MAX_INPUT_BYTES = 1024 * 1024
export const MAX_REPORT_BYTES = 4 * 1024 * 1024
const Offset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(MAX_INPUT_BYTES))
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Span = { kind: Schema.NonEmptyString, start: Offset, end: Offset }
export const Report = Schema.Struct({
  schema_version: Schema.Literal(1),
  language: Schema.Literal("js"),
  input: Schema.Struct({ bytes: Offset, sha256: Hash }),
  code: Schema.String,
  transformations: Schema.Array(Schema.Struct(Span)).check(Schema.isMaxLength(256)),
  payloads: Schema.Array(Schema.Struct({ ...Span, code: Schema.String, sha256: Hash })).check(Schema.isMaxLength(128)),
  warnings: Schema.Array(Schema.String).check(Schema.isMaxLength(64)),
  truncated: Schema.Boolean,
})
const EngineError = Schema.Struct({
  schema_version: Schema.Literal(1),
  error: Schema.NonEmptyString,
  message: Schema.String,
})
const Response = Schema.Union([
  Schema.Struct({ type: Schema.Literal("completed"), report: Schema.String }),
  Schema.Struct({ type: Schema.Literal("failed"), error: Schema.String }),
])
export type Report = typeof Report.Type
export type Request = {
  readonly bytes: Uint8Array
  readonly options: {
    readonly language?: "js"
    readonly extractPayloads?: boolean
    readonly assumeStandardBuiltins?: boolean
  }
}
export type Response = typeof Response.Type
export interface Interface {
  readonly run: (request: Request) => Effect.Effect<Report, Error>
}
export class Service extends Context.Service<Service, Interface>()("@forge/v2/ScriptDeobfuscateRuntime") {}

const layer = Layer.effect(
  Service,
  Effect.sync(() => {
    const execution = Semaphore.makeUnsafe(1)
    return Service.of({
      run: (request) =>
        execution.withPermit(
          Effect.gen(function* () {
            if (request.bytes.length > MAX_INPUT_BYTES)
              return yield* Effect.fail(new Error("script-deobfuscate input exceeds 1 MiB"))
            if (Buffer.byteLength(JSON.stringify(request.options)) > 4096)
              return yield* Effect.fail(new Error("script-deobfuscate options exceed 4 KiB"))
            // The scoped finalizer is uninterruptible and finishes before withPermit releases its permit.
            return yield* Effect.acquireUseRelease(
              Effect.try({ try: () => new Worker(workerURL()), catch: toError }),
              (worker) =>
                Effect.tryPromise({
                  try: (signal) =>
                    new Promise<string>((resolve, reject) => {
                      let settled = false
                      const finish = (result: { value: string } | { error: Error }) => {
                        if (settled) return
                        settled = true
                        clearTimeout(timer)
                        signal.removeEventListener("abort", onAbort)
                        if ("error" in result) reject(result.error)
                        else resolve(result.value)
                      }
                      const onAbort = () => finish({ error: new DOMException("Aborted", "AbortError") })
                      const timer = setTimeout(
                        () => finish({ error: new Error("script-deobfuscate timed out after 30000ms") }),
                        30_000,
                      )
                      worker.once("error", (error) => finish({ error }))
                      worker.once("exit", (code) =>
                        finish({ error: new Error(`script-deobfuscate worker exited unexpectedly with code ${code}`) }),
                      )
                      worker.once("message", (message: unknown) => {
                        const decoded = Schema.decodeUnknownExit(Response)(message)
                        if (decoded._tag === "Failure")
                          return finish({ error: new Error("Invalid script-deobfuscate worker response") })
                        if (decoded.value.type === "failed")
                          return finish({ error: new Error(decoded.value.error.slice(0, 4096)) })
                        finish({ value: decoded.value.report })
                      })
                      signal.addEventListener("abort", onAbort, { once: true })
                      if (signal.aborted) return onAbort()
                      const bytes = new Uint8Array(request.bytes)
                      try {
                        worker.postMessage({ bytes, options: request.options } satisfies Request, [bytes.buffer])
                      } catch (cause) {
                        finish({ error: toError(cause) })
                      }
                    }),
                  catch: toError,
                }).pipe(
                  Effect.flatMap((text) =>
                    Effect.try({ try: () => validateReport(text, request.bytes), catch: toError }),
                  ),
                ),
              (worker) =>
                Effect.promise(async () => {
                  // Keep an error listener until termination even if interruption prevented use from starting.
                  worker.on("error", () => {})
                  await worker.terminate()
                  worker.removeAllListeners()
                }),
            )
          }),
        ),
    })
  }),
)
export const node = makeGlobalNode({ service: Service, layer, deps: [] })

function validateReport(text: string, bytes: Uint8Array): Report {
  if (Buffer.byteLength(text) > MAX_REPORT_BYTES) throw new Error("script-deobfuscate report exceeds 4 MiB")
  const document: unknown = JSON.parse(text)
  const error = Schema.decodeUnknownExit(EngineError)(document)
  if (error._tag === "Success") throw new Error(`${error.value.error}: ${error.value.message.slice(0, 4096)}`)
  const decoded = Schema.decodeUnknownExit(Report)(document)
  if (decoded._tag === "Failure") throw new Error("Invalid script-deobfuscate report structure")
  const report = decoded.value
  if (report.input.bytes !== bytes.length || report.input.sha256 !== createHash("sha256").update(bytes).digest("hex"))
    throw new Error("Invalid script-deobfuscate input identity")
  if (Buffer.byteLength(report.code) > 2 * 1024 * 1024) throw new Error("script-deobfuscate code exceeds 2 MiB")
  if (report.payloads.reduce((total, payload) => total + Buffer.byteLength(payload.code), 0) > 256 * 1024)
    throw new Error("script-deobfuscate payloads exceed 256 KiB")
  for (const span of [...report.transformations, ...report.payloads]) {
    if (span.start > span.end || span.end > bytes.length)
      throw new Error("Invalid script-deobfuscate original byte span")
  }
  for (const payload of report.payloads) {
    if (
      Buffer.byteLength(payload.code) > 64 * 1024 ||
      payload.sha256 !== createHash("sha256").update(payload.code).digest("hex")
    )
      throw new Error("Invalid script-deobfuscate payload identity or size")
  }
  return report
}
function toError(cause: unknown) {
  return cause instanceof Error ? cause : new Error(String(cause))
}
function workerURL() {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const packaged = resources ? path.join(resources, "script-deobfuscate", "script-deobfuscate-worker.js") : undefined
  if (packaged && existsSync(packaged)) return pathToFileURL(packaged)
  const executable = path.join(path.dirname(process.execPath), "script-deobfuscate-worker.js")
  if (existsSync(executable)) return pathToFileURL(executable)
  return new URL(`./script-deobfuscate-worker.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url)
}
