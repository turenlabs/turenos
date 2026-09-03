import type { Event, Session, SessionV2Info, V2SessionListResponse } from "@turenlabs/sdk/v2/client"
import type { QueryClient } from "@tanstack/solid-query"
import { INACTIVE_AFTER_MS, Session as SessionSchema } from "@turenlabs/schema/session"
import { trimSessions } from "./session-trim"
import { pathKey } from "@/utils/path-key"

// The Home index is a recent summary cache, not the session history. Older
// sessions remain available through server-backed search and explicit loads.
export const HOME_V2_SESSION_LIMIT = 50

export type HomeSessionEvent = {
  type: "session.created" | "session.updated" | "session.deleted"
  properties: { sessionID: string; info: Session }
}
export type HomeSessionEvents = {
  sequence: number
  entries: Array<{ sequence: number; event: HomeSessionEvent }>
}
export type HomeSessionIndex = {
  sessions: Session[]
  eventSequence: number
}

export const homeSessionIndexKey = (server: string) => ["home", "session-index", server] as const
export const homeSessionEventsKey = (server: string) => ["home", "session-events", server] as const

type HomeSessionPage = { data?: V2SessionListResponse }

export async function loadHomeSessionIndex(
  list: (
    input: { archived: "false"; inactive: "false"; limit: number; order: "desc"; roots: true; cursor?: string },
    options: { signal?: AbortSignal },
  ) => Promise<HomeSessionPage>,
  eventSequence = 0,
  signal?: AbortSignal,
) {
  const response = await list(
    { archived: "false", inactive: "false", limit: HOME_V2_SESSION_LIMIT, order: "desc", roots: true },
    { signal },
  )
  return { sessions: parseHomeSessionIndex(response.data?.data ?? []), eventSequence }
}

export function appendHomeSessionEvent(current: HomeSessionEvents | undefined, event: HomeSessionEvent) {
  const sequence = (current?.sequence ?? 0) + 1
  return {
    sequence,
    entries: [...(current?.entries ?? []), { sequence, event }],
  }
}

export function trimHomeSessionEvents(current: HomeSessionEvents | undefined, sequence: number): HomeSessionEvents {
  return {
    sequence: current?.sequence ?? sequence,
    entries: (current?.entries ?? []).filter((entry) => entry.sequence > sequence),
  }
}

export function homeSessionIndexSessions(
  index: HomeSessionIndex | undefined,
  events: HomeSessionEvents | undefined,
  now = Date.now(),
) {
  if (!index) return []
  return (events?.entries ?? [])
    .filter((entry) => entry.sequence > index.eventSequence)
    .reduce((sessions, entry) => applyHomeSessionEvent(sessions, entry.event, now), index.sessions)
    .filter((session) => !isSessionInactive(session, now))
}

export function homeSessionIndexRefresh(event: Event["type"], connected: boolean) {
  if (event === "server.connected") return { connected: true, refetch: connected }
  return {
    connected,
    // The home index folds only the three V1 whole-session events, so a V2 rename cannot be
    // applied to it incrementally. Refetch, as a move already does; both are once-per-session.
    // The cast is the one concession: `session.next.title.updated` is not in the generated SDK
    // event union yet, and regenerating it means booting the CLI. Drop the cast with that regen.
    refetch:
      event === "global.disposed" ||
      event === "session.next.moved" ||
      (event as string) === "session.next.title.updated",
  }
}

export function createHomeSessionIndexCache(queryClient: QueryClient, server: string) {
  const indexKey = homeSessionIndexKey(server)
  const eventsKey = homeSessionEventsKey(server)
  let connected = false

  return {
    indexKey,
    eventsKey,
    // The single QueryClient this cache reads and writes. The home index is written
    // here (from the server event stream, under the GlobalProvider owner) but read by
    // the Agents panel, which mounts under a second QueryClientProvider. Exposing the
    // writer's client lets the panel's queries register on the SAME cache instead of a
    // sibling client whose index never sees a live event (Wave-2 panel-lift bug: new
    // sessions never appeared and deletions never pruned).
    queryClient,
    eventSequence() {
      return queryClient.getQueryData<HomeSessionEvents>(eventsKey)?.sequence ?? 0
    },
    complete(sequence: number) {
      // Keep events received after the fetch began so its response cannot overwrite them.
      queryClient.setQueryData<HomeSessionEvents>(eventsKey, (current) => trimHomeSessionEvents(current, sequence))
    },
    sessions(index: HomeSessionIndex | undefined, events: HomeSessionEvents | undefined) {
      return homeSessionIndexSessions(index, events)
    },
    apply(event: HomeSessionEvent) {
      const next = appendHomeSessionEvent(queryClient.getQueryData<HomeSessionEvents>(eventsKey), event)
      // When the index query has never materialized (no cache entry at all), the
      // events cache is the only place a live event can survive. Buffer it — for
      // creations, updates, and deletions alike — so the next materialization replays
      // it over the freshly loaded index instead of silently dropping it. This is the
      // same replay path loadHomeSessionIndex + complete() already reconcile, so a
      // later full load cannot double-apply (it captures this buffer's sequence and
      // trims replayed entries); an unfetched index also refetches on next mount.
      // Removals matter most (a missed session.deleted leaves a permanently stale
      // nav row), but creations are equally user-visible, so all types are kept. The
      // buffer is bounded in practice: a materialization trims it, and an
      // observer-less events query is garbage-collected after gcTime.
      if (!queryClient.getQueryState(indexKey)) {
        queryClient.setQueryData<HomeSessionEvents>(eventsKey, next)
        return
      }
      if (queryClient.isFetching({ queryKey: indexKey, exact: true }) > 0) {
        queryClient.setQueryData(eventsKey, next)
        return
      }

      const index = queryClient.getQueryData<HomeSessionIndex>(indexKey)
      if (index) {
        queryClient.setQueryData<HomeSessionIndex>(indexKey, {
          sessions: homeSessionIndexSessions(index, next),
          eventSequence: next.sequence,
        })
      }
      queryClient.setQueryData<HomeSessionEvents>(eventsKey, { sequence: next.sequence, entries: [] })
    },
    refresh(event: Event["type"]) {
      const result = homeSessionIndexRefresh(event, connected)
      connected = result.connected
      if (!result.refetch) return
      void queryClient.refetchQueries({ queryKey: indexKey, exact: true, type: "active" })
    },
  }
}

// Keep this defensive filtering for callers such as search that intentionally
// request mixed pages rather than the active Home query's server-side filters.
export function parseHomeSessionIndex(sessions: SessionV2Info[]): Session[] {
  return sessions.flatMap((item) => {
    if (SessionSchema.isInternal(item)) return []
    if (item.parentID) return []
    if (typeof item.time.archived === "number") return []
    return [toLegacySummary(item)]
  })
}

export function isSessionInactive(session: Pick<Session, "time">, now = Date.now()) {
  return (session.time.updated ?? session.time.created) <= now - INACTIVE_AFTER_MS
}

export function retainHomeSessions(sessions: Session[], limit: number, now: number) {
  const grouped = Map.groupBy(sessions, (session) => pathKey(session.directory))
  return [...grouped.values()].flatMap((items) => trimSessions(items, { limit, permission: {}, now }))
}

// Synthetic session.deleted for the session route's not-found self-heal. When the
// route determines a session no longer exists server-side (hard delete → get 404 or
// empty lineage), it feeds this to homeSessions.apply so the stale left-nav row is
// pruned even if the live session.deleted event was missed. applyHomeSessionEvent's
// deletion branch only reads info.id, so a minimal identity is sufficient.
export function removedHomeSessionEvent(sessionID: string): HomeSessionEvent {
  return {
    type: "session.deleted",
    properties: { sessionID, info: { id: sessionID } as Session },
  }
}

export function applyHomeSessionEvent(sessions: Session[], event: HomeSessionEvent, now = Date.now()) {
  const info = event.properties.info
  const index = sessions.findIndex((session) => session.id === info.id)
  if (
    event.type === "session.deleted" ||
    SessionSchema.isInternal(info) ||
    info.parentID ||
    typeof info.time.archived === "number" ||
    isSessionInactive(info, now)
  ) {
    if (index === -1) return sessions
    return sessions.toSpliced(index, 1)
  }
  if (event.type !== "session.created" && event.type !== "session.updated") return sessions
  if (index === -1) return [...sessions, info]
  return sessions.with(index, info)
}

export function toLegacySummary(session: SessionV2Info): Session {
  return {
    id: session.id,
    slug: session.id,
    projectID: session.projectID,
    workspaceID: session.location.workspaceID,
    directory: session.location.directory,
    path: session.subpath,
    parentID: session.parentID,
    cost: session.cost,
    tokens: session.tokens,
    title: session.title,
    agent: session.agent,
    model: session.model,
    metadata: session.metadata,
    version: "",
    time: session.time,
  }
}
