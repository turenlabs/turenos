export * as YaraRuntime from "./yara-runtime"

import { existsSync } from "node:fs"
import path from "node:path"
import { Worker } from "node:worker_threads"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Context, Effect, Layer, Semaphore } from "effect"
import { makeGlobalNode } from "../effect/app-node"

export interface Input {
  readonly bytes: Uint8Array
  readonly rules: string
  readonly timeoutMs: number
  readonly maxMatchesPerPattern: number
  readonly maxRules: number
}

export interface PatternMatch {
  readonly offset: number
  readonly length: number
}

export interface Pattern {
  readonly identifier: string
  readonly kind: string
  readonly isPrivate: boolean
  readonly matches: ReadonlyArray<PatternMatch>
}

export interface Metadata {
  readonly identifier: string
  readonly value: string | number | boolean
}

export interface Match {
  readonly identifier: string
  readonly namespace: string
  readonly isPrivate: boolean
  readonly isGlobal: boolean
  readonly tags: ReadonlyArray<string>
  readonly metadata: ReadonlyArray<Metadata>
  readonly patterns: ReadonlyArray<Pattern>
}

export interface Result {
  readonly matches: ReadonlyArray<Match>
  readonly warnings: ReadonlyArray<string>
  readonly truncated: boolean
}

export interface Interface {
  readonly scan: (input: Input) => Effect.Effect<Result, Error>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/YaraRuntime") {}

type Response =
  | { readonly type: "completed"; readonly result: Result }
  | { readonly type: "failed"; readonly error: string }

const layer = Layer.effect(
  Service,
  Effect.sync(() => {
    const execution = Semaphore.makeUnsafe(1)
    return Service.of({
      scan: (input) =>
        execution.withPermit(
          Effect.tryPromise({
            try: (signal) =>
              new Promise<Result>((resolve, reject) => {
                const worker = createWorker()
                let settled = false
                const finish = (result: { readonly value?: Result; readonly error?: Error }) => {
                  if (settled) return
                  settled = true
                  clearTimeout(timer)
                  signal.removeEventListener("abort", onAbort)
                  worker.removeAllListeners()
                  void worker.terminate().then(
                    () => {
                      if (result.error) reject(result.error)
                      else resolve(result.value!)
                    },
                    (cause) => reject(cause instanceof Error ? cause : new Error(String(cause))),
                  )
                }
                const onAbort = () =>
                  finish({
                    error: signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"),
                  })
                const timer = setTimeout(
                  () => finish({ error: new Error(`YARA worker timed out after ${input.timeoutMs + 2_000}ms`) }),
                  input.timeoutMs + 2_000,
                )
                worker.once("error", (error) => finish({ error }))
                worker.once("exit", (code) => {
                  if (code !== 0) finish({ error: new Error(`YARA worker exited unexpectedly with code ${code}`) })
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
  const packaged = resources ? path.join(resources, "yara", "yara-worker.js") : undefined
  if (packaged && existsSync(packaged)) return pathToFileURL(packaged)
  const executable = path.join(path.dirname(process.execPath), "yara-worker.js")
  if (existsSync(executable)) return pathToFileURL(executable)
  const current = path.dirname(fileURLToPath(import.meta.url))
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js"
  const local = path.join(current, `yara-worker.${extension}`)
  if (existsSync(local)) return pathToFileURL(local)
  return new URL(`./yara-worker.${extension}`, import.meta.url)
}

function createWorker() {
  return new Worker(workerURL())
}
