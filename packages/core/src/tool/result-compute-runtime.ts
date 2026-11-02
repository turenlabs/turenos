export * as ResultComputeRuntime from "./result-compute-runtime"

import { existsSync } from "node:fs"
import path from "node:path"
import { Worker } from "node:worker_threads"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { CodeMode } from "@turenlabs/codemode"
import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { BoundedJson } from "../util/bounded-json"

export const maxCodeBytes = 16 * 1024
export const maxDataBytes = 8 * 1024 * 1024
export const maxOutputBytes = 8 * 1024
export const maxToolCalls = 0
export const maxAllocationBytes = 128 * 1024 * 1024
export const maxOperations = 1_000_000
export const timeoutMs = 1000
export const wallTimeoutMs = 3000
export const concurrency = 1

export const Request = Schema.Struct({ code: Schema.String, dataJson: Schema.String })
export type Request = typeof Request.Type
export const Response = Schema.Union([
  Schema.Struct({ type: Schema.Literal("completed"), resultJson: Schema.String }),
  Schema.Struct({ type: Schema.Literal("failed") }),
])
export type Response = typeof Response.Type

export class Error extends Schema.TaggedErrorClass<Error>()("ResultComputeError", { message: Schema.String }) {}

export interface Interface {
  readonly run: (input: { readonly code: string; readonly data: Schema.Json }) => Effect.Effect<CodeMode.Result, Error>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/ResultComputeRuntime") {}

const layer = Layer.effect(
  Service,
  Effect.sync(() => {
    const execution = Semaphore.makeUnsafe(concurrency)
    return Service.of({
      run: (input) =>
        execution.withPermit(
          Effect.gen(function* () {
            if (Buffer.byteLength(input.code) > maxCodeBytes)
              return yield* Effect.fail(new Error({ message: "Computation code exceeds the 16 KiB limit." }))
            const dataJson = yield* Effect.try({
              try: () => BoundedJson.encode(input.data, maxDataBytes),
              catch: () => new Error({ message: "Computation data must be JSON." }),
            })
            if (typeof dataJson !== "string")
              return yield* Effect.fail(
                new Error({ message: "Computation data exceeds its JSON size or complexity limit." }),
              )
            if (Buffer.byteLength(dataJson) > maxDataBytes)
              return yield* Effect.fail(new Error({ message: "Computation data exceeds the 8 MiB limit." }))
            const { CodeMode } = yield* Effect.promise(() => import("@turenlabs/codemode"))
            // The finalizer finishes before the semaphore releases its permit, including on cancellation.
            return yield* Effect.acquireUseRelease(
              Effect.try({
                try: () =>
                  new Worker(workerURL(), {
                    env: {},
                    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
                  }),
                catch: () => new Error({ message: "Computation worker could not start." }),
              }),
              (worker) =>
                Effect.tryPromise({
                  try: (signal) =>
                    new Promise<CodeMode.Result>((resolve, reject) => {
                      let settled = false
                      const finish = (result: { value: CodeMode.Result } | { error: Error }) => {
                        if (settled) return
                        settled = true
                        clearTimeout(timer)
                        signal.removeEventListener("abort", onAbort)
                        if ("error" in result) reject(result.error)
                        else resolve(result.value)
                      }
                      const onAbort = () => finish({ error: new Error({ message: "Computation cancelled." }) })
                      // Native string/regexp operations can block the interpreter's own timeout.
                      // The parent deadline terminates their worker independently of its event loop.
                      const timer = setTimeout(
                        () =>
                          finish({
                            error: new Error({ message: "Computation exceeded the 3000ms wall-clock limit." }),
                          }),
                        wallTimeoutMs,
                      )
                      worker.once("error", () =>
                        finish({ error: new Error({ message: "Computation worker failed." }) }),
                      )
                      worker.once("exit", () =>
                        finish({ error: new Error({ message: "Computation worker exited without a result." }) }),
                      )
                      worker.once("message", (message: unknown) => {
                        const decoded = Schema.decodeUnknownExit(Response)(message)
                        if (decoded._tag === "Failure")
                          return finish({ error: new Error({ message: "Invalid computation worker response." }) })
                        if (decoded.value.type === "failed")
                          return finish({ error: new Error({ message: "Computation worker failed." }) })
                        if (Buffer.byteLength(decoded.value.resultJson) > maxOutputBytes)
                          return finish({
                            error: new Error({ message: "Computation worker output exceeded its limit." }),
                          })
                        const json = Schema.decodeUnknownExit(Schema.UnknownFromJsonString)(decoded.value.resultJson)
                        const result =
                          json._tag === "Success" ? Schema.decodeUnknownExit(CodeMode.Result)(json.value) : json
                        if (result._tag === "Failure" || result.value.toolCalls.length > 0)
                          return finish({ error: new Error({ message: "Invalid computation worker result." }) })
                        finish({ value: result.value })
                      })
                      signal.addEventListener("abort", onAbort, { once: true })
                      if (signal.aborted) return onAbort()
                      try {
                        worker.postMessage({ code: input.code, dataJson } satisfies Request)
                      } catch {
                        finish({ error: new Error({ message: "Computation worker could not receive its input." }) })
                      }
                    }),
                  catch: (cause) =>
                    cause instanceof Error ? cause : new Error({ message: "Computation worker failed." }),
                }),
              (worker) =>
                Effect.promise(async () => {
                  // Acquire may complete just before cancellation prevents use from installing its listeners.
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

function workerURL() {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const packaged = resources ? path.join(resources, "result-compute", "result-compute-worker.js") : undefined
  if (packaged && existsSync(packaged)) return pathToFileURL(packaged)
  const executable = path.join(path.dirname(process.execPath), "result-compute-worker.js")
  if (existsSync(executable)) return pathToFileURL(executable)
  const development = new URL("./result-compute/result-compute-worker.js", import.meta.url)
  if (existsSync(fileURLToPath(development))) return development
  return new URL(`./result-compute-worker.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url)
}
