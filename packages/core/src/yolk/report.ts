import path from "node:path"
import type { CodeIndex, ImpactNode } from "./indexer"
import type { Language } from "./language"

export const VERSION = "0.2.0-top10"
export const EQUIVALENCE_PROFILE = "portable-common-expression-v1" as const
const MAX_REPORTED_CHANGES = 200
const MAX_REPORTED_RELATIONSHIPS = 1_000
const MAX_REVIEW_FILES = 500

export interface EquivalenceWitness {
  symbol: string
  language: Language
  location: string
  relation: "same-language-supported-subset" | "cross-language-portable-profile"
  source_term: string
  canonical_term: string
}

export interface AgentLocation {
  symbol: string
  path: string
  line: number
}

export interface AgentImpact {
  risk: "low" | "medium" | "high"
  riskReasons: string[]
  confidence: "high" | "partial" | "unknown"
  target: string
  directCallers: AgentLocation[]
  transitiveCallers: AgentLocation[]
  equivalentSymbols: Array<{ symbol: string; path: string }>
  unresolvedCalls: string[]
  indexHealth: {
    complete: boolean
    filesSkipped: number
    diagnostics: string[]
  }
  recommendedActions: string[]
}

export interface ImpactReport {
  engine: string
  target: string
  location: string
  language: Language
  symbol_kind: string
  visibility: "public" | "internal" | "unknown"
  semantic_confidence: string
  semantic_fingerprint: string
  source_term: string
  canonical_term: string
  calls_from_target: string[]
  direct_callers: ImpactNode[]
  transitive_callers: ImpactNode[]
  caller_relationships: { total: number; reported: number; truncated: boolean }
  semantic_equivalents: string[]
  equivalence_profile: typeof EQUIVALENCE_PROFILE
  equivalence_notice: string
  equivalence_witnesses: EquivalenceWitness[]
  unresolved_calls?: string[]
  suggested_review_scope: string[]
  index_stats: Record<string, unknown>
  agent: AgentImpact
}

export interface FunctionChange {
  symbol: string
  kind: "semantic-change" | "semantic-preserving-refactor" | "semantic-unknown"
  before_fingerprint: string
  after_fingerprint: string
  before_confidence: string
  after_confidence: string
  before_canonical: string
  after_canonical: string
  before_equivalents: string[]
  after_equivalents: string[]
  diverged_equivalents?: string[]
  impacted_callers?: ImpactNode[]
  impacted_callers_truncated?: boolean
}

export interface AgentChangeSummary {
  risk: "low" | "medium" | "high"
  confidence: "high" | "partial" | "unknown"
  indexHealth: AgentImpact["indexHealth"]
  recommendedActions: string[]
}

export interface CompareReport {
  engine: string
  before: string
  after: string
  source_edits: number
  semantic_changes: number
  semantic_preserving_refactors: number
  semantic_unknown: number
  added_symbols?: string[]
  removed_symbols?: string[]
  added_symbols_total?: number
  removed_symbols_total?: number
  added_symbols_truncated?: boolean
  removed_symbols_truncated?: boolean
  removed_symbol_impacts?: Array<{ symbol: string; callers: ImpactNode[]; truncated: boolean }>
  changes_truncated?: boolean
  changes: FunctionChange[]
  agent: AgentChangeSummary
}

export function buildImpactReport(index: CodeIndex, target: string): ImpactReport {
  const resolved = index.findSymbol(target)
  if (!resolved) throw new Error(`Symbol ${JSON.stringify(target)} was not found or is ambiguous`)
  const fn = index.functions.get(resolved)
  if (!fn) throw new Error(`Symbol ${JSON.stringify(resolved)} disappeared from the index`)

  const allImpact = index.impact(resolved)
  const impact = allImpact.slice(0, MAX_REPORTED_RELATIONSHIPS)
  const direct = impact.filter((node) => node.distance === 1)
  const transitive = impact.filter((node) => node.distance > 1)
  const equivalents = index.equivalents(resolved).slice(0, MAX_REPORTED_CHANGES)
  const review = new Set([fn.decl.file])
  equivalents.forEach((symbol) => {
    const equivalent = index.functions.get(symbol)
    if (equivalent) review.add(equivalent.decl.file)
  })
  direct.forEach((node) => {
    const caller = index.functions.get(node.symbol)
    if (caller) review.add(caller.decl.file)
  })

  return {
    engine: `yolk/${VERSION}`,
    target: resolved,
    location: `${path.relative(index.root, fn.decl.file)}:${fn.decl.line}`,
    language: fn.decl.language,
    symbol_kind: fn.decl.kind,
    visibility: fn.decl.visibility,
    semantic_confidence: fn.confidence,
    semantic_fingerprint: fn.fingerprint,
    source_term: fn.originalTerm,
    canonical_term: fn.canonical,
    calls_from_target: fn.calls,
    direct_callers: direct,
    transitive_callers: transitive,
    caller_relationships: {
      total: allImpact.length,
      reported: impact.length,
      truncated: allImpact.length > impact.length,
    },
    semantic_equivalents: equivalents,
    equivalence_profile: EQUIVALENCE_PROFILE,
    equivalence_notice:
      "Cross-language matches use an explicit portable expression profile and are not compiler proofs of identical runtime behavior.",
    equivalence_witnesses: equivalents.flatMap((symbol) => {
      const equivalent = index.functions.get(symbol)
      if (!equivalent) return []
      return [
        {
          symbol,
          language: equivalent.decl.language,
          location: `${path.relative(index.root, equivalent.decl.file)}:${equivalent.decl.line}`,
          relation:
            equivalent.decl.language === fn.decl.language
              ? ("same-language-supported-subset" as const)
              : ("cross-language-portable-profile" as const),
          source_term: equivalent.originalTerm,
          canonical_term: equivalent.canonical,
        },
      ]
    }),
    ...(fn.unresolvedCalls.length ? { unresolved_calls: fn.unresolvedCalls } : {}),
    suggested_review_scope: [...review]
      .map((file) => path.relative(index.root, file))
      .toSorted()
      .slice(0, MAX_REVIEW_FILES),
    index_stats: indexStats(index),
    agent: buildAgentImpact(
      index,
      resolved,
      fn.confidence,
      fn.decl.visibility,
      direct,
      transitive,
      equivalents,
      fn.unresolvedCalls,
    ),
  }
}

function buildAgentImpact(
  index: CodeIndex,
  target: string,
  semanticConfidence: string,
  visibility: "public" | "internal" | "unknown",
  direct: ImpactNode[],
  transitive: ImpactNode[],
  equivalents: string[],
  unresolvedCalls: string[],
): AgentImpact {
  const health = indexHealth(index)
  const complete = health.complete
  const sensitive = /(auth|permission|validat|session|persist|protocol|schema|parser|serial|filesystem)/i.test(target)
  const callers = direct.length + transitive.length
  const riskReasons = [
    ...(sensitive ? ["target belongs to a security, persistence, protocol, schema, parser, or filesystem domain"] : []),
    ...(direct.length ? [`${direct.length} direct caller(s)`] : []),
    ...(transitive.length ? [`${transitive.length} transitive caller(s)`] : []),
    ...(equivalents.length ? [`${equivalents.length} semantic equivalent review candidate(s)`] : []),
    ...(visibility === "public" ? ["target is externally visible"] : []),
    ...(!complete ? ["index is incomplete"] : []),
  ]
  const risk =
    sensitive || callers >= 5
      ? "high"
      : callers > 0 || equivalents.length > 0 || visibility === "public" || !complete
        ? "medium"
        : "low"
  const confidence = semanticConfidence !== "pure-expression" ? "unknown" : complete ? "high" : "partial"
  const locate = (node: ImpactNode): AgentLocation[] => {
    const fn = index.functions.get(node.symbol)
    return fn ? [{ symbol: node.symbol, path: path.relative(index.root, fn.decl.file), line: fn.decl.line }] : []
  }
  const equivalentSymbols = equivalents.flatMap((symbol) => {
    const fn = index.functions.get(symbol)
    return fn ? [{ symbol, path: path.relative(index.root, fn.decl.file) }] : []
  })
  const recommendedActions = [
    ...(direct.length ? [`Inspect direct callers in ${uniquePaths(direct.flatMap(locate)).join(", ")}`] : []),
    ...(equivalentSymbols.length
      ? [`Review equivalent implementations in ${uniquePaths(equivalentSymbols).join(", ")}`]
      : []),
    ...(unresolvedCalls.length
      ? ["Use read or grep to resolve unresolved calls before relying on the impact graph"]
      : []),
    ...(visibility === "public" ? ["Run contract or consumer tests for this public symbol"] : []),
    ...(!complete ? ["Treat no-caller results as inconclusive and run targeted tests"] : []),
    ...(sensitive ? ["Run targeted security, protocol, persistence, schema, or parser tests for this domain"] : []),
    ...(callers > 0 ? ["Run tests covering impacted callers after the change"] : []),
  ]
  return {
    risk,
    riskReasons: riskReasons.length ? riskReasons : ["no non-local risk signals detected"],
    confidence,
    target,
    directCallers: direct.flatMap(locate),
    transitiveCallers: transitive.flatMap(locate),
    equivalentSymbols,
    unresolvedCalls,
    indexHealth: health,
    recommendedActions: recommendedActions.length ? recommendedActions : ["Proceed with normal targeted tests"],
  }
}

function uniquePaths(values: ReadonlyArray<{ path: string }>) {
  return [...new Set(values.map((value) => value.path))].slice(0, 8)
}

function indexHealth(index: CodeIndex): AgentImpact["indexHealth"] {
  return {
    complete: index.stats.filesSkipped === 0 && index.stats.parseErrors === 0 && index.diagnostics.length === 0,
    filesSkipped: index.stats.filesSkipped,
    diagnostics: index.diagnostics.slice(0, 20).map((item) => `${item.kind}: ${item.file}: ${item.message}`),
  }
}

export function compareIndexes(before: CodeIndex, after: CodeIndex, filter = ""): CompareReport {
  const report: CompareReport = {
    engine: `yolk/${VERSION}`,
    before: before.root,
    after: after.root,
    source_edits: 0,
    semantic_changes: 0,
    semantic_preserving_refactors: 0,
    semantic_unknown: 0,
    changes: [],
    agent: {
      risk: "low",
      confidence: "high",
      indexHealth: { complete: true, filesSkipped: 0, diagnostics: [] },
      recommendedActions: [],
    },
  }
  const query = filter.toLowerCase()
  const added: string[] = []
  const removed: string[] = []
  let addedCount = 0
  let removedCount = 0
  const removedImpacts: NonNullable<CompareReport["removed_symbol_impacts"]> = []
  let changedCount = 0

  for (const symbol of new Set([...before.functions.keys(), ...after.functions.keys()])) {
    if (query && !symbol.toLowerCase().includes(query)) continue
    const previous = before.functions.get(symbol)
    const current = after.functions.get(symbol)
    if (!previous) {
      addedCount++
      if (added.length < MAX_REPORTED_CHANGES) added.push(symbol)
      continue
    }
    if (!current) {
      removedCount++
      if (removed.length < MAX_REPORTED_CHANGES) removed.push(symbol)
      const callers = before.impact(symbol)
      if (removedImpacts.length < MAX_REPORTED_CHANGES)
        removedImpacts.push({
          symbol,
          callers: callers.slice(0, MAX_REPORTED_RELATIONSHIPS),
          truncated: callers.length > MAX_REPORTED_RELATIONSHIPS,
        })
      continue
    }
    if (previous.sourceHash === current.sourceHash) continue

    report.source_edits++
    changedCount++
    const signatureChanged = previous.signatureHash !== current.signatureHash
    const comparable =
      !signatureChanged && previous.confidence === "pure-expression" && current.confidence === "pure-expression"
    const preserved = comparable && previous.fingerprint !== "" && previous.fingerprint === current.fingerprint
    const kind = preserved
      ? ("semantic-preserving-refactor" as const)
      : comparable
        ? ("semantic-change" as const)
        : ("semantic-unknown" as const)
    const beforeEquivalents = before.equivalents(symbol).slice(0, MAX_REPORTED_CHANGES)
    const afterEquivalents = after.equivalents(symbol).slice(0, MAX_REPORTED_CHANGES)
    const change: FunctionChange = {
      symbol,
      kind,
      before_fingerprint: previous.fingerprint,
      after_fingerprint: current.fingerprint,
      before_confidence: previous.confidence,
      after_confidence: current.confidence,
      before_canonical: previous.canonical,
      after_canonical: current.canonical,
      before_equivalents: beforeEquivalents,
      after_equivalents: afterEquivalents,
    }
    if (kind === "semantic-preserving-refactor") report.semantic_preserving_refactors++
    if (kind === "semantic-change") {
      report.semantic_changes++
      change.diverged_equivalents = difference(beforeEquivalents, afterEquivalents)
      const callers = before.impact(symbol)
      change.impacted_callers = callers.slice(0, MAX_REPORTED_RELATIONSHIPS)
      change.impacted_callers_truncated = callers.length > MAX_REPORTED_RELATIONSHIPS
    }
    if (kind === "semantic-unknown") {
      report.semantic_unknown++
      const callers = before.impact(symbol)
      change.impacted_callers = callers.slice(0, MAX_REPORTED_RELATIONSHIPS)
      change.impacted_callers_truncated = callers.length > MAX_REPORTED_RELATIONSHIPS
    }
    if (report.changes.length < MAX_REPORTED_CHANGES) report.changes.push(change)
  }

  report.changes.sort((left, right) => left.symbol.localeCompare(right.symbol))
  if (added.length) report.added_symbols = added.toSorted()
  if (removed.length) report.removed_symbols = removed.toSorted()
  report.added_symbols_total = addedCount
  report.removed_symbols_total = removedCount
  report.added_symbols_truncated = addedCount > added.length
  report.removed_symbols_truncated = removedCount > removed.length
  if (removedImpacts.length)
    report.removed_symbol_impacts = removedImpacts.toSorted((a, b) => a.symbol.localeCompare(b.symbol))
  report.changes_truncated = changedCount > report.changes.length
  const health = combineIndexHealth(indexHealth(before), indexHealth(after))
  const sensitivePattern = /(auth|permission|validat|session|persist|protocol|schema|parser|serial|filesystem)/i
  const sensitive = [...report.changes.map((change) => change.symbol), ...added, ...removed].some((symbol) =>
    sensitivePattern.test(symbol),
  )
  report.agent = {
    risk:
      report.semantic_changes > 0 || sensitive
        ? "high"
        : report.semantic_unknown > 0 || added.length > 0 || removed.length > 0
          ? "medium"
          : "low",
    confidence: report.semantic_unknown > 0 ? "unknown" : health.complete ? "high" : "partial",
    indexHealth: health,
    recommendedActions: [
      ...(report.semantic_changes > 0 ? ["Inspect impacted callers and run their targeted tests"] : []),
      ...(report.semantic_unknown > 0
        ? ["Unknown-confidence Yolk output is not a diagnosis; use code reading and fail-before/pass-after tests"]
        : []),
      ...(added.length > 0 || removed.length > 0
        ? ["Review added and removed shared symbols and update callers and targeted tests"]
        : []),
      ...(removedImpacts.some((impact) => impact.callers.length > 0)
        ? ["Inspect callers of removed symbols before completing the change"]
        : []),
      ...(report.changes_truncated ? ["Use a narrower symbol filter because the change report is truncated"] : []),
      ...(report.added_symbols_truncated || report.removed_symbols_truncated
        ? ["Use a narrower symbol filter because added or removed symbol evidence is truncated"]
        : []),
      ...(sensitive ? ["Run targeted security, protocol, persistence, schema, or parser tests"] : []),
      ...(!health.complete ? ["Treat no-caller results as inconclusive because the index is incomplete"] : []),
    ],
  }
  return report
}

function difference(left: string[], right: string[]) {
  const values = new Set(right)
  return left.filter((value) => !values.has(value)).toSorted()
}

function combineIndexHealth(before: AgentImpact["indexHealth"], after: AgentImpact["indexHealth"]) {
  return {
    complete: before.complete && after.complete,
    filesSkipped: before.filesSkipped + after.filesSkipped,
    diagnostics: [
      ...before.diagnostics.map((item) => `before: ${item}`),
      ...after.diagnostics.map((item) => `after: ${item}`),
    ].slice(0, 20),
  }
}

function indexStats(index: CodeIndex): Record<string, unknown> {
  return {
    files: index.stats.files,
    files_seen: index.stats.filesSeen,
    files_skipped: index.stats.filesSkipped,
    parse_errors: index.stats.parseErrors,
    cache_hits: index.stats.cacheHits,
    functions: index.stats.functions,
    eclasses: index.stats.eClasses,
    enodes: index.stats.eNodes,
    files_by_language: Object.fromEntries(index.stats.filesByLanguage),
    symbols_by_language: Object.fromEntries(index.stats.symbolsByLanguage),
    diagnostic_count: index.diagnostics.length,
    lex_and_lower_ms: index.stats.lexAndLowerMs,
    saturation_ms: index.stats.saturationMs,
    runner_iterations: index.stats.runner.iterations,
    runner_stop_reason: index.stats.runner.stopReason,
    rewrite_applications: index.stats.runner.rewriteApplications,
  }
}
