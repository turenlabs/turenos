import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { parentPort } from "node:worker_threads"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Input, Match, Metadata, Pattern, Result } from "./yara-runtime"

type Api = typeof import("@turenlabs/yara-x-wasm")
type RawResult = {
  readonly valid: boolean
  readonly matches: ReadonlyArray<RawMatch>
  readonly warnings: ReadonlyArray<string>
  readonly truncated: boolean
}
type RawMatch = {
  readonly identifier: string
  readonly namespace: string
  readonly isPrivate: boolean
  readonly isGlobal: boolean
  readonly tags: ReadonlyArray<string>
  readonly metadata: ReadonlyArray<{ readonly identifier: string; readonly value: unknown }>
  readonly patterns: ReadonlyArray<{
    readonly identifier: string
    readonly kind: string
    readonly isPrivate: boolean
    readonly matches: ReadonlyArray<{ readonly offset: number; readonly length: number }>
  }>
}
type Response =
  | { readonly type: "completed"; readonly result: Result }
  | { readonly type: "failed"; readonly error: string }

if (!parentPort) throw new Error("YARA worker requires a parent port")
const port = parentPort
const root = resolveRoot()
const api = (await import(pathToFileURL(path.join(root, "yara_x_js.js")).href)) as Api
await api.default({ module_or_path: await readFile(path.join(root, "yara_x_js_bg.wasm")) })

port.once("message", (input: Input) => {
  try {
    port.postMessage({ type: "completed", result: scan(input) } satisfies Response)
  } catch (cause) {
    port.postMessage({
      type: "failed",
      error: cause instanceof Error ? cause.message : String(cause),
    } satisfies Response)
  }
})

function scan(input: Input): Result {
  const compiler = new api.Compiler()
  try {
    compiler.addSource(input.rules)
    const rules = compiler.build()
    try {
      const scanner = rules.scanner()
      try {
        scanner.setTimeoutMs(input.timeoutMs)
        scanner.setMaxMatchesPerPattern(input.maxMatchesPerPattern)
        return normalize(scanner.scan(input.bytes) as RawResult, input.maxRules)
      } finally {
        scanner.free()
      }
    } finally {
      rules.free()
    }
  } finally {
    compiler.free()
  }
}

function normalize(result: RawResult, maxRules: number): Result {
  if (!result.valid) throw new Error("YARA-X returned an invalid scan result")
  const budget = {
    matches: 4_096,
    metadata: 4_096,
    patterns: 4_096,
    tags: 4_096,
    truncated: result.truncated || result.matches.length > maxRules,
  }
  return {
    matches: result.matches.slice(0, maxRules).map((match) => normalizeMatch(match, budget)),
    warnings: result.warnings.slice(0, 256),
    truncated: budget.truncated,
  }
}

type Budget = {
  matches: number
  metadata: number
  patterns: number
  tags: number
  truncated: boolean
}

function normalizeMatch(match: RawMatch, budget: Budget): Match {
  const tags = take(match.tags, "tags", budget)
  const metadata = take(match.metadata, "metadata", budget).map(normalizeMetadata)
  const patterns = take(match.patterns, "patterns", budget).map((pattern) => normalizePattern(pattern, budget))
  return {
    identifier: match.identifier,
    namespace: match.namespace,
    isPrivate: match.isPrivate,
    isGlobal: match.isGlobal,
    tags,
    metadata,
    patterns,
  }
}

function normalizeMetadata(metadata: RawMatch["metadata"][number]): Metadata {
  const value = metadata.value
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return { identifier: metadata.identifier, value }
  if (value instanceof Uint8Array) return { identifier: metadata.identifier, value: Buffer.from(value).toString("hex") }
  return { identifier: metadata.identifier, value: String(value) }
}

function normalizePattern(pattern: RawMatch["patterns"][number], budget: Budget): Pattern {
  const matches = take(pattern.matches, "matches", budget)
  return {
    identifier: pattern.identifier,
    kind: pattern.kind,
    isPrivate: pattern.isPrivate,
    matches: matches.map((match) => ({ offset: match.offset, length: match.length })),
  }
}

function take<A>(items: ReadonlyArray<A>, key: "matches" | "metadata" | "patterns" | "tags", budget: Budget) {
  const selected = items.slice(0, budget[key])
  budget[key] -= selected.length
  if (selected.length < items.length) budget.truncated = true
  return selected
}

function resolveRoot() {
  const roots = [
    ...(import.meta.url.startsWith("file:")
      ? [path.join(path.dirname(fileURLToPath(import.meta.url)), "yara-x", "dist")]
      : []),
    path.join(path.dirname(process.execPath), "yara-x", "dist"),
  ]
  const bundled = roots.find((candidate) => existsSync(path.join(candidate, "yara_x_js.js")))
  if (bundled) return bundled
  return path.dirname(fileURLToPath(import.meta.resolve("@turenlabs/yara-x-wasm")))
}
