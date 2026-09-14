export * as BinaryDiffRuntime from "./binary-diff-runtime"

import { existsSync } from "node:fs"
import path from "node:path"
import { Worker } from "node:worker_threads"
import { pathToFileURL } from "node:url"
import { Context, Effect, Layer, Semaphore } from "effect"
import { makeGlobalNode } from "../effect/app-node"

export type Request =
  | {
      readonly op: "binary_compare" | "binary_regions" | "binary_diff"
      readonly old: Uint8Array
      readonly next: Uint8Array
      readonly options: Readonly<Record<string, unknown>>
    }
  | {
      readonly op: "binary_patch"
      readonly old: Uint8Array
      readonly patch: Uint8Array
      readonly options: Readonly<Record<string, unknown>>
    }
  | {
      readonly op: "binary_patch_info"
      readonly patch: Uint8Array
      readonly options: Readonly<Record<string, unknown>>
    }

export type Result =
  | { readonly type: "report"; readonly report: Readonly<Record<string, unknown>> }
  | { readonly type: "bytes"; readonly bytes: Uint8Array }

export type Response =
  | { readonly type: "completed"; readonly result: Result }
  | { readonly type: "failed"; readonly error: string }

export interface Interface {
  readonly run: (request: Request) => Effect.Effect<Result, Error>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/BinaryDiffRuntime") {}

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
                  () => finish({ error: new Error("binary diff operation timed out after 60000ms") }),
                  60_000,
                )
                worker.once("error", (error) => finish({ error }))
                worker.once("exit", (code) => {
                  if (code !== 0) finish({ error: new Error(`binary diff worker exited with code ${code}`) })
                })
                worker.once("message", (message: Response) => {
                  if (message.type === "completed") finish({ value: message.result })
                  else finish({ error: new Error(message.error) })
                })
                signal.addEventListener("abort", onAbort, { once: true })
                if (signal.aborted) return onAbort()
                const clone = (bytes: Uint8Array) => new Uint8Array(bytes)
                const message: Request =
                  request.op === "binary_patch_info"
                    ? { ...request, patch: clone(request.patch) }
                    : request.op === "binary_patch"
                      ? { ...request, old: clone(request.old), patch: clone(request.patch) }
                      : { ...request, old: clone(request.old), next: clone(request.next) }
                const transfer = [
                  "old" in message ? message.old.buffer : undefined,
                  "next" in message ? message.next.buffer : undefined,
                  "patch" in message ? message.patch.buffer : undefined,
                ].filter((buffer): buffer is ArrayBuffer => buffer !== undefined)
                worker.postMessage(message, transfer)
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
  const packaged = resources ? path.join(resources, "binary-diff", "binary-diff-worker.js") : undefined
  if (packaged && existsSync(packaged)) return pathToFileURL(packaged)
  const executable = path.join(path.dirname(process.execPath), "binary-diff-worker.js")
  if (existsSync(executable)) return pathToFileURL(executable)
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js"
  return new URL(`./binary-diff-worker.${extension}`, import.meta.url)
}
