import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { parentPort } from "node:worker_threads"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Input, Result } from "./static-analysis-runtime"

if (!parentPort) throw new Error("static analysis worker requires a parent port")
const port = parentPort

port.once("message", async (request: Input) => {
  try {
    const result = await execute(request)
    port.postMessage({ type: "completed", result })
  } catch (cause) {
    port.postMessage({ type: "failed", error: cause instanceof Error ? cause.message : String(cause) })
  }
})

async function execute(request: Input): Promise<Result> {
  if (request.operation === "monodis") return executeMonodis(request)
  const root = resolveRoot()
  const extension =
    ["function_flow", "vba_extract", "dotnet_methods", "detect_packer"].includes(request.operation) ||
    (request.operation === "disassemble" && request.options?.architecture === "arm64")
  const archive = request.operation === "list_archive" || request.operation === "extract_archive_entry"
  if (extension || archive) {
    const api = await import(pathToFileURL(path.join(root, "extensions/turen_static_analysis_wasm.js")).href)
    await api.default({
      module_or_path: await readFile(path.join(root, "extensions/turen_static_analysis_wasm_bg.wasm")),
    })
    if (extension || api.supports_archive(request.bytes))
      return JSON.parse(api.analyze(request.operation, request.bytes, JSON.stringify(request.options ?? {})))
  }
  // Preserve the shipped parsers: upstream source does not reproduce every operation in this artifact.
  const api = await import(pathToFileURL(path.join(root, "turen_static_analysis_wasm.js")).href)
  await api.default({ module_or_path: await readFile(path.join(root, "turen_static_analysis_wasm_bg.wasm")) })
  return JSON.parse(api.analyze(request.operation, request.bytes, JSON.stringify(request.options ?? {})))
}

async function executeMonodis(request: Input): Promise<Result> {
  if (request.bytes.byteLength > 32 * 1024 * 1024)
    return {
      schemaVersion: 1,
      operation: "monodis",
      truncated: false,
      warnings: [],
      result: { error: "input_too_large" },
    }
  const require = createRequire(import.meta.url)
  const packaged = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const roots = [
    packaged ? path.join(packaged, "monodis") : undefined,
    packaged ? path.join(packaged, "binary-tools", "monodis") : undefined,
    path.join(path.dirname(process.execPath), "monodis"),
    path.join(path.dirname(process.execPath), "binary-tools", "monodis"),
  ].filter((value): value is string => value !== undefined)
  const packagedRoot = roots.find((root) => existsSync(path.join(root, "package.json")))
  const moduleFactory = (packagedRoot
    ? require(path.join(packagedRoot, "dist/monodis.js"))
    : require("@turenlabs/monodis-wasm")) as () => Promise<MonodisModule>
  const module = await moduleFactory()
  module._init_monodis()
  const pointer = module._malloc(request.bytes.byteLength)
  try {
    module.HEAPU8.set(request.bytes, pointer)
    const resultPointer = module.ccall(
      "monodis_disassemble",
      "number",
      ["number", "number", "string"],
      [pointer, request.bytes.byteLength, JSON.stringify(request.options ?? {})],
    )
    try {
      const text = module.UTF8ToString(resultPointer)
      return {
        schemaVersion: 1,
        operation: "monodis",
        truncated: text.includes("[output truncated"),
        warnings: [],
        result: { text },
      }
    } finally {
      module._free_string(resultPointer)
    }
  } finally {
    module._free(pointer)
  }
}

type MonodisModule = {
  readonly HEAPU8: Uint8Array
  readonly _init_monodis: () => void
  readonly _malloc: (size: number) => number
  readonly _free: (pointer: number) => void
  readonly _free_string: (pointer: number) => void
  readonly ccall: (
    name: string,
    returnType: string,
    argumentTypes: string[],
    argumentsList: Array<number | string>,
  ) => number
  readonly UTF8ToString: (pointer: number) => string
}

function resolveRoot() {
  const current = path.dirname(fileURLToPath(import.meta.url))
  const roots = [
    path.join(current, "dist"),
    path.join(current, "static-analysis", "dist"),
    path.join(path.dirname(process.execPath), "static-analysis", "dist"),
  ]
  const bundled = roots.find((candidate) => existsSync(path.join(candidate, "turen_static_analysis_wasm.js")))
  if (bundled) return bundled
  return path.dirname(fileURLToPath(import.meta.resolve("@turenlabs/static-analysis-wasm")))
}
