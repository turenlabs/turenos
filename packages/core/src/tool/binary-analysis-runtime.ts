export * as BinaryAnalysisRuntime from "./binary-analysis-runtime"

import { existsSync } from "node:fs"
import path from "node:path"
import { Worker } from "node:worker_threads"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Context, Effect, Layer, Semaphore } from "effect"
import { makeGlobalNode } from "../effect/app-node"

export interface BinaryInspection {
  readonly schemaVersion: number
  readonly format: string
  readonly architecture: string
  readonly bits?: number
  readonly endian?: string
  readonly entryPoint?: string
  readonly imageBase?: string
  readonly isLibrary?: boolean
  readonly interpreter?: string
  readonly sections: ReadonlyArray<Record<string, string>>
  readonly segments: ReadonlyArray<Record<string, string>>
  readonly imports: ReadonlyArray<Record<string, string | number | undefined>>
  readonly exports: ReadonlyArray<Record<string, string | undefined>>
  readonly symbols: ReadonlyArray<Record<string, string>>
  readonly libraries: ReadonlyArray<string>
  readonly members: ReadonlyArray<{
    readonly name: string
    readonly size: string
    readonly symbols: ReadonlyArray<string>
  }>
  readonly warnings: ReadonlyArray<string>
  readonly truncated: boolean
}

export interface StringFinding {
  readonly value: string
  readonly offset: number
  readonly length: number
  readonly method: string
  readonly kind: string | null
  readonly xorKey: string | null
}

export interface StringResult {
  readonly schemaVersion: number
  readonly strings: ReadonlyArray<StringFinding>
  readonly truncated: boolean
  readonly warnings: ReadonlyArray<string>
}

export interface CapturePacket {
  readonly number: number
  readonly seconds: number
  readonly microseconds: number
  readonly capturedLength: number
  readonly originalLength: number
  readonly bytesHex: string
  readonly bytesTruncated: boolean
}

export interface CaptureResult {
  readonly datalink: number
  readonly datalinkName: string
  readonly datalinkDescription: string
  readonly offset: number
  readonly packets: ReadonlyArray<CapturePacket>
  readonly nextOffset: number | null
  readonly eof: boolean
}

export interface UnpackMetadata {
  readonly packer: "upx" | "mpress"
  readonly version?: string
  readonly method?: string
  readonly outputSize: number
  readonly importsRebuilt: boolean
  readonly runnable: boolean
  readonly entryPoint?: string
}

export interface Interface {
  readonly inspect: (bytes: Uint8Array) => Effect.Effect<BinaryInspection, Error>
  readonly strings: (input: StringInput) => Effect.Effect<StringResult, Error>
  readonly capture: (input: CaptureInput) => Effect.Effect<CaptureResult, Error>
  readonly unpack: (
    input: UnpackInput,
  ) => Effect.Effect<{ readonly bytes: Uint8Array; readonly metadata: UnpackMetadata }, Error>
}

export interface StringInput {
  readonly bytes: Uint8Array
  readonly minLength: number
  readonly decode: boolean
  readonly autoXor: boolean
  readonly xorKey: Uint8Array
}

export interface CaptureInput {
  readonly bytes: Uint8Array
  readonly filter: string
  readonly offset: number
  readonly maxPackets: number
  readonly maxPacketBytes: number
}

export interface UnpackInput {
  readonly bytes: Uint8Array
  readonly packer: "auto" | "upx" | "mpress"
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/BinaryAnalysisRuntime") {}

type Request =
  | { readonly kind: "inspect"; readonly bytes: Uint8Array }
  | { readonly kind: "strings"; readonly input: StringInput }
  | { readonly kind: "capture"; readonly input: CaptureInput }
  | { readonly kind: "unpack"; readonly input: UnpackInput }

type Response =
  | { readonly type: "completed"; readonly result: unknown }
  | { readonly type: "failed"; readonly error: string }

const layer = Layer.effect(
  Service,
  Effect.sync(() => {
    const execution = Semaphore.makeUnsafe(1)
    const run = <A>(request: Request, timeoutMs: number) =>
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
                () => finish({ error: new Error(`binary analysis timed out after ${timeoutMs}ms`) }),
                timeoutMs,
              )
              worker.once("error", (error) => finish({ error }))
              worker.once("exit", (code) => {
                if (code !== 0) finish({ error: new Error(`binary analysis worker exited with code ${code}`) })
              })
              worker.on("message", (message: Response) => {
                if (message.type === "completed") finish({ value: message.result as A })
                else finish({ error: new Error(message.error) })
              })
              signal.addEventListener("abort", onAbort, { once: true })
              if (signal.aborted) return onAbort()
              const bytes = new Uint8Array(request.kind === "inspect" ? request.bytes : request.input.bytes)
              const transferred =
                request.kind === "inspect" ? { ...request, bytes } : { ...request, input: { ...request.input, bytes } }
              worker.postMessage(transferred, [bytes.buffer])
            }),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        }),
      )

    return Service.of({
      inspect: (bytes) => run<BinaryInspection>({ kind: "inspect", bytes }, 15_000),
      strings: (input) => run<StringResult>({ kind: "strings", input }, 30_000),
      capture: (input) => run<CaptureResult>({ kind: "capture", input }, 15_000),
      unpack: (input) => run<{ bytes: Uint8Array; metadata: UnpackMetadata }>({ kind: "unpack", input }, 60_000),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })

function workerURL() {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const packaged = resources ? path.join(resources, "binary-tools", "binary-analysis-worker.js") : undefined
  if (packaged && existsSync(packaged)) return pathToFileURL(packaged)
  const executable = path.join(path.dirname(process.execPath), "binary-analysis-worker.js")
  if (existsSync(executable)) return pathToFileURL(executable)
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js"
  return new URL(`./binary-analysis-worker.${extension}`, import.meta.url)
}
