export * as DecompilerRuntime from "./decompiler-runtime"

import { existsSync } from "node:fs"
import path from "node:path"
import { Worker } from "node:worker_threads"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import { makeGlobalNode } from "../effect/app-node"

export const Architecture = Schema.Literals(["x86", "x86_64", "arm", "arm64", "mips", "ppc", "riscv"])
export type Architecture = typeof Architecture.Type
export const Endianness = Schema.Literals(["little", "big"])
export type Endianness = typeof Endianness.Type

export interface Input {
  readonly bytes: Uint8Array
  readonly architecture: Architecture
  readonly endianness: Endianness
  readonly baseAddress: number
  readonly address: number
}

export interface Interface {
  readonly decompile: (input: Input) => Effect.Effect<string, Error>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/DecompilerRuntime") {}
export const REQUEST_TIMEOUT_MS = 60_000
const WORKER_READY_TIMEOUT_MS = 15_000

type Request = {
  readonly id: number
  readonly input: Input
}

type Response =
  | { readonly id: number; readonly type: "started" }
  | { readonly id: number; readonly type: "completed"; readonly code: string }
  | { readonly id: number; readonly type: "failed"; readonly error: string }

type Pending = {
  readonly resolve: (value: string) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
  phase: "queued" | "running"
}

type RuntimeWorker = {
  readonly worker: Worker
  readonly ready: Promise<void>
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const pending = new Map<number, Pending>()
    const execution = Semaphore.makeUnsafe(1)
    let worker: RuntimeWorker | undefined
    let nextID = 0

    const clearPending = (id: number) => {
      const entry = pending.get(id)
      if (!entry) return undefined
      pending.delete(id)
      clearTimeout(entry.timer)
      return entry
    }

    const stopWorker = (current: RuntimeWorker, cause: unknown) => {
      if (worker !== current) return
      worker = undefined
      const error = cause instanceof Error ? cause : new Error(String(cause))
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(error)
      }
      pending.clear()
      current.worker.unref()
      void current.worker.terminate()
    }

    const startWorker = () => {
      if (worker) return worker
      const currentWorker = createWorker()
      let online = false
      const current: RuntimeWorker = {
        worker: currentWorker,
        ready: new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`Decompiler worker did not start within ${WORKER_READY_TIMEOUT_MS}ms`)),
            WORKER_READY_TIMEOUT_MS,
          )
          currentWorker.once("online", () => {
            online = true
            clearTimeout(timer)
            resolve()
          })
          currentWorker.once("error", (cause) => {
            if (online) return
            clearTimeout(timer)
            reject(cause)
          })
          currentWorker.once("exit", (code) => {
            if (online) return
            clearTimeout(timer)
            reject(new Error(`Decompiler worker exited before startup with code ${code}`))
          })
        }),
      }
      worker = current
      void current.ready.catch((cause) => stopWorker(current, cause))
      currentWorker.on("message", (message: Response) => {
        const entry = pending.get(message.id)
        if (!entry) return
        if (message.type === "started") {
          entry.phase = "running"
          return
        }
        const settled = clearPending(message.id)
        if (!settled) return
        if (message.type === "completed") settled.resolve(message.code)
        else settled.reject(new Error(message.error))
        if (pending.size === 0) currentWorker.unref()
      })
      currentWorker.on("error", (cause) => {
        if (online) stopWorker(current, cause)
      })
      currentWorker.on("exit", (code) => {
        stopWorker(current, new Error(`Decompiler worker exited unexpectedly with code ${code}`))
      })
      return current
    }

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        const current = worker
        if (!current) return
        stopWorker(current, new Error("Decompiler runtime stopped"))
        await current.worker.terminate()
      }).pipe(Effect.ignore),
    )

    return Service.of({
      decompile: (input) =>
        execution.withPermit(
          Effect.suspend(() => {
            const id = nextID++
            return Effect.tryPromise({
              try: async (signal) => {
                const current = startWorker()
                const abortError = () =>
                  signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError")
                await new Promise<void>((resolve, reject) => {
                  const onAbort = () => {
                    const error = abortError()
                    stopWorker(current, error)
                    reject(error)
                  }
                  signal.addEventListener("abort", onAbort, { once: true })
                  if (signal.aborted) {
                    onAbort()
                    return
                  }
                  current.ready.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
                })
                return new Promise<string>((resolve, reject) => {
                  const onAbort = () => {
                    const entry = clearPending(id)
                    signal.removeEventListener("abort", onAbort)
                    if (!entry) return
                    const error = abortError()
                    entry.reject(error)
                    stopWorker(current, error)
                  }
                  const bytes = new Uint8Array(input.bytes)
                  const timer = setTimeout(() => {
                    const entry = pending.get(id)
                    if (!entry) return
                    signal.removeEventListener("abort", onAbort)
                    stopWorker(
                      current,
                      new Error(
                        `Decompiler request ${id} timed out after ${REQUEST_TIMEOUT_MS}ms while ${entry.phase}`,
                      ),
                    )
                  }, REQUEST_TIMEOUT_MS)
                  current.worker.ref()
                  pending.set(id, {
                    resolve: (value) => {
                      signal.removeEventListener("abort", onAbort)
                      resolve(value)
                    },
                    reject: (error) => {
                      signal.removeEventListener("abort", onAbort)
                      reject(error)
                    },
                    timer,
                    phase: "queued",
                  })
                  signal.addEventListener("abort", onAbort, { once: true })
                  if (signal.aborted) {
                    onAbort()
                    return
                  }
                  try {
                    current.worker.postMessage({ id, input: { ...input, bytes } } satisfies Request, [bytes.buffer])
                  } catch (cause) {
                    const entry = clearPending(id)
                    signal.removeEventListener("abort", onAbort)
                    current.worker.unref()
                    ;(entry?.reject ?? reject)(cause instanceof Error ? cause : new Error(String(cause)))
                  }
                })
              },
              catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
            })
          }),
        ),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })

function workerURL() {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const packaged = resources ? path.join(resources, "decompiler", "decompiler-worker.js") : undefined
  if (packaged && existsSync(packaged)) return pathToFileURL(packaged)
  const executable = path.join(path.dirname(process.execPath), "decompiler-worker.js")
  if (existsSync(executable)) return pathToFileURL(executable)
  const current = path.dirname(fileURLToPath(import.meta.url))
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js"
  const local = path.join(current, `decompiler-worker.${extension}`)
  if (existsSync(local)) return pathToFileURL(local)
  return new URL(`./decompiler-worker.${extension}`, import.meta.url)
}

function createWorker() {
  const worker = new Worker(workerURL())
  worker.unref()
  return worker
}
