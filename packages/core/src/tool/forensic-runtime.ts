export * as ForensicRuntime from "./forensic-runtime"

import { existsSync } from "node:fs"
import path from "node:path"
import { Worker } from "node:worker_threads"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Context, Effect, Layer, Semaphore } from "effect"
import { makeGlobalNode } from "../effect/app-node"

export const targets = ["wifi-offline", "windows-artifacts", "rebuild-timeline"] as const
export type Target = (typeof targets)[number]

export interface Result {
  readonly schemaVersion: number
  readonly truncated: boolean
  readonly warnings: ReadonlyArray<string>
  readonly result: unknown
}

export interface Input {
  readonly target: Target
  readonly bytes: Uint8Array
  readonly options: Record<string, unknown>
}

export interface Interface {
  readonly analyze: (input: Input) => Effect.Effect<Result, Error>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/ForensicRuntime") {}

type Response =
  | { readonly type: "completed"; readonly result: Result }
  | { readonly type: "failed"; readonly error: string }

const layer = Layer.effect(
  Service,
  Effect.sync(() => {
    const execution = Semaphore.makeUnsafe(1)
    return Service.of({
      analyze: (input) =>
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
                  () => finish({ error: new Error("forensic analysis timed out after 30000ms") }),
                  30_000,
                )
                worker.once("error", (error) => finish({ error }))
                worker.once("exit", (code) => {
                  if (code !== 0) finish({ error: new Error(`forensic worker exited with code ${code}`) })
                })
                worker.on("message", (message: Response) => {
                  if (message.type === "completed") finish({ value: message.result })
                  else finish({ error: new Error(message.error) })
                })
                signal.addEventListener("abort", onAbort, { once: true })
                if (signal.aborted) return onAbort()
                const bytes = new Uint8Array(input.bytes)
                worker.postMessage({ ...input, bytes }, [bytes.buffer])
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
  const packaged = resources ? path.join(resources, "forensic-tools", "forensic-worker.js") : undefined
  if (packaged && existsSync(packaged)) return pathToFileURL(packaged)
  const executable = path.join(path.dirname(process.execPath), "forensic-worker.js")
  if (existsSync(executable)) return pathToFileURL(executable)
  const current = path.dirname(fileURLToPath(import.meta.url))
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js"
  const local = path.join(current, `forensic-worker.${extension}`)
  if (existsSync(local)) return pathToFileURL(local)
  return new URL(`./forensic-worker.${extension}`, import.meta.url)
}
