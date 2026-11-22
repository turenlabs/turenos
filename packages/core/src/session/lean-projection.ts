export * as SessionLeanProjection from "./lean-projection"

import path from "node:path"
import { Effect } from "effect"

export const maxBytes = 2 * 1024 * 1024

const completed = Buffer.from('"status":"completed"')
const failed = Buffer.from('"status":"error"')
const decoder = new TextDecoder("utf-8", { ignoreBOM: true })

export const load = Effect.tryPromise(async () => {
  if (typeof Bun === "undefined") return
  const { default: asset } = await import("../../native/transcript-projection/projection.wasm" as string, {
    with: { type: "file" },
  })
  const binary = await Bun.file(path.isAbsolute(asset) ? asset : new URL(asset, import.meta.url)).arrayBuffer()
  const result = await WebAssembly.instantiate(binary)
  const wasm = result.instance.exports as {
    memory: WebAssembly.Memory
    reserve: (length: number) => number
    project: () => number
    output: () => number
  }

  return (raw: Uint8Array) => {
    if (raw.byteLength > maxBytes) return
    // The usual encoding puts the status before the output. Skip the copy for
    // rows without a settled tool, then let the kernel validate the full shape.
    const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
    if (!bytes.includes(completed) && !bytes.includes(failed)) return
    try {
      const address = wasm.reserve(raw.byteLength)
      if (!address) return
      new Uint8Array(wasm.memory.buffer, address, raw.byteLength).set(raw)
      const length = wasm.project()
      if (!length) return
      const [entries, data] = JSON.parse(decoder.decode(new Uint8Array(wasm.memory.buffer, wasm.output(), length))) as [
        Array<[number, number]>,
        unknown,
      ]
      return { data, elided: new Map(entries) }
    } catch {
      // The full TypeScript decoder also handles unsupported runtime and data.
      return undefined
    }
  }
}).pipe(Effect.orElseSucceed(() => undefined))

export function decode(raw: string | Uint8Array, project: NonNullable<Effect.Success<typeof load>>) {
  if (typeof raw === "string") return { data: JSON.parse(raw) as unknown, elided: undefined }
  return project(raw) ?? { data: JSON.parse(decoder.decode(raw)) as unknown, elided: undefined }
}
