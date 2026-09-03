export * as ProtocolInspectRuntime from "./protocol-inspect-runtime"

import { existsSync } from "node:fs"
import path from "node:path"
import { Worker } from "node:worker_threads"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Context, Effect, Layer, Semaphore } from "effect"
import { makeGlobalNode } from "../effect/app-node"

export const MAX_PACKET_BYTES = 4096
export const MAX_LINK_TYPE = 0x7fffffff

export interface Input {
  readonly bytes: Uint8Array
  readonly linkType: number
}

export type Result = Record<string, unknown>

export interface Interface {
  readonly inspect: (input: Input) => Effect.Effect<Result, Error>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/ProtocolInspectRuntime") {}

type Response =
  | { readonly type: "completed"; readonly result: Result }
  | { readonly type: "failed"; readonly error: string }

const layer = Layer.effect(
  Service,
  Effect.sync(() => {
    const execution = Semaphore.makeUnsafe(1)
    const run = (input: Input) =>
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
                () => finish({ error: new Error("protocol inspection timed out after 15000ms") }),
                15_000,
              )
              worker.once("error", (error) => finish({ error }))
              worker.once("exit", (code) => {
                if (code !== 0) finish({ error: new Error(`protocol inspector worker exited with code ${code}`) })
              })
              worker.once("message", (message: Response) => {
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
      )

    return Service.of({
      inspect: (input) => {
        if (input.bytes.byteLength > MAX_PACKET_BYTES)
          return Effect.fail(new Error(`protocol packet exceeds the ${MAX_PACKET_BYTES}-byte limit`))
        if (!Number.isSafeInteger(input.linkType) || input.linkType < 0 || input.linkType > MAX_LINK_TYPE)
          return Effect.fail(new Error(`protocol link type must be an integer from 0 through ${MAX_LINK_TYPE}`))
        return run(input)
      },
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })

function workerURL() {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const packaged = resources ? path.join(resources, "protocol-inspect", "protocol-inspect-worker.js") : undefined
  if (packaged && existsSync(packaged)) return pathToFileURL(packaged)
  const executable = path.join(path.dirname(process.execPath), "protocol-inspect-worker.js")
  if (existsSync(executable)) return pathToFileURL(executable)
  const current = path.dirname(fileURLToPath(import.meta.url))
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js"
  const packagedLocal = path.join(current, "protocol-inspect", `protocol-inspect-worker.${extension}`)
  if (existsSync(packagedLocal)) return pathToFileURL(packagedLocal)
  const local = path.join(current, `protocol-inspect-worker.${extension}`)
  if (existsSync(local)) return pathToFileURL(local)
  return new URL(`./protocol-inspect-worker.${extension}`, import.meta.url)
}
