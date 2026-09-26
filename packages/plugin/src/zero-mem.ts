/**
 * An isolated, dependency-light memory prototype for plugin experiments.
 *
 * Zero-Mem intentionally stays independent of Turen, Core, and Server. It uses
 * a deterministic regex entity extractor and a BM25 lexical proxy instead of
 * spaCy, BGE-M3, embeddings, or model calls. The graph and temporal layers are
 * small, bounded in-memory approximations meant to be easy to adapt later.
 */

export type ZeroMemTimestamp = number | string | Date

export type ZeroMemMetadata = Readonly<Record<string, unknown>>

export interface ZeroMemTraceUnit {
  readonly id: string
  readonly text: string
  readonly sessionID?: string
  readonly timestamp: ZeroMemTimestamp
  readonly boundaryID?: string
  /** Optional host visibility scope, such as a Turen memory room. */
  readonly scopeID?: string
  /** Optional validity window for imported durable records. */
  readonly validFrom?: ZeroMemTimestamp
  readonly validUntil?: ZeroMemTimestamp
  readonly metadata?: ZeroMemMetadata
}

export type ZeroMemEntityKind = "url" | "path" | "identifier" | "cve" | "name" | "phrase"

export interface ZeroMemEntity {
  readonly kind: ZeroMemEntityKind
  readonly value: string
  readonly normalized: string
  readonly start: number
  readonly end: number
}

export type ZeroMemRoute = "relational" | "local"

export type ZeroMemAnswerType =
  | "fact"
  | "procedure"
  | "diagnosis"
  | "timeline"
  | "security"
  | "code"
  | "relation"
  | "unknown"

export interface ZeroMemQueryProfile {
  readonly query?: string
  readonly subject: string | undefined
  readonly keywords: readonly string[]
  readonly answerType: ZeroMemAnswerType
  readonly temporalCues: readonly string[]
  readonly sessionID?: string
  readonly boundaryID?: string
  readonly scopeID?: string
  readonly asOf?: ZeroMemTimestamp
  readonly includeExpired?: boolean
  readonly route: ZeroMemRoute
}

export interface ZeroMemProfileOptions {
  readonly sessionID?: string
  readonly boundaryID?: string
  readonly scopeID?: string
  readonly asOf?: ZeroMemTimestamp
  readonly includeExpired?: boolean
  readonly route?: ZeroMemRoute
}

export interface ZeroMemQuery {
  readonly query: string
  readonly topK?: number
  readonly sessionID?: string
  readonly boundaryID?: string
  readonly scopeID?: string
  readonly asOf?: ZeroMemTimestamp
  readonly includeExpired?: boolean
  readonly route?: ZeroMemRoute
}

export interface ZeroMemSearchOptions extends ZeroMemProfileOptions {
  readonly topK?: number
}

export interface ZeroMemOptions {
  /** Maximum number of calibrated results returned by search. */
  readonly topK?: number
  /** Maximum retained raw traces; oldest timestamps are evicted when exceeded. */
  readonly maxTraces?: number
  /** Number of turn units in one fixed-size temporal window. */
  readonly windowSize?: number
  /** Number of neighboring turn units considered by the local view. */
  readonly localRadius?: number
  /** Maximum graph propagation hops. Entity co-occurrence normally needs two. */
  readonly graphHops?: number
  /** Fusion weight for the graph view. */
  readonly graphWeight?: number
  /** Per-hop graph damping factor. */
  readonly damping?: number
  /** Optional fusion weight for lexical seeds. */
  readonly lexicalWeight?: number
  /** Optional fusion weight for the temporal local view. */
  readonly localWeight?: number
  /** BM25 term saturation. */
  readonly bm25K1?: number
  /** BM25 document length normalization. */
  readonly bm25B?: number
}

export type ZeroMemView = "lexical" | "graph" | "local"

export type ZeroMemResultView = ZeroMemView | "fused"

export type ZeroMemResultSource = "lexical-seed" | "graph-closure" | "local-closure"

export interface ZeroMemScoreComponents {
  readonly lexical: number
  readonly graph: number
  readonly local: number
}

export interface ZeroMemRelationMetadata {
  readonly kind: "entity-context" | "adjacent-context"
  readonly sourceTraceID: string
  readonly hops: number
  readonly entity?: string
}

export type ZeroMemClosureKind = "none" | "graph" | "neighbor" | "window" | "episode" | "mixed"

export interface ZeroMemClosureMetadata {
  readonly kind: ZeroMemClosureKind
  readonly sourceTraceIDs: readonly string[]
  readonly hops?: number
  readonly distance?: number
  readonly entity?: string
}

export interface ZeroMemResult {
  readonly score: number
  readonly trace: ZeroMemTraceUnit
  readonly view: ZeroMemResultView
  readonly source: ZeroMemResultSource | "mixed"
  readonly views: readonly ZeroMemView[]
  readonly sources: readonly ZeroMemResultSource[]
  readonly components: ZeroMemScoreComponents
  readonly relation: ZeroMemRelationMetadata | null
  readonly closure: ZeroMemClosureMetadata
}

export type ZeroMemGraphEdgeKind = "entity-context" | "adjacent-context"

export interface ZeroMemGraphEdge {
  readonly from: string
  readonly to: string
  readonly kind: ZeroMemGraphEdgeKind
  readonly weight: number
  readonly entity?: string
}

export interface ZeroMemStats {
  readonly traceCount: number
  readonly turnCount: number
  readonly tokenCount: number
  readonly entityCount: number
  readonly windowCount: number
  readonly episodeCount: number
  readonly graphNodeCount: number
  readonly graphEdgeCount: number
  readonly traces: number
  readonly tokens: number
  readonly entities: number
  readonly windows: number
  readonly episodes: number
  readonly graphNodes: number
  readonly graphEdges: number
  readonly buildVersion: number
}

export interface ZeroMemStore {
  /** Insert or replace trace units by id. Repeating an id never creates a duplicate. */
  upsert(input: ZeroMemTraceUnit | readonly ZeroMemTraceUnit[]): void
  /** Alias for upsert, useful for adapters that call ingestion explicitly. */
  ingest(input: ZeroMemTraceUnit | readonly ZeroMemTraceUnit[]): void
  remove(id: string): boolean
  get(id: string): ZeroMemTraceUnit | undefined
  profile(query: string, options?: ZeroMemProfileOptions): ZeroMemQueryProfile
  search(input: string | ZeroMemQuery | ZeroMemQueryProfile, options?: ZeroMemSearchOptions): ZeroMemResult[]
  retrieve(input: string | ZeroMemQuery | ZeroMemQueryProfile, options?: ZeroMemSearchOptions): ZeroMemResult[]
  rebuild(): ZeroMemStats
  clear(): void
  stats(): ZeroMemStats
  edges(): ZeroMemGraphEdge[]
  size(): number
}

interface NormalizedOptions {
  readonly topK: number
  readonly maxTraces: number
  readonly windowSize: number
  readonly localRadius: number
  readonly graphHops: number
  readonly graphWeight: number
  readonly damping: number
  readonly lexicalWeight: number
  readonly localWeight: number
  readonly bm25K1: number
  readonly bm25B: number
}

interface StoredTrace {
  readonly trace: ZeroMemTraceUnit
  readonly tokens: readonly string[]
  readonly termFrequency: Map<string, number>
  readonly entities: readonly ZeroMemEntity[]
  readonly sessionKey: string
  readonly timestampValue: number
  readonly validFromValue: number | undefined
  readonly validUntilValue: number | undefined
}

interface Placement {
  readonly episodeID: string
  readonly windowID: string
  readonly position: number
}

interface TemporalWindow {
  readonly id: string
  readonly episodeID: string
  readonly traceIDs: readonly string[]
}

interface TemporalEpisode {
  readonly id: string
  readonly sessionKey: string
  readonly boundaryID: string | undefined
  readonly traceIDs: readonly string[]
}

interface GraphLink {
  readonly node: string
  readonly kind: ZeroMemGraphEdgeKind
  readonly weight: number
  readonly entity?: string
}

interface BuiltIndex {
  readonly records: Map<string, StoredTrace>
  readonly ordered: readonly StoredTrace[]
  readonly documentFrequency: Map<string, number>
  readonly averageDocumentLength: number
  readonly placements: Map<string, Placement>
  readonly windows: readonly TemporalWindow[]
  readonly episodes: readonly TemporalEpisode[]
  readonly episodesByID: Map<string, TemporalEpisode>
  readonly graphEdges: readonly ZeroMemGraphEdge[]
  readonly graphAdjacency: Map<string, readonly GraphLink[]>
  readonly graphNodes: ReadonlySet<string>
  readonly stats: ZeroMemStats
}

interface PropagationState {
  readonly value: number
  readonly firstKind: ZeroMemGraphEdgeKind | undefined
  readonly entity: string | undefined
  readonly pathScore: number
  readonly hops: number
}

interface GraphRelationQuality {
  readonly score: number
  readonly relation: ZeroMemRelationMetadata
}

interface GraphScores {
  readonly scores: Map<string, number>
  readonly relations: Map<string, ZeroMemRelationMetadata>
}

interface LocalRelation {
  readonly kind: "neighbor" | "window" | "episode"
  readonly sourceTraceID: string
  readonly distance: number
  readonly windowID: string
  readonly episodeID: string
}

interface LocalScores {
  readonly scores: Map<string, number>
  readonly relations: Map<string, LocalRelation>
}

interface ResolvedQuery {
  readonly profile: ZeroMemQueryProfile
  readonly topK: number
}

const DEFAULT_OPTIONS: NormalizedOptions = {
  topK: 10,
  maxTraces: 50_000,
  windowSize: 8,
  localRadius: 2,
  graphHops: 2,
  graphWeight: 0.35,
  damping: 0.65,
  lexicalWeight: 1,
  localWeight: 0.4,
  bm25K1: 1.2,
  bm25B: 0.75,
}

// Prevent a plugin option from turning a cyclic graph into an event-loop stall.
const MAX_GRAPH_HOPS = 16
const MAX_GRAPH_SEEDS = 64
const MAX_GRAPH_LINKS_PER_NODE = 256
const MAX_GRAPH_FRONTIER = 1_024
const MAX_RESULT_LIMIT = 200
const MAX_TRACE_LIMIT = 100_000

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "i",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "their",
  "there",
  "this",
  "to",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "would",
  "you",
  "your",
])

const TEMPORAL_CUES = new Set([
  "after",
  "around",
  "before",
  "currently",
  "during",
  "earlier",
  "first",
  "following",
  "history",
  "last",
  "latest",
  "later",
  "near",
  "next",
  "now",
  "preceding",
  "previous",
  "prior",
  "recent",
  "since",
  "then",
  "timeline",
  "today",
  "until",
  "yesterday",
])

const RELATION_CUES = new Set([
  "associated",
  "between",
  "compare",
  "connection",
  "connected",
  "dependency",
  "impact",
  "link",
  "linked",
  "relationship",
  "related",
  "references",
  "relation",
  "same",
  "similar",
  "versus",
])

const SECURITY_CUES = new Set([
  "auth",
  "authentication",
  "authorization",
  "cve",
  "credential",
  "exploit",
  "permission",
  "secret",
  "security",
  "token",
  "tls",
  "vulnerability",
])

const CODE_CUES = new Set([
  "api",
  "class",
  "code",
  "config",
  "defined",
  "file",
  "function",
  "handler",
  "implementation",
  "import",
  "method",
  "module",
  "path",
  "repository",
  "route",
  "stack",
  "variable",
])

const PROCEDURE_CUES = new Set(["configure", "create", "fix", "install", "make", "resolve", "setup", "steps", "use"])

const DIAGNOSIS_CUES = new Set(["broken", "crash", "error", "failed", "failure", "issue", "problem", "why"])

const ENTITY_PRIORITY: Record<ZeroMemEntityKind, number> = {
  phrase: 6,
  url: 5,
  cve: 4,
  path: 3,
  name: 2,
  identifier: 1,
}

const TOKEN_PATTERN = /[A-Za-z0-9]+(?:[A-Za-z0-9_$./:\-]*[A-Za-z0-9])?/g
const URL_PATTERN = /\b(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>"'`]+/gi
const CVE_PATTERN = /\bCVE-\d{4}-\d{4,7}\b/gi
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:[\\/][^\s<>"'`]+/g
const UNIX_PATH_PATTERN = /\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\/?/g
const RELATIVE_PATH_PATTERN = /(?:\.\.\/|\.\/)[A-Za-z0-9._~\/\\-]+/g
const BARE_PATH_PATTERN = /\b[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)+\/?/g
const IDENTIFIER_PATTERN = /[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*/g
const NAME_PATTERN = /\b[A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*)*\b/g
const DOUBLE_QUOTE_PATTERN = /"([^"\n]+)"/g
const SINGLE_QUOTE_PATTERN = /'([^'\n]+)'/g
const BACKTICK_PATTERN = /`([^`\n]+)`/g

function tokenizeText(text: string): string[] {
  const tokens: string[] = []
  for (const match of text.toLowerCase().matchAll(TOKEN_PATTERN)) {
    const token = match[0]
    if (token.length > 0) tokens.push(token)
  }
  return tokens
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

function normalizeEntityValue(kind: ZeroMemEntityKind, value: string): string {
  const trimmed = value.trim().replace(/[.,;:!?]+$/g, "")
  if (kind === "phrase") return trimmed.replace(/\s+/g, " ")
  return trimmed
}

function normalizeEntity(kind: ZeroMemEntityKind, value: string): string {
  const normalized = normalizeEntityValue(kind, value).toLowerCase()
  if (kind === "path") return normalized.replace(/\\/g, "/")
  return normalized
}

function overlaps(a: Pick<ZeroMemEntity, "start" | "end">, b: Pick<ZeroMemEntity, "start" | "end">): boolean {
  return a.start < b.end && b.start < a.end
}

function isHighPriorityEntity(kind: ZeroMemEntityKind): boolean {
  return kind === "url" || kind === "cve" || kind === "path"
}

function isIdentifierCandidate(value: string, text: string, end: number): boolean {
  const lower = value.toLowerCase()
  if (STOP_WORDS.has(lower)) return false
  if (value.length < 2) return false
  if (/[_$.\d]/.test(value)) return true
  if (/[a-z][A-Z]/.test(value)) return true
  if (/^[A-Z]{2,}$/.test(value)) return true
  if (text[end] === "(") return true
  return false
}

function isNameCandidate(value: string): boolean {
  const first = value.split(/\s+/)[0] ?? value
  if (STOP_WORDS.has(first.toLowerCase())) return false
  if (!/[a-z]/.test(value)) return false
  return first.length > 1
}

function extractTextEntities(text: string): ZeroMemEntity[] {
  const candidates: ZeroMemEntity[] = []

  const addMatches = (
    pattern: RegExp,
    kind: ZeroMemEntityKind,
    valueFromMatch?: (match: RegExpMatchArray) => string,
  ) => {
    for (const match of text.matchAll(pattern)) {
      const raw = match[0]
      const value = valueFromMatch?.(match) ?? raw
      const normalizedValue = normalizeEntityValue(kind, value)
      if (normalizedValue.length === 0) continue
      const start = (match.index ?? 0) + (valueFromMatch ? raw.indexOf(value) : 0)
      candidates.push({
        kind,
        value: normalizedValue,
        normalized: normalizeEntity(kind, normalizedValue),
        start,
        end: start + normalizedValue.length,
      })
    }
  }

  addMatches(URL_PATTERN, "url")
  addMatches(CVE_PATTERN, "cve")
  addMatches(WINDOWS_PATH_PATTERN, "path")
  addMatches(UNIX_PATH_PATTERN, "path")
  addMatches(RELATIVE_PATH_PATTERN, "path")
  addMatches(BARE_PATH_PATTERN, "path")
  addMatches(DOUBLE_QUOTE_PATTERN, "phrase", (match) => match[1] ?? "")
  addMatches(SINGLE_QUOTE_PATTERN, "phrase", (match) => match[1] ?? "")
  addMatches(BACKTICK_PATTERN, "phrase", (match) => match[1] ?? "")

  for (const match of text.matchAll(IDENTIFIER_PATTERN)) {
    const value = match[0]
    const start = match.index ?? 0
    const end = start + value.length
    if (!isIdentifierCandidate(value, text, end)) continue
    candidates.push({
      kind: "identifier",
      value,
      normalized: normalizeEntity("identifier", value),
      start,
      end,
    })
  }

  for (const match of text.matchAll(NAME_PATTERN)) {
    const value = match[0]
    const start = match.index ?? 0
    if (!isNameCandidate(value)) continue
    candidates.push({
      kind: "name",
      value,
      normalized: normalizeEntity("name", value),
      start,
      end: start + value.length,
    })
  }

  const accepted: ZeroMemEntity[] = []
  const prioritySorted = [...candidates].sort((a, b) => {
    const priority = ENTITY_PRIORITY[b.kind] - ENTITY_PRIORITY[a.kind]
    if (priority !== 0) return priority
    if (a.start !== b.start) return a.start - b.start
    if (a.end !== b.end) return a.end - b.end
    return a.normalized < b.normalized ? -1 : a.normalized > b.normalized ? 1 : 0
  })

  for (const candidate of prioritySorted) {
    const blocked = accepted.some(
      (other) => isHighPriorityEntity(other.kind) && candidate.kind !== "phrase" && overlaps(candidate, other),
    )
    if (blocked) continue
    if (accepted.some((other) => other.kind === candidate.kind && other.normalized === candidate.normalized)) continue
    accepted.push(candidate)
  }

  return accepted.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start
    const priority = ENTITY_PRIORITY[b.kind] - ENTITY_PRIORITY[a.kind]
    if (priority !== 0) return priority
    return a.normalized < b.normalized ? -1 : a.normalized > b.normalized ? 1 : 0
  })
}

function finiteNumber(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback
}

function positiveInteger(value: number | undefined, fallback: number, minimum: number): number {
  return Math.max(minimum, Math.floor(finiteNumber(value, fallback)))
}

function nonNegativeNumber(value: number | undefined, fallback: number): number {
  return Math.max(0, finiteNumber(value, fallback))
}

function normalizeOptions(options: ZeroMemOptions | undefined): NormalizedOptions {
  return {
    topK: Math.min(MAX_RESULT_LIMIT, positiveInteger(options?.topK, DEFAULT_OPTIONS.topK, 0)),
    maxTraces: Math.min(MAX_TRACE_LIMIT, positiveInteger(options?.maxTraces, DEFAULT_OPTIONS.maxTraces, 1)),
    windowSize: positiveInteger(options?.windowSize, DEFAULT_OPTIONS.windowSize, 1),
    localRadius: positiveInteger(options?.localRadius, DEFAULT_OPTIONS.localRadius, 0),
    graphHops: Math.min(MAX_GRAPH_HOPS, positiveInteger(options?.graphHops, DEFAULT_OPTIONS.graphHops, 0)),
    graphWeight: nonNegativeNumber(options?.graphWeight, DEFAULT_OPTIONS.graphWeight),
    damping: Math.min(0.99, Math.max(0, finiteNumber(options?.damping, DEFAULT_OPTIONS.damping))),
    lexicalWeight: nonNegativeNumber(options?.lexicalWeight, DEFAULT_OPTIONS.lexicalWeight),
    localWeight: nonNegativeNumber(options?.localWeight, DEFAULT_OPTIONS.localWeight),
    bm25K1: Math.max(0.01, finiteNumber(options?.bm25K1, DEFAULT_OPTIONS.bm25K1)),
    bm25B: Math.min(1, Math.max(0, finiteNumber(options?.bm25B, DEFAULT_OPTIONS.bm25B))),
  }
}

function normalizeTopK(value: number | undefined, fallback: number): number {
  return Math.min(MAX_RESULT_LIMIT, positiveInteger(value, fallback, 0))
}

function timestampValue(timestamp: ZeroMemTimestamp): number {
  if (typeof timestamp === "number") return Number.isFinite(timestamp) ? timestamp : 0
  if (timestamp instanceof Date) {
    const value = timestamp.getTime()
    return Number.isFinite(value) ? value : 0
  }
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? parsed : 0
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function compareStored(a: StoredTrace, b: StoredTrace): number {
  if (a.timestampValue !== b.timestampValue) return a.timestampValue < b.timestampValue ? -1 : 1
  return compareStrings(a.trace.id, b.trace.id)
}

function makeStoredTrace(trace: ZeroMemTraceUnit): StoredTrace {
  const tokens = tokenizeText(trace.text)
  const termFrequency = new Map<string, number>()
  for (const token of tokens) termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1)
  return {
    trace,
    tokens,
    termFrequency,
    entities: extractTextEntities(trace.text),
    sessionKey: trace.sessionID ?? "",
    timestampValue: timestampValue(trace.timestamp),
    validFromValue: trace.validFrom === undefined ? undefined : timestampValue(trace.validFrom),
    validUntilValue: trace.validUntil === undefined ? undefined : timestampValue(trace.validUntil),
  }
}

function traceNodeID(id: string): string {
  return `trace:${id}`
}

function entityNodeID(entity: ZeroMemEntity): string {
  return `entity:${entity.kind}:${entity.normalized}`
}

function traceIDFromNode(node: string): string | undefined {
  return node.startsWith("trace:") ? node.slice("trace:".length) : undefined
}

function sameBoundary(a: string | undefined, b: string | undefined): boolean {
  return a === b
}

function addToNumberMap(map: Map<string, number>, key: string, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value)
}

function buildIndex(traces: readonly ZeroMemTraceUnit[], options: NormalizedOptions, buildVersion: number): BuiltIndex {
  const ordered = traces.map(makeStoredTrace).sort(compareStored)
  const records = new Map(ordered.map((record) => [record.trace.id, record]))
  const documentFrequency = new Map<string, number>()
  let tokenCount = 0
  for (const record of ordered) {
    tokenCount += record.tokens.length
    for (const token of new Set(record.tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
    }
  }

  const placements = new Map<string, Placement>()
  const windows: TemporalWindow[] = []
  const episodes: TemporalEpisode[] = []
  const episodesByID = new Map<string, TemporalEpisode>()
  const sessionGroups = new Map<string, StoredTrace[]>()
  for (const record of ordered) {
    const group = sessionGroups.get(record.sessionKey) ?? []
    group.push(record)
    sessionGroups.set(record.sessionKey, group)
  }

  let episodeNumber = 0
  const addEpisode = (group: readonly StoredTrace[], sessionKey: string, boundaryID: string | undefined) => {
    if (group.length === 0) return
    const episodeID = `episode:${episodeNumber}:${sessionKey || "none"}`
    episodeNumber += 1
    const traceIDs = group.map((record) => record.trace.id)
    const episode: TemporalEpisode = { id: episodeID, sessionKey, boundaryID, traceIDs }
    episodes.push(episode)
    episodesByID.set(episodeID, episode)
    for (let offset = 0, windowNumber = 0; offset < group.length; offset += options.windowSize, windowNumber += 1) {
      const windowRecords = group.slice(offset, offset + options.windowSize)
      const windowID = `window:${episodeID}:${windowNumber}`
      const windowTraceIDs = windowRecords.map((record) => record.trace.id)
      windows.push({ id: windowID, episodeID, traceIDs: windowTraceIDs })
      for (let position = 0; position < windowRecords.length; position += 1) {
        placements.set(windowRecords[position].trace.id, {
          episodeID,
          windowID,
          position: offset + position,
        })
      }
    }
  }

  const sortedSessions = [...sessionGroups.entries()].sort(([a], [b]) => compareStrings(a, b))
  for (const [sessionKey, group] of sortedSessions) {
    let segment: StoredTrace[] = []
    let segmentBoundary: string | undefined = group[0]?.trace.boundaryID
    for (const record of group) {
      if (segment.length > 0 && !sameBoundary(segmentBoundary, record.trace.boundaryID)) {
        addEpisode(segment, sessionKey, segmentBoundary)
        segment = []
        segmentBoundary = record.trace.boundaryID
      }
      segment.push(record)
    }
    addEpisode(segment, sessionKey, segmentBoundary)
  }

  const graphEdges: ZeroMemGraphEdge[] = []
  const graphAdjacency = new Map<string, GraphLink[]>()
  const graphNodes = new Set<string>()
  const uniqueEntities = new Set<string>()
  const addNode = (node: string) => graphNodes.add(node)
  const addEdge = (from: string, to: string, kind: ZeroMemGraphEdgeKind, weight: number, entity?: string) => {
    addNode(from)
    addNode(to)
    const edge: ZeroMemGraphEdge =
      entity === undefined ? { from, to, kind, weight } : { from, to, kind, weight, entity }
    graphEdges.push(edge)
    const fromLinks = graphAdjacency.get(from) ?? []
    fromLinks.push(entity === undefined ? { node: to, kind, weight } : { node: to, kind, weight, entity })
    graphAdjacency.set(from, fromLinks)
    const toLinks = graphAdjacency.get(to) ?? []
    toLinks.push(entity === undefined ? { node: from, kind, weight } : { node: from, kind, weight, entity })
    graphAdjacency.set(to, toLinks)
  }

  for (const record of ordered) {
    const traceNode = traceNodeID(record.trace.id)
    addNode(traceNode)
    const entities = [...record.entities].sort((a, b) => {
      const aKey = `${a.kind}:${a.normalized}`
      const bKey = `${b.kind}:${b.normalized}`
      return compareStrings(aKey, bKey)
    })
    for (const entity of entities) {
      const key = `${entity.kind}:${entity.normalized}`
      uniqueEntities.add(key)
      addEdge(traceNode, entityNodeID(entity), "entity-context", entity.kind === "cve" ? 1.25 : 1, entity.normalized)
    }
  }

  for (const episode of episodes) {
    for (let index = 1; index < episode.traceIDs.length; index += 1) {
      const previous = records.get(episode.traceIDs[index - 1])
      const current = records.get(episode.traceIDs[index])
      if (previous === undefined || current === undefined) continue
      addEdge(traceNodeID(previous.trace.id), traceNodeID(current.trace.id), "adjacent-context", 0.85)
    }
  }

  const sortedAdjacency = new Map<string, readonly GraphLink[]>()
  for (const [node, links] of graphAdjacency) {
    sortedAdjacency.set(
      node,
      [...links].sort((a, b) => {
        const nodeOrder = compareStrings(a.node, b.node)
        if (nodeOrder !== 0) return nodeOrder
        const kindOrder = compareStrings(a.kind, b.kind)
        if (kindOrder !== 0) return kindOrder
        return compareStrings(a.entity ?? "", b.entity ?? "")
      }),
    )
  }

  const averageDocumentLength = ordered.length === 0 ? 1 : tokenCount / ordered.length
  const stats: ZeroMemStats = {
    traceCount: ordered.length,
    turnCount: ordered.length,
    tokenCount,
    entityCount: uniqueEntities.size,
    windowCount: windows.length,
    episodeCount: episodes.length,
    graphNodeCount: graphNodes.size,
    graphEdgeCount: graphEdges.length,
    traces: ordered.length,
    tokens: tokenCount,
    entities: uniqueEntities.size,
    windows: windows.length,
    episodes: episodes.length,
    graphNodes: graphNodes.size,
    graphEdges: graphEdges.length,
    buildVersion,
  }

  return {
    records,
    ordered,
    documentFrequency,
    averageDocumentLength,
    placements,
    windows,
    episodes,
    episodesByID,
    graphEdges,
    graphAdjacency: sortedAdjacency,
    graphNodes,
    stats,
  }
}

function buildQueryProfile(query: string, options?: ZeroMemProfileOptions): ZeroMemQueryProfile {
  const tokens = tokenizeText(query)
  const entities = extractTextEntities(query)
  const temporalCues = uniqueStrings(tokens.filter((token) => TEMPORAL_CUES.has(token)))
  const keywords = uniqueStrings(
    tokens.filter((token) => token.length > 1 && !STOP_WORDS.has(token) && !TEMPORAL_CUES.has(token)),
  )
  const nonPhraseEntities = entities.filter((entity) => entity.kind !== "phrase")
  const subject = nonPhraseEntities[0]?.value ?? (keywords.length > 0 ? keywords.slice(0, 4).join(" ") : undefined)
  const answerType = determineAnswerType(tokens, entities)
  const explicitRoute = options?.route
  const relationCue = tokens.some((token) => RELATION_CUES.has(token))
  const multipleEntities = nonPhraseEntities.length >= 2
  const route = explicitRoute ?? (relationCue || multipleEntities || answerType === "relation" ? "relational" : "local")
  return {
    query,
    subject,
    keywords,
    answerType,
    temporalCues,
    sessionID: options?.sessionID,
    boundaryID: options?.boundaryID,
    scopeID: options?.scopeID,
    asOf: options?.asOf,
    includeExpired: options?.includeExpired,
    route,
  }
}

function determineAnswerType(tokens: readonly string[], entities: readonly ZeroMemEntity[]): ZeroMemAnswerType {
  if (tokens.some((token) => SECURITY_CUES.has(token)) || entities.some((entity) => entity.kind === "cve"))
    return "security"
  if (tokens.some((token) => DIAGNOSIS_CUES.has(token))) return "diagnosis"
  if (tokens.some((token) => PROCEDURE_CUES.has(token))) return "procedure"
  if (
    tokens.some((token) => CODE_CUES.has(token)) ||
    entities.some((entity) => entity.kind === "path" || entity.kind === "identifier")
  ) {
    return "code"
  }
  if (tokens.some((token) => TEMPORAL_CUES.has(token))) return "timeline"
  if (tokens.some((token) => RELATION_CUES.has(token))) return "relation"
  if (tokens.some((token) => token === "who" || token === "what" || token === "where")) return "fact"
  return "unknown"
}

function normalizeProfile(profile: ZeroMemQueryProfile, options?: ZeroMemSearchOptions): ZeroMemQueryProfile {
  const query = profile.query ?? [profile.subject ?? "", ...profile.keywords].join(" ").trim()
  const base = buildQueryProfile(query, {
    sessionID: options?.sessionID ?? profile.sessionID,
    boundaryID: options?.boundaryID ?? profile.boundaryID,
    scopeID: options?.scopeID ?? profile.scopeID,
    asOf: options?.asOf ?? profile.asOf,
    includeExpired: options?.includeExpired ?? profile.includeExpired,
    route: options?.route ?? profile.route,
  })
  const keywords = uniqueStrings(
    profile.keywords.length > 0
      ? profile.keywords.flatMap((keyword) => tokenizeText(keyword)).filter((keyword) => !STOP_WORDS.has(keyword))
      : base.keywords,
  )
  const temporalCues = uniqueStrings(
    profile.temporalCues.length > 0 ? profile.temporalCues.map((cue) => cue.toLowerCase()) : base.temporalCues,
  )
  return {
    query: profile.query,
    subject: profile.subject ?? base.subject,
    keywords,
    answerType: profile.answerType ?? base.answerType,
    temporalCues,
    sessionID: options?.sessionID ?? profile.sessionID,
    boundaryID: options?.boundaryID ?? profile.boundaryID,
    scopeID: options?.scopeID ?? profile.scopeID,
    asOf: options?.asOf ?? profile.asOf,
    includeExpired: options?.includeExpired ?? profile.includeExpired,
    route: options?.route ?? profile.route ?? base.route,
  }
}

function resolveQuery(
  input: string | ZeroMemQuery | ZeroMemQueryProfile,
  options: ZeroMemSearchOptions | undefined,
  defaultTopK: number,
): ResolvedQuery {
  if (typeof input === "string") {
    return {
      profile: buildQueryProfile(input, options),
      topK: normalizeTopK(options?.topK, defaultTopK),
    }
  }
  if (isQueryProfile(input)) {
    return {
      profile: normalizeProfile(input, options),
      topK: normalizeTopK(options?.topK, defaultTopK),
    }
  }
  return {
    profile: buildQueryProfile(input.query, {
      sessionID: options?.sessionID ?? input.sessionID,
      boundaryID: options?.boundaryID ?? input.boundaryID,
      scopeID: options?.scopeID ?? input.scopeID,
      asOf: options?.asOf ?? input.asOf,
      includeExpired: options?.includeExpired ?? input.includeExpired,
      route: options?.route ?? input.route,
    }),
    topK: normalizeTopK(options?.topK ?? input.topK, defaultTopK),
  }
}

function isQueryProfile(input: ZeroMemQuery | ZeroMemQueryProfile): input is ZeroMemQueryProfile {
  return "keywords" in input && Array.isArray(input.keywords)
}

function queryTermFrequency(profile: ZeroMemQueryProfile): Map<string, number> {
  const source = profile.keywords.length > 0 ? profile.keywords : tokenizeText(profile.query ?? profile.subject ?? "")
  const terms = source
    .flatMap((value) => tokenizeText(value))
    .filter((term) => term.length > 1 && !STOP_WORDS.has(term))
  const frequency = new Map<string, number>()
  for (const term of terms) frequency.set(term, (frequency.get(term) ?? 0) + 1)
  return frequency
}

function bm25Score(
  record: StoredTrace,
  queryTerms: ReadonlyMap<string, number>,
  index: BuiltIndex,
  options: NormalizedOptions,
): number {
  const documentCount = index.ordered.length
  if (documentCount === 0) return 0
  const documentLength = record.tokens.length
  let score = 0
  for (const [term, queryFrequency] of queryTerms) {
    const frequency = record.termFrequency.get(term) ?? 0
    if (frequency === 0) continue
    const documentFrequency = index.documentFrequency.get(term) ?? 0
    if (documentFrequency === 0) continue
    const idf = Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5))
    const normalization =
      options.bm25K1 * (1 - options.bm25B + options.bm25B * (documentLength / index.averageDocumentLength))
    const termScore = (frequency * (options.bm25K1 + 1)) / (frequency + normalization)
    score += idf * termScore * (1 + Math.log(queryFrequency))
  }
  return score
}

function isAllowedTrace(record: StoredTrace, profile: ZeroMemQueryProfile): boolean {
  if (profile.sessionID !== undefined && record.trace.sessionID !== profile.sessionID) return false
  if (profile.boundaryID !== undefined && record.trace.boundaryID !== profile.boundaryID) return false
  if (profile.scopeID !== undefined && record.trace.scopeID !== profile.scopeID) return false
  if (profile.includeExpired) return true
  const asOf = profile.asOf === undefined ? Date.now() : timestampValue(profile.asOf)
  if (record.validFromValue !== undefined && record.validFromValue > asOf) return false
  if (record.validUntilValue !== undefined && record.validUntilValue <= asOf) return false
  return true
}

function normalizeScoreMap(scores: ReadonlyMap<string, number>): Map<string, number> {
  let maximum = 0
  for (const score of scores.values()) maximum = Math.max(maximum, score)
  if (maximum <= 0) return new Map()
  return new Map([...scores.entries()].map(([id, score]) => [id, score / maximum]))
}

function relationIsBetter(next: GraphRelationQuality, current: GraphRelationQuality): boolean {
  if (next.score !== current.score) return next.score > current.score
  if (next.relation.hops !== current.relation.hops) return next.relation.hops < current.relation.hops
  const kindOrder = compareStrings(next.relation.kind, current.relation.kind)
  if (kindOrder !== 0) return kindOrder < 0
  if ((next.relation.entity ?? "") !== (current.relation.entity ?? "")) {
    return compareStrings(next.relation.entity ?? "", current.relation.entity ?? "") < 0
  }
  return compareStrings(next.relation.sourceTraceID, current.relation.sourceTraceID) < 0
}

function propagateGraph(
  index: BuiltIndex,
  seedScores: ReadonlyMap<string, number>,
  profile: ZeroMemQueryProfile,
  options: NormalizedOptions,
): GraphScores {
  const scores = new Map<string, number>()
  const relationQuality = new Map<string, GraphRelationQuality>()
  const seedIDs = [...seedScores.keys()]
    .sort((a, b) => {
      const scoreOrder = (seedScores.get(b) ?? 0) - (seedScores.get(a) ?? 0)
      return scoreOrder !== 0 ? scoreOrder : compareStrings(a, b)
    })
    .slice(0, MAX_GRAPH_SEEDS)

  for (const seedID of seedIDs) {
    const seedScore = seedScores.get(seedID) ?? 0
    let frontier = new Map<string, PropagationState>([
      [
        traceNodeID(seedID),
        { value: seedScore, firstKind: undefined, entity: undefined, pathScore: seedScore, hops: 0 },
      ],
    ])
    for (let hop = 1; hop <= options.graphHops && frontier.size > 0; hop += 1) {
      const next = new Map<string, PropagationState>()
      for (const node of [...frontier.keys()].sort(compareStrings)) {
        const state = frontier.get(node)
        if (state === undefined) continue
        const currentID = traceIDFromNode(node)
        if (currentID !== undefined) {
          const current = index.records.get(currentID)
          if (current === undefined || !isAllowedTrace(current, profile)) continue
        }
        const links = (index.graphAdjacency.get(node) ?? [])
          .filter((link) => {
            const targetID = traceIDFromNode(link.node)
            if (targetID === undefined) return true
            const target = index.records.get(targetID)
            return target !== undefined && isAllowedTrace(target, profile)
          })
          .slice(0, MAX_GRAPH_LINKS_PER_NODE)
        let totalWeight = 0
        for (const link of links) totalWeight += link.weight
        if (totalWeight <= 0) continue
        for (const link of links) {
          const contribution = (state.value * options.damping * link.weight) / totalWeight
          if (contribution <= 0) continue
          const firstKind = state.firstKind ?? link.kind
          const entity = state.entity ?? link.entity
          const candidate: PropagationState = {
            value: contribution,
            firstKind,
            entity,
            pathScore: contribution,
            hops: state.hops + 1,
          }
          const previous = next.get(link.node)
          if (previous === undefined) {
            next.set(link.node, candidate)
          } else {
            const bestPath =
              candidate.pathScore > previous.pathScore ||
              (candidate.pathScore === previous.pathScore &&
                compareStrings(candidate.firstKind ?? "", previous.firstKind ?? "") < 0)
            next.set(link.node, {
              value: previous.value + candidate.value,
              firstKind: bestPath ? candidate.firstKind : previous.firstKind,
              entity: bestPath ? candidate.entity : previous.entity,
              pathScore: bestPath ? candidate.pathScore : previous.pathScore,
              hops: bestPath ? candidate.hops : previous.hops,
            })
          }
        }
      }

      for (const [node, state] of next) {
        const targetID = traceIDFromNode(node)
        if (targetID === undefined || targetID === seedID) continue
        addToNumberMap(scores, targetID, state.value)
        const relation: ZeroMemRelationMetadata = {
          kind: state.firstKind ?? "adjacent-context",
          sourceTraceID: seedID,
          hops: hop,
          ...(state.entity === undefined ? {} : { entity: state.entity }),
        }
        const nextQuality = { score: state.pathScore, relation }
        const currentQuality = relationQuality.get(targetID)
        if (currentQuality === undefined || relationIsBetter(nextQuality, currentQuality)) {
          relationQuality.set(targetID, nextQuality)
        }
      }
      frontier = new Map(
        [...next.entries()]
          .sort(([a, aState], [b, bState]) => {
            const valueOrder = bState.value - aState.value
            if (valueOrder !== 0) return valueOrder
            const entityOrder = compareStrings(aState.entity ?? "", bState.entity ?? "")
            return entityOrder !== 0 ? entityOrder : compareStrings(a, b)
          })
          .slice(0, MAX_GRAPH_FRONTIER),
      )
    }
  }

  return {
    scores,
    relations: new Map([...relationQuality.entries()].map(([id, quality]) => [id, quality.relation])),
  }
}

function scoreLocal(
  index: BuiltIndex,
  seedScores: ReadonlyMap<string, number>,
  profile: ZeroMemQueryProfile,
  options: NormalizedOptions,
): LocalScores {
  const scores = new Map<string, number>()
  const relations = new Map<string, LocalRelation>()
  const seedIDs = [...seedScores.keys()]
    .sort((a, b) => {
      const scoreOrder = (seedScores.get(b) ?? 0) - (seedScores.get(a) ?? 0)
      return scoreOrder !== 0 ? scoreOrder : compareStrings(a, b)
    })
    .slice(0, MAX_GRAPH_SEEDS)

  for (const seedID of seedIDs) {
    const seedPlacement = index.placements.get(seedID)
    if (seedPlacement === undefined) continue
    const episode = index.episodesByID.get(seedPlacement.episodeID)
    if (episode === undefined) continue
    const seedScore = seedScores.get(seedID) ?? 0
    for (const candidateID of episode.traceIDs) {
      if (candidateID === seedID) continue
      const candidate = index.records.get(candidateID)
      if (candidate === undefined || !isAllowedTrace(candidate, profile)) continue
      const placement = index.placements.get(candidateID)
      if (placement === undefined) continue
      const distance = Math.abs(placement.position - seedPlacement.position)
      const sameWindow = placement.windowID === seedPlacement.windowID
      const isNeighbor = distance > 0 && distance <= options.localRadius
      if (!sameWindow && !isNeighbor) continue
      const value = seedScore * ((sameWindow ? 0.45 : 0) + (isNeighbor ? 0.7 / distance : 0) + 0.15)
      if (value <= 0) continue
      const previous = scores.get(candidateID) ?? 0
      if (value < previous) continue
      scores.set(candidateID, value)
      relations.set(candidateID, {
        kind: isNeighbor ? "neighbor" : sameWindow ? "window" : "episode",
        sourceTraceID: seedID,
        distance,
        windowID: placement.windowID,
        episodeID: placement.episodeID,
      })
    }
  }

  return { scores, relations }
}

function roundScore(score: number): number {
  return Number(score.toFixed(12))
}

function closureFor(
  graphRelation: ZeroMemRelationMetadata | undefined,
  localRelation: LocalRelation | undefined,
  graphScore: number,
  localScore: number,
): ZeroMemClosureMetadata {
  const sourceTraceIDs = uniqueStrings([
    ...(graphRelation === undefined ? [] : [graphRelation.sourceTraceID]),
    ...(localRelation === undefined ? [] : [localRelation.sourceTraceID]),
  ])
  if (graphRelation !== undefined && localRelation !== undefined) {
    return {
      kind: "mixed",
      sourceTraceIDs,
      hops: graphRelation.hops,
      distance: localRelation.distance,
      ...(graphRelation.entity === undefined ? {} : { entity: graphRelation.entity }),
    }
  }
  if (graphRelation !== undefined && graphScore > 0) {
    return {
      kind: "graph",
      sourceTraceIDs,
      hops: graphRelation.hops,
      ...(graphRelation.entity === undefined ? {} : { entity: graphRelation.entity }),
    }
  }
  if (localRelation !== undefined && localScore > 0) {
    return {
      kind: localRelation.kind,
      sourceTraceIDs,
      distance: localRelation.distance,
    }
  }
  return { kind: "none", sourceTraceIDs: [] }
}

function sortResultIDs(
  components: ReadonlyMap<string, ZeroMemScoreComponents>,
  scores: ReadonlyMap<string, number>,
  index: BuiltIndex,
  limit: number,
): string[] {
  const compare = (a: string, b: string) => {
    const scoreOrder = (scores.get(b) ?? 0) - (scores.get(a) ?? 0)
    if (scoreOrder !== 0) return scoreOrder
    const aComponents = components.get(a)
    const bComponents = components.get(b)
    const lexicalOrder = (bComponents?.lexical ?? 0) - (aComponents?.lexical ?? 0)
    if (lexicalOrder !== 0) return lexicalOrder
    const graphOrder = (bComponents?.graph ?? 0) - (aComponents?.graph ?? 0)
    if (graphOrder !== 0) return graphOrder
    const localOrder = (bComponents?.local ?? 0) - (aComponents?.local ?? 0)
    if (localOrder !== 0) return localOrder
    const aRecord = index.records.get(a)
    const bRecord = index.records.get(b)
    if (aRecord !== undefined && bRecord !== undefined && aRecord.timestampValue !== bRecord.timestampValue) {
      return aRecord.timestampValue < bRecord.timestampValue ? 1 : -1
    }
    return compareStrings(a, b)
  }
  if (limit <= 0) return []

  const reverseRanked = reverseSortedResultIDs(scores.keys(), compare, limit)
  if (reverseRanked !== undefined) return reverseRanked

  // Keep the worst result at the root so each candidate can replace it in O(log K).
  const ranked: string[] = []
  for (const id of scores.keys()) {
    if (ranked.length < limit) {
      ranked.push(id)
      let child = ranked.length - 1
      while (child > 0) {
        const parent = (child - 1) >> 1
        if (compare(ranked[parent]!, ranked[child]!) >= 0) break
        const parentID = ranked[parent]!
        ranked[parent] = ranked[child]!
        ranked[child] = parentID
        child = parent
      }
      continue
    }
    if (compare(id, ranked[0]!) >= 0) continue

    ranked[0] = id
    let parent = 0
    while (parent * 2 + 1 < ranked.length) {
      const left = parent * 2 + 1
      const right = left + 1
      const child = right < ranked.length && compare(ranked[left]!, ranked[right]!) < 0 ? right : left
      if (compare(ranked[parent]!, ranked[child]!) >= 0) break
      const parentID = ranked[parent]!
      ranked[parent] = ranked[child]!
      ranked[child] = parentID
      parent = child
    }
  }
  return ranked.sort(compare)
}

function reverseSortedResultIDs(ids: Iterable<string>, compare: (a: string, b: string) => number, limit: number) {
  const ranked: string[] = []
  let offset = 0
  let previous: string | undefined
  for (const id of ids) {
    if (previous !== undefined && compare(previous, id) <= 0) return undefined
    if (ranked.length < limit) ranked.push(id)
    else {
      ranked[offset] = id
      offset = (offset + 1) % limit
    }
    previous = id
  }
  if (offset === 0) return ranked.reverse()
  return ranked.slice(offset).concat(ranked.slice(0, offset)).reverse()
}

class ZeroMemStoreImpl implements ZeroMemStore {
  private readonly options: NormalizedOptions
  private readonly traces = new Map<string, ZeroMemTraceUnit>()
  private index: BuiltIndex
  private dirty = false
  private buildVersion = 0

  constructor(options: NormalizedOptions) {
    this.options = options
    this.index = buildIndex([], options, this.buildVersion)
  }

  upsert(input: ZeroMemTraceUnit | readonly ZeroMemTraceUnit[]): void {
    const units = Array.isArray(input) ? input : [input]
    const validated = units.map(validateAndCopyTrace)
    for (const unit of validated) this.traces.set(unit.id, unit)
    this.trimToLimit()
    this.dirty = true
  }

  ingest(input: ZeroMemTraceUnit | readonly ZeroMemTraceUnit[]): void {
    this.upsert(input)
  }

  remove(id: string): boolean {
    const removed = this.traces.delete(id)
    if (removed) this.dirty = true
    return removed
  }

  get(id: string): ZeroMemTraceUnit | undefined {
    const trace = this.traces.get(id)
    return trace === undefined ? undefined : cloneTrace(trace)
  }

  profile(query: string, options?: ZeroMemProfileOptions): ZeroMemQueryProfile {
    return buildQueryProfile(query, options)
  }

  search(input: string | ZeroMemQuery | ZeroMemQueryProfile, options?: ZeroMemSearchOptions): ZeroMemResult[] {
    const resolved = resolveQuery(input, options, this.options.topK)
    if (resolved.topK === 0) return []
    this.ensureIndex()
    if (this.index.ordered.length === 0) return []

    const queryTerms = queryTermFrequency(resolved.profile)
    if (queryTerms.size === 0) return []
    const lexicalRaw = new Map<string, number>()
    for (const record of this.index.ordered) {
      if (!isAllowedTrace(record, resolved.profile)) continue
      const score = bm25Score(record, queryTerms, this.index, this.options)
      if (score > 0) lexicalRaw.set(record.trace.id, score)
    }
    if (lexicalRaw.size === 0) return []

    const lexical = normalizeScoreMap(lexicalRaw)
    const graph = propagateGraph(this.index, lexical, resolved.profile, this.options)
    const graphNormalized = normalizeScoreMap(graph.scores)
    const local = scoreLocal(this.index, lexical, resolved.profile, this.options)
    const localNormalized = normalizeScoreMap(local.scores)
    const graphWeight = this.options.graphWeight * (resolved.profile.route === "relational" ? 1 : 0.6)
    const localWeight = this.options.localWeight * (resolved.profile.route === "local" ? 1 : 0.6)
    const denominator = this.options.lexicalWeight + graphWeight + localWeight
    if (denominator <= 0) return []

    const candidateIDs = new Set<string>([...lexical.keys(), ...graphNormalized.keys(), ...localNormalized.keys()])
    const scores = new Map<string, number>()
    const components = new Map<string, ZeroMemScoreComponents>()
    for (const id of candidateIDs) {
      const record = this.index.records.get(id)
      if (record === undefined || !isAllowedTrace(record, resolved.profile)) continue
      const component: ZeroMemScoreComponents = {
        lexical: lexical.get(id) ?? 0,
        graph: graphNormalized.get(id) ?? 0,
        local: localNormalized.get(id) ?? 0,
      }
      const score =
        (component.lexical * this.options.lexicalWeight +
          component.graph * graphWeight +
          component.local * localWeight) /
        denominator
      if (score <= 0) continue
      components.set(id, component)
      scores.set(id, score)
    }

    const rankedIDs = sortResultIDs(components, scores, this.index, resolved.topK)
    return rankedIDs.map((id) => {
      const component = components.get(id) ?? { lexical: 0, graph: 0, local: 0 }
      const views: ZeroMemView[] = []
      const sources: ZeroMemResultSource[] = []
      if (component.lexical > 0) {
        views.push("lexical")
        sources.push("lexical-seed")
      }
      if (component.graph > 0) {
        views.push("graph")
        sources.push("graph-closure")
      }
      if (component.local > 0) {
        views.push("local")
        sources.push("local-closure")
      }
      const graphRelation = graph.relations.get(id)
      const localRelation = local.relations.get(id)
      const closure = closureFor(graphRelation, localRelation, component.graph, component.local)
      const record = this.index.records.get(id)
      if (record === undefined) throw new Error(`Zero-Mem index lost trace ${id}`)
      return {
        score: roundScore(scores.get(id) ?? 0),
        trace: cloneTrace(record.trace),
        view: views.length === 1 ? views[0] : "fused",
        source: sources.length === 1 ? sources[0] : "mixed",
        views,
        sources,
        components: {
          lexical: roundScore(component.lexical),
          graph: roundScore(component.graph),
          local: roundScore(component.local),
        },
        relation: graphRelation ?? null,
        closure,
      }
    })
  }

  retrieve(input: string | ZeroMemQuery | ZeroMemQueryProfile, options?: ZeroMemSearchOptions): ZeroMemResult[] {
    return this.search(input, options)
  }

  rebuild(): ZeroMemStats {
    this.buildVersion += 1
    this.index = buildIndex([...this.traces.values()], this.options, this.buildVersion)
    this.dirty = false
    return this.index.stats
  }

  clear(): void {
    this.traces.clear()
    this.dirty = true
  }

  stats(): ZeroMemStats {
    this.ensureIndex()
    return this.index.stats
  }

  edges(): ZeroMemGraphEdge[] {
    this.ensureIndex()
    return this.index.graphEdges.map((edge) => ({ ...edge }))
  }

  size(): number {
    return this.traces.size
  }

  private ensureIndex(): void {
    if (this.dirty) this.rebuild()
  }

  private trimToLimit(): void {
    if (this.traces.size <= this.options.maxTraces) return
    const oldest = [...this.traces.values()]
      .sort((a, b) => {
        const timestampOrder = timestampValue(a.timestamp) - timestampValue(b.timestamp)
        return timestampOrder !== 0 ? timestampOrder : compareStrings(a.id, b.id)
      })
      .slice(0, this.traces.size - this.options.maxTraces)
    for (const trace of oldest) this.traces.delete(trace.id)
  }
}

function validateAndCopyTrace(input: ZeroMemTraceUnit): ZeroMemTraceUnit {
  if (input === null || typeof input !== "object") throw new TypeError("Zero-Mem trace must be an object")
  if (typeof input.id !== "string" || input.id.length === 0)
    throw new TypeError("Zero-Mem trace id must be a non-empty string")
  if (typeof input.text !== "string") throw new TypeError("Zero-Mem trace text must be a string")
  if (
    typeof input.timestamp !== "number" &&
    typeof input.timestamp !== "string" &&
    !(input.timestamp instanceof Date)
  ) {
    throw new TypeError("Zero-Mem trace timestamp must be a number, string, or Date")
  }
  if (input.sessionID !== undefined && typeof input.sessionID !== "string") {
    throw new TypeError("Zero-Mem trace sessionID must be a string when provided")
  }
  if (input.boundaryID !== undefined && typeof input.boundaryID !== "string") {
    throw new TypeError("Zero-Mem trace boundaryID must be a string when provided")
  }
  if (input.scopeID !== undefined && typeof input.scopeID !== "string") {
    throw new TypeError("Zero-Mem trace scopeID must be a string when provided")
  }
  return cloneTrace(input)
}

function cloneTrace(input: ZeroMemTraceUnit): ZeroMemTraceUnit {
  return {
    ...input,
    timestamp: input.timestamp instanceof Date ? new Date(input.timestamp.getTime()) : input.timestamp,
    ...(input.validFrom === undefined
      ? {}
      : { validFrom: input.validFrom instanceof Date ? new Date(input.validFrom.getTime()) : input.validFrom }),
    ...(input.validUntil === undefined
      ? {}
      : { validUntil: input.validUntil instanceof Date ? new Date(input.validUntil.getTime()) : input.validUntil }),
    ...(input.metadata === undefined ? {} : { metadata: cloneMetadata(input.metadata) }),
  }
}

function cloneMetadata(input: ZeroMemMetadata): ZeroMemMetadata {
  return cloneMetadataValue(input) as ZeroMemMetadata
}

function cloneMetadataValue(input: unknown): unknown {
  if (input instanceof Date) return new Date(input.getTime())
  if (Array.isArray(input)) return input.map((value) => cloneMetadataValue(value))
  if (input instanceof Map)
    return new Map([...input.entries()].map(([key, value]) => [cloneMetadataValue(key), cloneMetadataValue(value)]))
  if (input instanceof Set) return new Set([...input].map((value) => cloneMetadataValue(value)))
  if (input !== null && typeof input === "object") {
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, cloneMetadataValue(value)]))
  }
  return input
}

function createZeroMem(options?: ZeroMemOptions): ZeroMemStore {
  return new ZeroMemStoreImpl(normalizeOptions(options))
}

export function create(options?: ZeroMemOptions): ZeroMemStore {
  return createZeroMem(options)
}

export function tokenize(text: string): string[] {
  return tokenizeText(text)
}

export function extractEntities(text: string): ZeroMemEntity[] {
  return extractTextEntities(text)
}

export function queryProfile(query: string, options?: ZeroMemProfileOptions): ZeroMemQueryProfile {
  return buildQueryProfile(query, options)
}

/**
 * Namespace-style entry point for plugin consumers that prefer ZeroMem.create.
 * It has no Turen hooks and can be imported without bringing in any runtime
 * dependency other than standard JavaScript and the TypeScript output itself.
 */
export namespace ZeroMem {
  export type Timestamp = ZeroMemTimestamp
  export type Metadata = ZeroMemMetadata
  export type TraceUnit = ZeroMemTraceUnit
  export type Entity = ZeroMemEntity
  export type EntityKind = ZeroMemEntityKind
  export type Options = ZeroMemOptions
  export type Query = ZeroMemQuery
  export type QueryProfile = ZeroMemQueryProfile
  export type SearchOptions = ZeroMemSearchOptions
  export type Result = ZeroMemResult
  export type GraphEdge = ZeroMemGraphEdge
  export type Stats = ZeroMemStats
  export type Store = ZeroMemStore

  export const create = createZeroMem
  export const tokenize = tokenizeText
  export const extractEntities = extractTextEntities
  export const queryProfile = buildQueryProfile
}
