import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { parentPort } from "node:worker_threads"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { CaptureInput, StringInput, UnpackInput } from "./binary-analysis-runtime"

type Request =
  | { readonly kind: "inspect"; readonly bytes: Uint8Array }
  | { readonly kind: "strings"; readonly input: StringInput }
  | { readonly kind: "capture"; readonly input: CaptureInput }
  | { readonly kind: "unpack"; readonly input: UnpackInput }

if (!parentPort) throw new Error("binary analysis worker requires a parent port")
const port = parentPort

port.once("message", async (request: Request) => {
  try {
    const result = await execute(request)
    if (request.kind === "unpack") {
      const output = result as { bytes: Uint8Array; metadata: unknown }
      const bytes = new Uint8Array(output.bytes)
      port.postMessage({ type: "completed", result: { ...output, bytes } }, [bytes.buffer])
      return
    }
    port.postMessage({ type: "completed", result })
  } catch (cause) {
    port.postMessage({ type: "failed", error: cause instanceof Error ? cause.message : String(cause) })
  }
})

async function execute(request: Request) {
  if (request.kind === "inspect") {
    const root = resolveRoot("goblin", "turen_goblin_wasm.js", "@turenlabs/goblin-wasm")
    const api = await import(pathToFileURL(path.join(root, "turen_goblin_wasm.js")).href)
    await api.default({ module_or_path: await readFile(path.join(root, "turen_goblin_wasm_bg.wasm")) })
    return JSON.parse(api.inspect(request.bytes))
  }
  if (request.kind === "strings") {
    const root = resolveRoot("stng-core", "turen_stng_core_wasm.js", "@turenlabs/stng-core-wasm")
    const api = await import(pathToFileURL(path.join(root, "turen_stng_core_wasm.js")).href)
    await api.default({ module_or_path: await readFile(path.join(root, "turen_stng_core_wasm_bg.wasm")) })
    return JSON.parse(
      api.extract(
        request.input.bytes,
        request.input.minLength,
        request.input.decode,
        request.input.autoXor,
        request.input.xorKey,
      ),
    )
  }
  if (request.kind === "capture") {
    const root = resolveRoot("libpcap", "libpcap.mjs", "@turenlabs/libpcap-wasm")
    const createLibpcap = (await import(pathToFileURL(path.join(root, "libpcap.mjs")).href)).default
    const runtime = await createLibpcap({ locateFile: (file: string) => path.join(root, file) })
    const result = runtime.inspectCapture(
      request.input.bytes,
      request.input.filter,
      request.input.offset,
      request.input.maxPackets,
      request.input.maxPacketBytes,
    )
    if (result.error) throw new Error(result.error)
    return {
      ...result,
      packets: result.packets.map((packet: { bytes: Uint8Array }) => ({
        ...packet,
        bytes: undefined,
        bytesHex: Buffer.from(packet.bytes).toString("hex"),
      })),
    }
  }
  const root = resolveRoot("static-unpack", "index.js", "@turenlabs/static-unpack-wasm")
  const api = await import(pathToFileURL(path.join(root, "index.js")).href)
  const runtime = await api.createStaticUnpack({
    mpressWasm: await readFile(path.join(root, "mpress/turen_mpress_wasm_bg.wasm")),
    locateFile: (file: string) => path.join(root, file),
  })
  const probe = runtime.probe(request.input.bytes)
  const packer = request.input.packer === "auto" ? probe.packer : request.input.packer
  if (packer === "upx") return runtime.unpackUpx(request.input.bytes)
  if (packer === "mpress") return runtime.unpackMpress(request.input.bytes)
  throw new Error(probe.error ?? "input is not a supported UPX or MPRESS executable")
}

function resolveRoot(directory: string, marker: string, packageName: string) {
  const current = path.dirname(fileURLToPath(import.meta.url))
  const roots = [path.join(current, directory, "dist"), path.join(path.dirname(process.execPath), directory, "dist")]
  const bundled = roots.find((candidate) => existsSync(path.join(candidate, marker)))
  if (bundled) return bundled
  return path.dirname(fileURLToPath(import.meta.resolve(packageName)))
}
