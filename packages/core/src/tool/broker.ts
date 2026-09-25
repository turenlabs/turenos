export * as ToolBroker from "./broker"

export const SEARCH_TOOL_NAME = "tool_search"
export const LOAD_TOOL_NAME = "tool_load"
export const DISCOVERY_SYSTEM_PROMPT = `Additional built-in capabilities — binary and malware analysis, email forensics, browser automation, automations, and whiteboard drawing — and connected MCP integrations are exposed through ${SEARCH_TOOL_NAME} and ${LOAD_TOOL_NAME} so their full schemas do not consume context until needed. When the user asks which tools, capabilities, or integrations are currently available, you MUST call ${SEARCH_TOOL_NAME} in that turn; an empty query lists all current capabilities. Never reuse an earlier availability result because tools and integrations can be enabled or disabled between turns. When a user's request needs a capability that no visible tool covers, you MUST call ${SEARCH_TOOL_NAME} before claiming the capability or its credentials are unavailable. If it returns a relevant capability, call ${LOAD_TOOL_NAME} with its exact key. The selected tool becomes available on the following model turn within the same user request; use it then to complete the request.`
export const SEARCH_TOOL_DESCRIPTION = `Search deferred built-in capabilities and the live set of connected and approved MCP capabilities. Use an empty query whenever asked which tools, capabilities, or integrations are currently available, and do not reuse an earlier result. Use this before claiming that a capability or its credentials are unavailable. Relevant tools can then be selected with ${LOAD_TOOL_NAME}.`
export const LOAD_TOOL_DESCRIPTION =
  "Load deferred tool keys for this session — built-in tool names and MCP capability keys. Loaded tools appear on the next model turn within the same user request."

/** Source bucket that groups built-in capabilities for per-source caps and scope identity. */
export const BUILTIN_SERVER = "forge"
export const BUILTIN_MAX_LOADED_TOOLS = 16
export const DEFAULT_UNLOAD_AFTER_IDLE_TURNS = 3
const MAX_SEARCH_RESULTS = 20
const MAX_SEARCH_TERMS = 24
const SEARCH_STOP_WORDS = new Set([
  "a",
  "about",
  "access",
  "an",
  "and",
  "api",
  "available",
  "check",
  "find",
  "for",
  "from",
  "get",
  "integration",
  "mcp",
  "or",
  "please",
  "search",
  "show",
  "the",
  "to",
  "tool",
  "tools",
  "with",
])

export interface Capability {
  readonly key: string
  readonly name: string
  readonly description?: string
  readonly source?: "builtin" | "mcp"
  readonly server?: string
  /** Per-source loaded cap for this capability; absent means only the global cap applies. */
  readonly maxLoadedTools?: number
  readonly unloadAfterIdleTurns?: number
}

export interface SearchResult<C extends Capability = Capability> {
  readonly matches: ReadonlyArray<C & { readonly selected: boolean }>
  readonly selected: ReadonlyArray<string>
  readonly available: number
}

export interface LoadResult {
  readonly loaded: ReadonlyArray<string>
  readonly selected: ReadonlyArray<string>
  readonly message: string
}

export interface LoadOptions {
  readonly globalCap?: number
  /** Default per-source cap for capabilities that do not declare `maxLoadedTools`. */
  readonly perServerCap?: number
}

export type LoadErrorReason = "unavailable" | "global-limit" | "source-limit"

export class LoadError extends Error {
  readonly reason: LoadErrorReason
  readonly key?: string
  readonly server?: string
  readonly limit?: number

  constructor(reason: LoadErrorReason, detail: { key?: string; server?: string; limit?: number }) {
    super(
      reason === "unavailable"
        ? `Tool is not available: ${detail.key}`
        : reason === "global-limit"
          ? `Tool selection is limited to ${detail.limit} tools per session`
          : `Tool source ${detail.server} is limited to ${detail.limit} loaded tools`,
    )
    this.name = "ToolBroker.LoadError"
    this.reason = reason
    this.key = detail.key
    this.server = detail.server
    this.limit = detail.limit
  }
}

type Selection = {
  readonly server?: string
  readonly name: string
  touchedTurn: number
  unloadAfterIdleTurns: number
}

type SessionState = {
  turn: number
  readonly selected: Map<string, Selection>
}

const sessions = new Map<string, SessionState>()

function sessionKey(sessionID: string, scope = "") {
  return `${scope}\u0000${sessionID}`
}

function state(sessionID: string, scope = "") {
  const key = sessionKey(sessionID, scope)
  const current = sessions.get(key)
  if (current) return current
  const created: SessionState = { turn: 0, selected: new Map() }
  sessions.set(key, created)
  return created
}

function capabilityMap(capabilities: ReadonlyArray<Capability>) {
  return new Map(capabilities.map((capability) => [capability.key, capability]))
}

function selectedKeys(current: SessionState) {
  return [...current.selected.keys()].toSorted((left, right) => left.localeCompare(right))
}

function words(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

function editDistance(left: string, right: string) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  let current = new Array<number>(right.length + 1)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + Number(left[leftIndex - 1] !== right[rightIndex - 1]),
      )
    }
    const row = previous
    previous = current
    current = row
  }
  return previous[right.length]
}

function termScore(term: string, candidates: ReadonlyArray<string>, weight: number) {
  if (candidates.includes(term)) return weight * 4
  if (term.length >= 3 && candidates.some((candidate) => candidate.startsWith(term) || term.startsWith(candidate))) {
    return weight * 3
  }
  if (term.length >= 3 && candidates.some((candidate) => candidate.includes(term) || term.includes(candidate))) {
    return weight * 2
  }
  if (term.length < 4) return 0
  const threshold = term.length >= 8 ? 2 : 1
  return candidates.some(
    (candidate) => Math.abs(candidate.length - term.length) <= threshold && editDistance(term, candidate) <= threshold,
  )
    ? weight
    : 0
}

function searchScore(capability: Capability, terms: ReadonlyArray<string>) {
  const identity = words(`${capability.key} ${capability.server ?? ""} ${capability.name}`)
  const description = words(capability.description ?? "")
  return terms.reduce(
    (score, term) => score + Math.max(termScore(term, identity, 4), termScore(term, description, 1)),
    0,
  )
}

export function beginTurn(sessionID: string, capabilities: ReadonlyArray<Capability>, scope = "") {
  const current = state(sessionID, scope)
  const available = capabilityMap(capabilities)
  current.turn += 1
  for (const [key, selection] of current.selected) {
    const capability = available.get(key)
    if (
      !capability ||
      capability.server !== selection.server ||
      capability.name !== selection.name ||
      current.turn - selection.touchedTurn > selection.unloadAfterIdleTurns
    ) {
      current.selected.delete(key)
      continue
    }
    selection.unloadAfterIdleTurns = capability.unloadAfterIdleTurns ?? DEFAULT_UNLOAD_AFTER_IDLE_TURNS
  }
  return selectedKeys(current)
}

export function selected<C extends Capability>(sessionID: string, capabilities: ReadonlyArray<C>, scope = "") {
  const keys = new Set(selectedKeys(state(sessionID, scope)))
  return capabilities.filter((capability) => keys.has(capability.key))
}

export function search<C extends Capability>(
  sessionID: string,
  capabilities: ReadonlyArray<C>,
  query = "",
  scope = "",
): SearchResult<C> {
  const current = state(sessionID, scope)
  const selected = new Set(current.selected.keys())
  const terms = [...new Set(words(query.slice(0, 1_024)).filter((term) => !SEARCH_STOP_WORDS.has(term)))].slice(
    0,
    MAX_SEARCH_TERMS,
  )
  const matches = capabilities
    .map((capability) => ({
      capability,
      score: terms.length === 0 ? 0 : searchScore(capability, terms),
      selected: selected.has(capability.key),
    }))
    .filter((match) => terms.length === 0 || match.score > 0)
    .toSorted(
      (left, right) =>
        right.score - left.score ||
        Number(right.selected) - Number(left.selected) ||
        left.capability.key.localeCompare(right.capability.key),
    )
    .map(({ capability, selected }) => ({ ...capability, selected }))
    .slice(0, MAX_SEARCH_RESULTS)
  return { matches, selected: selectedKeys(current), available: capabilities.length }
}

export function load(
  sessionID: string,
  capabilities: ReadonlyArray<Capability>,
  keys: ReadonlyArray<string>,
  scope = "",
  options: LoadOptions = {},
): LoadResult {
  const current = state(sessionID, scope)
  const available = capabilityMap(capabilities)
  const requested = [...new Set(keys)]
  const unknown = requested.find((key) => !available.has(key))
  if (unknown) throw new LoadError("unavailable", { key: unknown })

  const additions = requested.filter((key) => !current.selected.has(key))
  if (options.globalCap !== undefined && current.selected.size + additions.length > options.globalCap) {
    throw new LoadError("global-limit", { limit: options.globalCap })
  }

  const byServer = new Map<string | undefined, number>()
  for (const selection of current.selected.values()) {
    byServer.set(selection.server, (byServer.get(selection.server) ?? 0) + 1)
  }
  for (const key of additions) {
    const capability = available.get(key)!
    const limit = capability.maxLoadedTools ?? options.perServerCap
    const count = (byServer.get(capability.server) ?? 0) + 1
    if (limit !== undefined && count > limit) {
      throw new LoadError("source-limit", { server: capability.server, limit })
    }
    byServer.set(capability.server, count)
  }

  for (const key of requested) {
    const capability = available.get(key)!
    current.selected.set(key, {
      server: capability.server,
      name: capability.name,
      touchedTurn: current.turn,
      unloadAfterIdleTurns: capability.unloadAfterIdleTurns ?? DEFAULT_UNLOAD_AFTER_IDLE_TURNS,
    })
  }
  const selected = selectedKeys(current)
  return {
    loaded: additions,
    selected,
    message:
      additions.length === 0
        ? "Those tools are already loaded."
        : `Loaded ${additions.join(", ")}. The tools will be available on the next model turn.`,
  }
}

export function touch(sessionID: string, key: string, scope = "") {
  const current = sessions.get(sessionKey(sessionID, scope))
  const selection = current?.selected.get(key)
  if (current && selection) selection.touchedTurn = current.turn
}

export function clear(sessionID?: string, scope?: string) {
  if (!sessionID) {
    sessions.clear()
    return
  }
  if (scope !== undefined) {
    sessions.delete(sessionKey(sessionID, scope))
    return
  }
  for (const key of sessions.keys()) if (key.endsWith(`\u0000${sessionID}`)) sessions.delete(key)
}
