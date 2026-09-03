import path from "node:path"
import { IndexCache, buildIndex, type BuildIndexOptions, type CodeIndex } from "./indexer"
import { VERSION, buildImpactReport, compareIndexes, type CompareReport, type ImpactReport } from "./report"
import { discoverPathSymbolsDetailed } from "./symbol-table"

const BASELINE_TTL_MS = 5 * 60_000

export type Build = (root: string, options?: BuildIndexOptions) => Promise<CodeIndex>
export type InspectInput = { symbol?: string; path?: string; symbols?: readonly string[]; paths?: readonly string[] }
export type SymbolCandidate = {
  symbol: string
  path: string
  line: number
  language: string
  kind: string
}
export type SymbolLookupReport = {
  engine: string
  lookup: "symbol-discovery"
  query?: string
  path?: string
  symbols: SymbolCandidate[]
  total_symbols?: number
  symbols_truncated?: boolean
  instruction: string
  index_diagnostics: string[]
  discovery?: {
    filesSeen: number
    filesParsed: number
    filesSkipped: number
    truncated: boolean
  }
}
export type BatchInspectReport = {
  engine: string
  mode: "batch-impact"
  impacts: ImpactReport[]
  unresolved: SymbolLookupReport[]
  instruction: string
}
export type InspectOutput = ImpactReport | SymbolLookupReport | BatchInspectReport

function normalizePath(value: string) {
  return value
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^\/+|\/+$/g, "")
}

function discoverSymbols(index: CodeIndex, input: InspectInput) {
  const requestedPaths = [...new Set([...(input.paths ?? []), ...(input.path ? [input.path] : [])].map(normalizePath))]
  const query = input.symbol?.trim().toLowerCase()
  const matches = [...index.functions.entries()]
    .flatMap(([symbol, fn]) => {
      const relative = normalizePath(path.relative(index.root, fn.decl.file))
      if (
        requestedPaths.length > 0 &&
        !requestedPaths.some((requestedPath) => relative === requestedPath || relative.endsWith(`/${requestedPath}`))
      )
        return []
      const lowered = symbol.toLowerCase()
      const name = fn.decl.name.toLowerCase()
      const score = !query
        ? 0
        : lowered === query
          ? 0
          : name === query || lowered.endsWith(`.${query}`)
            ? 1
            : lowered.includes(query)
              ? 2
              : 3
      if (query && score === 3) return []
      return [{ symbol, path: relative, line: fn.decl.line, language: fn.decl.language, kind: fn.decl.kind, score }]
    })
    .toSorted((a, b) => a.score - b.score || a.symbol.localeCompare(b.symbol))
  return {
    symbols: matches.slice(0, 50).map(({ score: _score, ...candidate }) => candidate),
    total: matches.length,
  }
}

function lookupReport(index: CodeIndex, input: InspectInput): SymbolLookupReport {
  const discovery = discoverSymbols(index, input)
  return {
    engine: VERSION,
    lookup: "symbol-discovery",
    ...(input.symbol ? { query: input.symbol } : {}),
    ...(input.path || input.paths?.length
      ? { path: [input.path, ...(input.paths ?? [])].filter(Boolean).join(", ") }
      : {}),
    symbols: discovery.symbols,
    total_symbols: discovery.total,
    symbols_truncated: discovery.total > discovery.symbols.length,
    instruction:
      "Retry inspect_change with one exact symbol from symbols. To discover symbols first, pass the source path without a symbol. Do not create probe files.",
    index_diagnostics: index.diagnostics
      .filter((item) => item.kind === "repository-limit")
      .slice(0, 5)
      .map((item) => `${item.file}: ${item.message}`),
  }
}

function inspectIndex(index: CodeIndex, input: InspectInput): InspectOutput {
  const symbol = input.symbol?.trim()
  if (!symbol) return lookupReport(index, input)
  if (!index.findSymbol(symbol)) return lookupReport(index, input)
  return buildImpactReport(index, symbol)
}

function discoveryReport(
  paths: string[],
  discovery: Awaited<ReturnType<typeof discoverPathSymbolsDetailed>>,
): SymbolLookupReport {
  return {
    engine: `yolk/${VERSION}`,
    lookup: "symbol-discovery",
    path: paths.join(", "),
    symbols: discovery.symbols,
    total_symbols: discovery.symbols.length,
    symbols_truncated: discovery.truncated,
    index_diagnostics: discovery.diagnostics,
    discovery: {
      filesSeen: discovery.filesSeen,
      filesParsed: discovery.filesParsed,
      filesSkipped: discovery.filesSkipped,
      truncated: discovery.truncated,
    },
    instruction: discovery.symbols.length
      ? "Retry inspect_change once with one or more exact values from symbols. Do not create probe files."
      : "No supported function or method symbols were found at these paths. Verify the paths with read or glob; do not create probe files.",
  }
}

export function createYolkRuntime(root: string, build: Build = buildIndex) {
  const lifetime = new AbortController()
  const cache = new IndexCache()
  const baselines = new Map<string, { index: CodeIndex; generation: number; timeout: ReturnType<typeof setTimeout> }>()
  let generation = 0
  let snapshot: { generation: number; promise: Promise<CodeIndex> } | undefined
  let completed: { generation: number; index: CodeIndex } | undefined
  let queue = Promise.resolve()

  function serialized<T>(operation: () => Promise<T>) {
    const result = queue.then(operation, operation)
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  const signal = (external?: AbortSignal) => (external ? AbortSignal.any([external, lifetime.signal]) : lifetime.signal)
  const waitFor = <Value>(promise: Promise<Value>, external?: AbortSignal) => {
    if (!external) return promise
    external.throwIfAborted()
    return new Promise<Value>((resolve, reject) => {
      const aborted = () => reject(external.reason)
      external.addEventListener("abort", aborted, { once: true })
      promise.then(resolve, reject).finally(() => external.removeEventListener("abort", aborted))
    })
  }
  const buildSnapshot = async (external?: AbortSignal): Promise<CodeIndex> => {
    for (;;) {
      const requested = generation
      if (completed?.generation === requested) return waitFor(Promise.resolve(completed.index), external)
      const current =
        snapshot?.generation === requested
          ? snapshot.promise
          : serialized(() => build(root, { signal: lifetime.signal, cache }))
      if (snapshot?.generation !== requested) {
        snapshot = { generation: requested, promise: current }
        void current.then(
          () => {
            if (snapshot?.promise === current) snapshot = undefined
          },
          () => {
            if (snapshot?.promise === current) snapshot = undefined
          },
        )
      }
      const index = await waitFor(current, external)
      if (generation !== requested) continue
      completed = { generation: requested, index }
      return index
    }
  }
  const remember = (key: string, index: CodeIndex) => {
    const previous = baselines.get(key)
    if (previous) clearTimeout(previous.timeout)
    const timeout = setTimeout(() => baselines.delete(key), BASELINE_TTL_MS)
    if (typeof timeout === "object") timeout.unref()
    baselines.set(key, { index, generation, timeout })
  }
  const invalidate = (paths: readonly string[]) => {
    generation++
    completed = undefined
    for (const value of paths) {
      const file = path.resolve(root, value)
      if (file === path.resolve(root) || file.startsWith(`${path.resolve(root)}${path.sep}`)) cache.delete(file)
    }
  }

  return {
    inspect: async (input: InspectInput, external?: AbortSignal) => {
      const paths = [...new Set([...(input.paths ?? []), ...(input.path ? [input.path] : [])])]
      const symbols = [...new Set([...(input.symbols ?? []), ...(input.symbol ? [input.symbol] : [])])]
      if (symbols.length === 0 && paths.length > 0) {
        return discoveryReport(paths, await discoverPathSymbolsDetailed(root, paths, signal(external)))
      }
      const index = await buildSnapshot(external)
      const results = symbols.map((symbol) => inspectIndex(index, { symbol, paths }))
      if (results.length === 1) return results[0]!
      return {
        engine: `yolk/${VERSION}`,
        mode: "batch-impact" as const,
        impacts: results.filter((result): result is ImpactReport => "target" in result),
        unresolved: results.filter((result): result is SymbolLookupReport => "symbols" in result),
        instruction: "Review each impact and follow its recommendedActions before editing.",
      }
    },
    before: async (key: string, external?: AbortSignal) => {
      if (baselines.has(key)) return
      const baseline = await buildSnapshot(external)
      if (lifetime.signal.aborted) return
      remember(key, baseline)
    },
    after: async (key: string, external?: AbortSignal) => {
      const baseline = baselines.get(key)
      if (!baseline) return
      clearTimeout(baseline.timeout)
      try {
        if (generation === baseline.generation) {
          generation++
          completed = undefined
        }
        const current = await buildSnapshot(external)
        baselines.delete(key)
        return compareIndexes(baseline.index, current)
      } catch (error) {
        baselines.delete(key)
        throw error
      }
    },
    discard: (key: string, paths: readonly string[] = []) => {
      const baseline = baselines.get(key)
      baselines.delete(key)
      if (baseline) {
        clearTimeout(baseline.timeout)
        invalidate(paths)
      }
    },
    invalidate,
    dispose: async () => {
      lifetime.abort()
      snapshot = undefined
      completed = undefined
      baselines.forEach((baseline) => clearTimeout(baseline.timeout))
      baselines.clear()
      await queue
    },
  }
}

export function hasYolkChanges(report: CompareReport) {
  return report.source_edits > 0 || !!report.added_symbols?.length || !!report.removed_symbols?.length
}

export function formatSemanticDiff(report: CompareReport) {
  const lines = [
    "Yolk semantic change check:",
    `- ${report.agent.risk.toUpperCase()} risk, ${report.agent.confidence} confidence`,
    `- ${report.semantic_changes} semantic change(s), ${report.semantic_preserving_refactors} preserving refactor(s), ${report.semantic_unknown} unknown change(s)`,
  ]
  for (const change of report.changes) {
    lines.push(`- ${change.symbol}: ${change.kind}`)
    if (change.diverged_equivalents?.length) {
      lines.push(`  Diverged equivalents: ${change.diverged_equivalents.join(", ")}`)
    }
    if (change.impacted_callers?.length) {
      lines.push(`  Impacted callers: ${change.impacted_callers.map((node) => node.symbol).join(", ")}`)
    }
  }
  if (report.added_symbols?.length) lines.push(`- Added symbols: ${report.added_symbols.join(", ")}`)
  if (report.removed_symbols?.length) lines.push(`- Removed symbols: ${report.removed_symbols.join(", ")}`)
  if (!report.agent.indexHealth.complete) {
    lines.push(`- Index incomplete: ${report.agent.indexHealth.filesSkipped} file(s) skipped`)
  }
  for (const action of report.agent.recommendedActions) lines.push(`- Recommended: ${action}`)
  return lines.join("\n")
}
