import path from "node:path"
import { open, opendir, readFile, realpath, stat } from "node:fs/promises"
import {
  MAX_SOURCE_FILE_BYTES,
  detectLanguage,
  lexLanguage,
  pathModule,
  shouldSkipIndexDir,
  shouldSkipIndexPath,
} from "./language"
import { parseGoUnit, parseJavaUnit } from "./indexer"
import { parserForLanguage } from "./parsers"
import type { SymbolCandidate } from "./runtime"

const MAX_DISCOVERY_FILES = 2_000
const MAX_DISCOVERY_BYTES = 16 * 1024 * 1024
const DISCOVERY_CONCURRENCY = 8
const MAX_DISCOVERY_PATHS = 100

export type SymbolDiscoveryResult = {
  symbols: SymbolCandidate[]
  diagnostics: string[]
  filesSeen: number
  filesParsed: number
  filesSkipped: number
  truncated: boolean
}

type DiscoveryFile = { file: string; size: number }
type FileResult = { symbols: SymbolCandidate[]; diagnostic?: string; parsed: boolean }

export async function discoverPathSymbolsDetailed(
  root: string,
  paths: string[],
  signal?: AbortSignal,
): Promise<SymbolDiscoveryResult> {
  const canonicalRoot = await realpath(path.resolve(root))
  const diagnostics: string[] = []
  const traversal = { files: 0, truncated: false }
  const requested = [...new Set(paths)].slice(0, MAX_DISCOVERY_PATHS)
  if (paths.length > requested.length) diagnostics.push(`path discovery input limit reached (${MAX_DISCOVERY_PATHS})`)
  const collected = (
    await mapConcurrent(requested, DISCOVERY_CONCURRENCY, async (input) => {
      const target = await realpath(path.resolve(canonicalRoot, input)).catch(() => undefined)
      if (!target || (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}${path.sep}`))) {
        diagnostics.push(`${input}: path is missing or outside the workspace`)
        return []
      }
      return collectFiles(target, diagnostics, traversal, signal)
    })
  )
    .flat()
    .toSorted((left, right) => left.file.localeCompare(right.file))

  const files = collected.slice(0, MAX_DISCOVERY_FILES)
  let sourceBytes = 0
  let truncated = traversal.truncated || paths.length > requested.length
  const admitted: DiscoveryFile[] = []
  for (const file of files) {
    if (file.size > MAX_SOURCE_FILE_BYTES) {
      diagnostics.push(`${relative(canonicalRoot, file.file)}: source file exceeds 8 MiB`)
      continue
    }
    if (sourceBytes + file.size > MAX_DISCOVERY_BYTES) {
      truncated = true
      continue
    }
    sourceBytes += file.size
    admitted.push(file)
  }
  if (traversal.truncated) diagnostics.push(`path discovery file limit reached (${MAX_DISCOVERY_FILES})`)
  if (truncated && admitted.length < files.length)
    diagnostics.push(`path discovery source byte limit reached (${MAX_DISCOVERY_BYTES})`)

  const results = await mapConcurrent(admitted, DISCOVERY_CONCURRENCY, (file) =>
    discoverFile(canonicalRoot, file.file, signal),
  )
  results.forEach((result) => {
    if (result.diagnostic) diagnostics.push(result.diagnostic)
  })
  return {
    symbols: results
      .flatMap((result) => result.symbols)
      .toSorted((left, right) => left.symbol.localeCompare(right.symbol)),
    diagnostics: [...new Set(diagnostics)].slice(0, 50),
    filesSeen: collected.length,
    filesParsed: results.filter((result) => result.parsed).length,
    filesSkipped: collected.length - results.filter((result) => result.parsed).length,
    truncated,
  }
}

export async function discoverPathSymbols(root: string, paths: string[], signal?: AbortSignal) {
  return (await discoverPathSymbolsDetailed(root, paths, signal)).symbols
}

async function discoverFile(root: string, file: string, signal?: AbortSignal): Promise<FileResult> {
  signal?.throwIfAborted()
  const relativePath = relative(root, file)
  const source = await readFile(file, { encoding: "utf8", signal }).catch((error: unknown) => {
    if (signal?.aborted) throw error
    return undefined
  })
  if (source === undefined)
    return { symbols: [], diagnostic: `${relativePath}: source could not be read`, parsed: false }
  if (source.includes("\0")) return { symbols: [], diagnostic: `${relativePath}: binary source skipped`, parsed: false }
  const language = detectLanguage(file, source)
  if (!language) return { symbols: [], diagnostic: `${relativePath}: unsupported source language`, parsed: false }
  try {
    const tokens = lexLanguage(source, language)
    const unit =
      language === "go"
        ? parseGoUnit(file, tokens)
        : language === "java"
          ? parseJavaUnit(file, tokens)
          : parserForLanguage(root, file, language, source, tokens)
    unit.package ||= pathModule(root, file, language)
    return {
      parsed: true,
      symbols: unit.functions.map((fn) => ({
        symbol: fn.symbol,
        path: relativePath,
        line: fn.line,
        language,
        kind: fn.kind || (fn.receiver ? "method" : "function"),
      })),
    }
  } catch (error) {
    return {
      symbols: [],
      diagnostic: `${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      parsed: false,
    }
  }
}

async function collectFiles(
  target: string,
  diagnostics: string[],
  traversal: { files: number; truncated: boolean },
  signal?: AbortSignal,
): Promise<DiscoveryFile[]> {
  signal?.throwIfAborted()
  if (traversal.files >= MAX_DISCOVERY_FILES) {
    traversal.truncated = true
    return []
  }
  const metadata = await stat(target).catch(() => undefined)
  if (!metadata) return []
  if (metadata.isFile()) {
    if (shouldSkipIndexPath(target)) return []
    traversal.files++
    return [{ file: target, size: metadata.size }]
  }
  if (!metadata.isDirectory()) return []
  const files: DiscoveryFile[] = []
  try {
    for await (const entry of await opendir(target)) {
      signal?.throwIfAborted()
      if (traversal.files >= MAX_DISCOVERY_FILES) {
        traversal.truncated = true
        break
      }
      if (entry.isDirectory() && shouldSkipIndexDir(entry.name)) continue
      const nested = path.join(target, entry.name)
      if (entry.isDirectory()) files.push(...(await collectFiles(nested, diagnostics, traversal, signal)))
      if (entry.isFile() && !shouldSkipIndexPath(nested)) {
        const size = await fileSize(nested, signal)
        if (size !== undefined) {
          traversal.files++
          files.push({ file: nested, size })
        }
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error
    diagnostics.push(`${target}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return files
}

async function fileSize(file: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const handle = await open(file, "r").catch(() => undefined)
  if (!handle) return
  try {
    return (await handle.stat()).size
  } finally {
    await handle.close()
  }
}

async function mapConcurrent<Input, Output>(
  input: readonly Input[],
  concurrency: number,
  run: (value: Input) => Promise<Output>,
) {
  const output = new Array<Output>(input.length)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, input.length) }, async () => {
      for (;;) {
        const index = cursor++
        const value = input[index]
        if (value === undefined) return
        output[index] = await run(value)
      }
    }),
  )
  return output
}

function relative(root: string, file: string) {
  return path.relative(root, file).split(path.sep).join("/")
}
