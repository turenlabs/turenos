import type { Event, MemoryDrawer, Part } from "@turenlabs/sdk"
import type { Hooks, Plugin, PluginInput } from "./index.js"
import { tool } from "./tool.js"
import { create, type ZeroMemOptions, type ZeroMemTraceUnit } from "./zero-mem.js"

const MAX_EVENT_MESSAGES = 1_000
const MAX_EVENT_TRACES_PER_MESSAGE = 128

export interface ZeroMemPluginOptions extends ZeroMemOptions {
  /** Override the host's project key when the host can provide its bound identity. */
  readonly projectKey?: string
  /** Include completed tool output in the live trace index. Disabled by default. */
  readonly includeToolOutput?: boolean
  /** Refresh the durable drawer snapshot before each search. */
  readonly refreshBeforeSearch?: boolean
}

/**
 * Optional legacy-plugin adapter for the isolated store.
 *
 * This deliberately registers a separate tool instead of replacing TurenOS's
 * native memory backend. A host-side Memory.Service seam is still required
 * before this can become a transparent backend replacement.
 */
export function createZeroMemPlugin(options?: ZeroMemPluginOptions): Plugin {
  return async (input): Promise<Hooks> => {
    const memory = create(options)
    const projectKey = options?.projectKey ?? projectIdentity(input)
    const drawerIDs = new Set<string>()
    const eventTraceIDs = new Map<string, Set<string>>()
    const eventPartTraceIDs = new Map<string, Set<string>>()
    const eventSessionTraceIDs = new Map<string, Set<string>>()
    let disposed = false
    let refreshGeneration = 0
    let refreshQueue = Promise.resolve()
    const refreshDrawers = () => {
      const generation = ++refreshGeneration
      const next = refreshQueue.then(() =>
        loadProjectDrawers(
          input.client,
          projectKey,
          memory,
          drawerIDs,
          () => !disposed && generation === refreshGeneration,
        ),
      )
      refreshQueue = next.then(
        () => undefined,
        () => undefined,
      )
      return next.then(async () => {
        if (generation !== refreshGeneration) await refreshQueue
      })
    }

    return {
      tool: {
        zero_mem_search: tool({
          description: "Search the provenance-preserving Zero-Mem trace index for related project evidence.",
          args: {
            query: tool.schema.string().min(1),
            limit: tool.schema.number().int().positive().max(50).optional(),
          },
          async execute(args, context) {
            await context.ask({
              permission: "memory.read",
              patterns: [projectKey],
              always: [],
              metadata: { source: "zero-mem" },
            })
            if (options?.refreshBeforeSearch ?? true) await refreshDrawers()
            const results = memory.search(args.query, { topK: args.limit })
            return {
              title: `Zero-Mem: ${results.length} evidence trace${results.length === 1 ? "" : "s"}`,
              output: JSON.stringify(
                results.map((result) => ({
                  id: result.trace.id,
                  score: result.score,
                  text: result.trace.text,
                  sessionID: result.trace.sessionID,
                  boundaryID: result.trace.boundaryID,
                  scopeID: result.trace.scopeID,
                  view: result.view,
                  relation: result.relation,
                  closure: result.closure,
                })),
                null,
                2,
              ),
            }
          },
        }),
      },
      event: async ({ event }) => {
        const removedPartScope = removedPartEventScope(event)
        if (removedPartScope !== undefined) {
          removeEventPart(removedPartScope, eventPartTraceIDs, eventTraceIDs, eventSessionTraceIDs, memory)
          if (event.type === "message.part.removed") {
            memory.remove(
              eventTraceID("text", event.properties.sessionID, event.properties.messageID, event.properties.partID),
            )
            memory.remove(
              eventTraceID(
                "reasoning",
                event.properties.sessionID,
                event.properties.messageID,
                event.properties.partID,
              ),
            )
          }
          return
        }
        const removedScope = removedEventScope(event)
        if (removedScope !== undefined) {
          removeEventScope(removedScope, eventTraceIDs, eventPartTraceIDs, eventSessionTraceIDs, memory)
          return
        }
        const removedSession = removedSessionID(event)
        if (removedSession !== undefined) {
          removeEventSession(removedSession, eventSessionTraceIDs, eventTraceIDs, eventPartTraceIDs, memory)
          return
        }
        const trace = traceFromEvent(event)
        if (trace && ((options?.includeToolOutput ?? false) || trace.metadata?.kind !== "tool")) {
          memory.upsert(trace)
          const scope = eventMessageScope(event)
          if (scope) {
            const ids = eventTraceIDs.get(scope) ?? new Set<string>()
            ids.add(trace.id)
            eventTraceIDs.set(scope, ids)
            trimMessageTraces(scope, ids, eventTraceIDs, eventPartTraceIDs, eventSessionTraceIDs, memory)
          }
          const sessionID = trace.sessionID
          if (sessionID) {
            const ids = eventSessionTraceIDs.get(sessionID) ?? new Set<string>()
            ids.add(trace.id)
            eventSessionTraceIDs.set(sessionID, ids)
          }
          const partScope = eventPartScope(event)
          if (partScope) {
            const ids = eventPartTraceIDs.get(partScope) ?? new Set<string>()
            ids.add(trace.id)
            if (event.type === "message.part.updated") {
              ids.add(
                eventTraceID(
                  "text",
                  event.properties.part.sessionID,
                  event.properties.part.messageID,
                  event.properties.part.id,
                ),
              )
              ids.add(
                eventTraceID(
                  "reasoning",
                  event.properties.part.sessionID,
                  event.properties.part.messageID,
                  event.properties.part.id,
                ),
              )
            }
            eventPartTraceIDs.set(partScope, ids)
          }
          trimEventBookkeeping(eventTraceIDs, eventPartTraceIDs, eventSessionTraceIDs, memory)
        }
      },
      dispose: async () => {
        disposed = true
        refreshGeneration += 1
        await refreshQueue
        memory.clear()
        drawerIDs.clear()
        eventTraceIDs.clear()
        eventPartTraceIDs.clear()
        eventSessionTraceIDs.clear()
      },
    }
  }
}

export function traceFromEvent(event: Event): ZeroMemTraceUnit | undefined {
  if (event.type === "message.part.updated") return traceFromPart(event.properties.part)
  if (event.type === "session.next.text.ended") {
    return {
      id: eventTraceID(
        "text",
        event.properties.sessionID,
        event.properties.assistantMessageID,
        event.properties.textID,
      ),
      text: event.properties.text,
      sessionID: event.properties.sessionID,
      timestamp: event.properties.timestamp,
      boundaryID: event.properties.assistantMessageID,
    }
  }
  if (event.type === "session.next.reasoning.ended") {
    return {
      id: eventTraceID(
        "reasoning",
        event.properties.sessionID,
        event.properties.assistantMessageID,
        event.properties.reasoningID,
      ),
      text: event.properties.text,
      sessionID: event.properties.sessionID,
      timestamp: event.properties.timestamp,
      boundaryID: event.properties.assistantMessageID,
    }
  }
  return undefined
}

export function removedTraceID(event: Event): string | undefined {
  return event.type === "message.part.removed"
    ? eventTraceID("part", event.properties.sessionID, event.properties.messageID, event.properties.partID)
    : undefined
}

function eventMessageScope(event: Event): string | undefined {
  if (event.type === "message.part.updated")
    return messageScope(event.properties.part.sessionID, event.properties.part.messageID)
  if (event.type === "session.next.text.ended")
    return messageScope(event.properties.sessionID, event.properties.assistantMessageID)
  if (event.type === "session.next.reasoning.ended")
    return messageScope(event.properties.sessionID, event.properties.assistantMessageID)
  return undefined
}

function eventPartScope(event: Event): string | undefined {
  if (event.type === "message.part.updated")
    return partScope(event.properties.part.sessionID, event.properties.part.messageID, event.properties.part.id)
  return undefined
}

function removedEventScope(event: Event): string | undefined {
  if (event.type === "message.removed") return messageScope(event.properties.sessionID, event.properties.messageID)
  return undefined
}

function removedPartEventScope(event: Event): string | undefined {
  if (event.type === "message.part.removed")
    return partScope(event.properties.sessionID, event.properties.messageID, event.properties.partID)
  return undefined
}

function removedSessionID(event: Event): string | undefined {
  return event.type === "session.deleted" ? event.properties.sessionID : undefined
}

function messageScope(sessionID: string, messageID: string): string {
  return `${sessionID}:${messageID}`
}

function partScope(sessionID: string, messageID: string, partID: string): string {
  return `${messageScope(sessionID, messageID)}:${partID}`
}

function removeEventScope(
  scope: string,
  messageTraces: Map<string, Set<string>>,
  partTraces: Map<string, Set<string>>,
  sessionTraces: Map<string, Set<string>>,
  memory: ReturnType<typeof create>,
): void {
  for (const id of messageTraces.get(scope) ?? []) {
    memory.remove(id)
    removePartScopesForID(id, partTraces)
    removeIDFromSets(id, sessionTraces)
  }
  messageTraces.delete(scope)
}

function removeEventPart(
  scope: string,
  partTraces: Map<string, Set<string>>,
  messageTraces: Map<string, Set<string>>,
  sessionTraces: Map<string, Set<string>>,
  memory: ReturnType<typeof create>,
): void {
  for (const id of partTraces.get(scope) ?? []) {
    memory.remove(id)
    removeIDFromSets(id, messageTraces)
    removeIDFromSets(id, sessionTraces)
  }
  partTraces.delete(scope)
}

function removeEventSession(
  sessionID: string,
  sessionTraces: Map<string, Set<string>>,
  messageTraces: Map<string, Set<string>>,
  partTraces: Map<string, Set<string>>,
  memory: ReturnType<typeof create>,
): void {
  for (const id of sessionTraces.get(sessionID) ?? []) {
    memory.remove(id)
    removeIDFromSets(id, messageTraces)
    removePartScopesForID(id, partTraces)
  }
  sessionTraces.delete(sessionID)
}

function removeIDFromSets(id: string, sets: Map<string, Set<string>>): void {
  for (const [key, ids] of sets) {
    ids.delete(id)
    if (ids.size === 0) sets.delete(key)
  }
}

function removePartScopesForID(id: string, partTraces: Map<string, Set<string>>): void {
  for (const [scope, ids] of partTraces) if (ids.has(id)) partTraces.delete(scope)
}

function trimEventBookkeeping(
  messageTraces: Map<string, Set<string>>,
  partTraces: Map<string, Set<string>>,
  sessionTraces: Map<string, Set<string>>,
  memory: ReturnType<typeof create>,
): void {
  while (messageTraces.size > MAX_EVENT_MESSAGES) {
    const oldest = messageTraces.keys().next().value
    if (oldest === undefined) return
    removeEventScope(oldest, messageTraces, partTraces, sessionTraces, memory)
  }
}

function trimMessageTraces(
  scope: string,
  ids: Set<string>,
  messageTraces: Map<string, Set<string>>,
  partTraces: Map<string, Set<string>>,
  sessionTraces: Map<string, Set<string>>,
  memory: ReturnType<typeof create>,
): void {
  while (ids.size > MAX_EVENT_TRACES_PER_MESSAGE) {
    const oldest = ids.values().next().value
    if (oldest === undefined) return
    ids.delete(oldest)
    memory.remove(oldest)
    removePartScopesForID(oldest, partTraces)
    removeIDFromSets(oldest, sessionTraces)
  }
  messageTraces.set(scope, ids)
}

function traceFromPart(part: Part): ZeroMemTraceUnit | undefined {
  if (part.type === "text") {
    return {
      id: eventTraceID("part", part.sessionID, part.messageID, part.id),
      text: part.text,
      sessionID: part.sessionID,
      timestamp: part.time?.start ?? Date.now(),
      boundaryID: part.messageID,
    }
  }
  if (part.type === "reasoning") {
    return {
      id: eventTraceID("part", part.sessionID, part.messageID, part.id),
      text: part.text,
      sessionID: part.sessionID,
      timestamp: part.time.start,
      boundaryID: part.messageID,
    }
  }
  if (part.type !== "tool") return undefined
  const state = part.state
  const text =
    state.status === "completed"
      ? state.output
      : state.status === "error"
        ? state.error
        : state.status === "pending"
          ? state.raw
          : JSON.stringify(state.input)
  return {
    id: eventTraceID("part", part.sessionID, part.messageID, part.id),
    text: `${part.tool}\n${text}`,
    sessionID: part.sessionID,
    timestamp: "time" in state ? state.time.start : Date.now(),
    boundaryID: part.messageID,
    metadata: { kind: "tool", tool: part.tool },
  }
}

async function loadProjectDrawers(
  client: PluginInput["client"],
  projectID: string,
  memory: ReturnType<typeof create>,
  drawerIDs: Set<string>,
  isCurrent: () => boolean,
): Promise<void> {
  const wingsResponse = await client.v2.memory.wings()
  if (wingsResponse.error) throw new Error(`Unable to load Zero-Mem wings: ${JSON.stringify(wingsResponse.error)}`)
  const wings = wingsResponse.data ?? []
  const wing = wings.find((candidate) => candidate.kind === "project" && candidate.key === projectID)
  if (!wing) {
    if (!isCurrent()) return
    for (const id of drawerIDs) memory.remove(id)
    drawerIDs.clear()
    return
  }
  const roomsResponse = await client.v2.memory.rooms({ wingID: wing.id })
  if (roomsResponse.error) throw new Error(`Unable to load Zero-Mem rooms: ${JSON.stringify(roomsResponse.error)}`)
  const rooms = roomsResponse.data ?? []
  const drawerLists = await Promise.all(
    rooms.map(async (room) => {
      const response = await client.v2.memory.list({ wingID: wing.id, roomID: room.id })
      if (response.error) throw new Error(`Unable to load Zero-Mem room ${room.id}: ${JSON.stringify(response.error)}`)
      return response.data ?? []
    }),
  )
  const drawers = drawerLists.flat()
  if (drawerLists.some((roomDrawers) => roomDrawers.length >= 200))
    throw new Error("Zero-Mem bootstrap requires a paginated memory list for rooms with 200 or more drawers")
  if (!isCurrent()) return
  const currentIDs = new Set(drawers.map((drawer) => drawer.id))
  for (const id of drawerIDs) if (!currentIDs.has(id)) memory.remove(id)
  memory.upsert(drawers.map((drawer) => drawerTrace(drawer)))
  drawerIDs.clear()
  for (const id of currentIDs) drawerIDs.add(id)
}

function projectIdentity(input: PluginInput): string {
  if (input.project.vcs !== undefined) return input.project.id
  throw new Error("Zero-Mem requires projectKey for non-Git projects to preserve native memory identity")
}

function eventTraceID(kind: string, sessionID: string, boundaryID: string, id: string): string {
  return ["event", kind, sessionID, boundaryID, id].map(encodeURIComponent).join(":")
}

function drawerTrace(drawer: MemoryDrawer): ZeroMemTraceUnit {
  return {
    id: drawer.id,
    text: [drawer.title, drawer.body, drawer.anchor.path, drawer.anchor.symbol].filter(Boolean).join("\n"),
    sessionID: drawer.provenance.sessionID,
    timestamp: finiteTimestamp(drawer.timeValidFrom, drawer.timeCreated),
    boundaryID: drawer.roomID,
    scopeID: drawer.roomID,
    validFrom: drawer.timeValidFrom,
    ...(drawer.timeValidUntil === undefined ? {} : { validUntil: drawer.timeValidUntil }),
    metadata: {
      kind: drawer.kind,
      roomID: drawer.roomID,
      anchor: drawer.anchor,
      provenance: drawer.provenance,
    },
  }
}

function finiteTimestamp(value: number | string, fallback: number | string): number {
  const parsed = typeof value === "number" ? value : Date.parse(value)
  if (Number.isFinite(parsed)) return parsed
  const fallbackValue = typeof fallback === "number" ? fallback : Date.parse(fallback)
  return Number.isFinite(fallbackValue) ? fallbackValue : 0
}
