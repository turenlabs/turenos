export * as JwtAuditRuntime from "./jwt-audit-runtime"

import { existsSync } from "node:fs"
import path from "node:path"
import { Worker } from "node:worker_threads"
import { pathToFileURL } from "node:url"
import { Context, Effect, Layer, Semaphore } from "effect"
import { makeGlobalNode } from "../effect/app-node"

export type Request =
  | { readonly op: "jwt_inspect"; readonly bytes: Uint8Array }
  | {
      readonly op: "jwt_verify"
      readonly bytes: Uint8Array
      readonly jwk: Uint8Array
      readonly options: {
        readonly algorithm: "RS256" | "ES256"
        readonly issuer: string
        readonly audience: string
        readonly now: number
      }
    }
export type Result = Readonly<Record<string, unknown>>
export type Response =
  | { readonly type: "completed"; readonly result: Result }
  | { readonly type: "failed"; readonly error: string }
export interface Interface {
  readonly run: (request: Request) => Effect.Effect<Result, Error>
}
export class Service extends Context.Service<Service, Interface>()("@forge/v2/JwtAuditRuntime") {}

const layer = Layer.effect(
  Service,
  Effect.sync(() => {
    const execution = Semaphore.makeUnsafe(1)
    return Service.of({
      run: (request) =>
        execution.withPermit(
          Effect.tryPromise({
            try: (signal) =>
              new Promise<Result>((resolve, reject) => {
                if (
                  request.bytes.length > 128 * 1024 ||
                  (request.op === "jwt_verify" && request.jwk.length > 16 * 1024)
                ) {
                  return reject(new Error("JWT input or public key exceeds its byte limit"))
                }
                const worker = new Worker(workerURL())
                let settled = false
                const finish = (result: { readonly value?: Result; readonly error?: Error }) => {
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
                  () => finish({ error: new Error("JWT audit timed out after 60000ms") }),
                  60_000,
                )
                worker.once("error", (error) => finish({ error }))
                worker.once("exit", (code) =>
                  finish({ error: new Error(`JWT audit worker exited before replying with code ${code}`) }),
                )
                worker.once("message", (message: Response) => {
                  if (message.type === "completed") return finish({ value: message.result })
                  finish({ error: new Error(message.error) })
                })
                signal.addEventListener("abort", onAbort, { once: true })
                if (signal.aborted) return onAbort()
                worker.postMessage(request)
              }),
            catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
          }),
        ),
    })
  }),
)
export const node = makeGlobalNode({ service: Service, layer, deps: [] })

function workerURL() {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const packaged = resources ? path.join(resources, "jwt-audit", "jwt-audit-worker.js") : undefined
  if (packaged && existsSync(packaged)) return pathToFileURL(packaged)
  const executable = path.join(path.dirname(process.execPath), "jwt-audit-worker.js")
  if (existsSync(executable)) return pathToFileURL(executable)
  return new URL(`./jwt-audit-worker.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url)
}
