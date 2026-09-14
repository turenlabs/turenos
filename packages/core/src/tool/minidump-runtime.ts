export * as MinidumpRuntime from "./minidump-runtime"

import { existsSync } from "node:fs"
import path from "node:path"
import { Worker } from "node:worker_threads"
import { pathToFileURL } from "node:url"
import { Context, Effect, Layer, Semaphore } from "effect"
import { makeGlobalNode } from "../effect/app-node"

export interface Request {
  readonly op: "minidump_inspect" | "minidump_memory_read" | "minidump_modules" | "minidump_stream"
  readonly bytes: Uint8Array
  readonly options: Readonly<Record<string, unknown>>
}

export type Result = Readonly<Record<string, unknown>>

export type Response =
  | { readonly type: "completed"; readonly result: Result }
  | { readonly type: "failed"; readonly error: string }

export interface Interface {
  readonly run: (request: Request) => Effect.Effect<Result, Error>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/MinidumpRuntime") {}

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
                  () => finish({ error: new Error("minidump operation timed out after 60000ms") }),
                  60_000,
                )
                worker.once("error", (error) => finish({ error }))
                worker.once("exit", (code) => {
                  if (code !== 0) finish({ error: new Error(`minidump worker exited with code ${code}`) })
                })
                worker.once("message", (message: Response) => {
                  if (message.type === "completed") finish({ value: message.result })
                  else finish({ error: new Error(message.error) })
                })
                signal.addEventListener("abort", onAbort, { once: true })
                if (signal.aborted) return onAbort()
                const bytes = new Uint8Array(request.bytes)
                worker.postMessage({ ...request, bytes }, [bytes.buffer])
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
  const packaged = resources ? path.join(resources, "minidump", "minidump-worker.js") : undefined
  if (packaged && existsSync(packaged)) return pathToFileURL(packaged)
  const executable = path.join(path.dirname(process.execPath), "minidump-worker.js")
  if (existsSync(executable)) return pathToFileURL(executable)
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js"
  return new URL(`./minidump-worker.${extension}`, import.meta.url)
}
