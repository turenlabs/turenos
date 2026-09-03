import { describe, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import type { SessionV2Info } from "@turenlabs/sdk/v2/client"
import {
  applyHomeSessionEvent,
  appendHomeSessionEvent,
  createHomeSessionIndexCache,
  HOME_V2_SESSION_LIMIT,
  loadHomeSessionIndex,
  homeSessionIndexSessions,
  homeSessionIndexRefresh,
  isSessionInactive,
  parseHomeSessionIndex,
  removedHomeSessionEvent,
  retainHomeSessions,
  toLegacySummary,
  type HomeSessionEvents,
  type HomeSessionIndex,
} from "./home-session-index"

const session = (input: {
  id: string
  directory?: string
  parentID?: string
  archived?: number
  updated?: number
  metadata?: Record<string, unknown>
}) => ({
  id: input.id,
  parentID: input.parentID,
  projectID: "project",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: input.updated ?? 1, archived: input.archived },
  title: input.id,
  metadata: input.metadata,
  location: { directory: input.directory ?? "/project" },
})

describe("Home V2 session index", () => {
  test("loads the Home index with one bounded global V2 request", async () => {
    const calls: unknown[] = []
    const result = await loadHomeSessionIndex(async (input) => {
      calls.push(input)
      return { data: { data: [session({ id: "root" })], cursor: {} } }
    })

    expect(result.sessions).toHaveLength(1)
    expect(calls).toEqual([
      { archived: "false", inactive: "false", limit: HOME_V2_SESSION_LIMIT, order: "desc", roots: true },
    ])
  })

  test("loads a bounded recent root index", async () => {
    const calls: unknown[] = []
    const controller = new AbortController()
    const result = await loadHomeSessionIndex(
      async (input, options) => {
        calls.push({ input, signal: options.signal })
        return {
          data: {
            data: Array.from({ length: HOME_V2_SESSION_LIMIT }, (_, index) => session({ id: `session-${index}` })),
            cursor: {},
          },
        }
      },
      0,
      controller.signal,
    )

    expect(result.sessions).toHaveLength(HOME_V2_SESSION_LIMIT)
    expect(calls).toEqual([
      {
        input: {
          archived: "false",
          inactive: "false",
          limit: HOME_V2_SESSION_LIMIT,
          order: "desc",
          roots: true,
        },
        signal: controller.signal,
      },
    ])
  })

  test("does not follow cursors beyond the bounded recent root index", async () => {
    const calls: unknown[] = []
    const result = await loadHomeSessionIndex(async (input) => {
      calls.push(input)
      return { data: { data: [session({ id: "newer" })], cursor: { next: "next-page" } } }
    })

    expect(result.sessions.map((item) => item.id)).toEqual(["newer"])
    expect(calls).toEqual([
      { archived: "false", inactive: "false", limit: HOME_V2_SESSION_LIMIT, order: "desc", roots: true },
    ])
  })

  test("treats the 48-hour boundary as inactive", () => {
    const now = 200_000_000
    const boundary = { time: { created: 1, updated: now - 48 * 60 * 60 * 1_000 } }
    expect(isSessionInactive(boundary, now)).toBe(true)
    expect(isSessionInactive({ time: { ...boundary.time, updated: boundary.time.updated + 1 } }, now)).toBe(false)
  })

  test("ages cached sessions out without requiring a live event", () => {
    const now = 200_000_000
    const old = parseHomeSessionIndex([session({ id: "old", updated: now - 48 * 60 * 60 * 1_000 })])
    const recent = parseHomeSessionIndex([session({ id: "recent", updated: now - 1 })])

    expect(homeSessionIndexSessions({ sessions: [...old, ...recent], eventSequence: 0 }, undefined, now)).toEqual(
      recent,
    )
  })

  test("maps visible roots to Home session summaries", () => {
    const activeNull = {
      ...session({ id: "active-null", updated: 20 }),
      time: { created: 1, updated: 20, archived: null },
    } as unknown as SessionV2Info
    const result = parseHomeSessionIndex([
      session({ id: "root", updated: 30 }),
      activeNull,
      session({ id: "child", parentID: "root", updated: 40 }),
      session({ id: "archived", archived: 50, updated: 50 }),
    ])

    expect(result).toEqual([
      expect.objectContaining({
        id: "root",
        slug: "root",
        version: "",
        directory: "/project",
        projectID: "project",
        title: "root",
        time: { created: 1, updated: 30 },
      }),
      expect.objectContaining({
        id: "active-null",
        time: { created: 1, updated: 20, archived: null },
      }),
    ])
  })

  test("excludes internal lobby sessions from list and live projections", () => {
    const visible = session({ id: "visible", updated: 30 })
    const internal = session({ id: "ses_lobby_hidden", updated: 40, metadata: { "forge.internal": true } })

    expect(parseHomeSessionIndex([visible, internal]).map((item) => item.id)).toEqual(["visible"])
    expect(
      applyHomeSessionEvent(parseHomeSessionIndex([visible]), {
        type: "session.created",
        properties: { sessionID: internal.id, info: toLegacySummary(internal) },
      }).map((item) => item.id),
    ).toEqual(["visible"])
  })

  test("preserves the per-directory Home retention limit", () => {
    const now = 10 * 60 * 60 * 1000
    const sessions = Array.from({ length: 80 }, (_, index) => ({
      ...parseHomeSessionIndex([session({ id: `session-${index}`, updated: index + 1 })])[0],
      directory: index % 2 === 0 ? "/one" : "/two",
    }))

    const retained = retainHomeSessions(sessions, 10, now)
    expect(retained.filter((item) => item.directory === "/one")).toHaveLength(10)
    expect(retained.filter((item) => item.directory === "/two")).toHaveLength(10)
  })

  test("replays session events over the loaded index", () => {
    const now = Date.now()
    const initial = parseHomeSessionIndex([session({ id: "old", updated: now })])
    const created = { ...initial[0], id: "new", slug: "new", title: "new", time: { created: now, updated: now } }

    const afterCreate = applyHomeSessionEvent(initial, {
      type: "session.created",
      properties: { sessionID: created.id, info: created },
    })
    expect(
      applyHomeSessionEvent(afterCreate, {
        type: "session.deleted",
        properties: { sessionID: initial[0]!.id, info: initial[0]! },
      }),
    ).toEqual([created])
  })

  test("removes sessions when a live update is older than the inactivity window", () => {
    const now = 200_000_000
    const initial = parseHomeSessionIndex([session({ id: "old", updated: now })])
    const inactive = { ...initial[0]!, time: { ...initial[0]!.time, updated: now - 48 * 60 * 60 * 1_000 } }

    expect(
      applyHomeSessionEvent(
        initial,
        { type: "session.updated", properties: { sessionID: inactive.id, info: inactive } },
        now,
      ),
    ).toEqual([])
  })

  test("applies only events newer than the index baseline", () => {
    const now = Date.now()
    const initial = parseHomeSessionIndex([session({ id: "old", updated: now })])
    const stale = { ...initial[0], title: "stale" }
    const current = { ...initial[0], title: "current" }
    const first = appendHomeSessionEvent(undefined, {
      type: "session.updated",
      properties: { sessionID: stale.id, info: stale },
    })
    const events = appendHomeSessionEvent(first, {
      type: "session.updated",
      properties: { sessionID: current.id, info: current },
    })

    expect(homeSessionIndexSessions({ sessions: initial, eventSequence: 1 }, events)[0]?.title).toBe("current")
  })

  const legacy = (input: Parameters<typeof session>[0]) => parseHomeSessionIndex([session(input)])[0]!

  test("buffers live events when the index query is unmaterialized so they survive to the next load", () => {
    const client = new QueryClient()
    const cache = createHomeSessionIndexCache(client, "server-1")

    // No index query has ever registered on this client (the pre-fix guard dropped
    // this event outright).
    const created = legacy({ id: "fresh", updated: Date.now() })
    cache.apply({ type: "session.created", properties: { sessionID: created.id, info: created } })

    const buffered = client.getQueryData<HomeSessionEvents>(cache.eventsKey)
    expect(buffered?.entries.map((entry) => entry.event.properties.sessionID)).toEqual(["fresh"])

    // Once the index materializes the buffered creation replays and is visible.
    const index: HomeSessionIndex = { sessions: [], eventSequence: 0 }
    expect(cache.sessions(index, buffered).map((item) => item.id)).toEqual(["fresh"])
  })

  test("buffers an unmaterialized removal so a missed session.deleted still prunes on load", () => {
    const client = new QueryClient()
    const cache = createHomeSessionIndexCache(client, "server-1")

    cache.apply(removedHomeSessionEvent("gone"))

    const buffered = client.getQueryData<HomeSessionEvents>(cache.eventsKey)!
    const loaded: HomeSessionIndex = {
      sessions: parseHomeSessionIndex([session({ id: "gone", updated: Date.now() })]),
      eventSequence: 0,
    }
    expect(cache.sessions(loaded, buffered)).toEqual([])
  })

  test("applies the synthetic route-404 removal, pruning a listed session in place", () => {
    const client = new QueryClient()
    const cache = createHomeSessionIndexCache(client, "server-1")
    const now = Date.now()
    const sessions = parseHomeSessionIndex([
      session({ id: "gone", updated: now }),
      session({ id: "kept", updated: now - 1 }),
    ])
    client.setQueryData<HomeSessionIndex>(cache.indexKey, { sessions, eventSequence: 0 })
    client.setQueryData<HomeSessionEvents>(cache.eventsKey, { sequence: 0, entries: [] })

    cache.apply(removedHomeSessionEvent("gone"))

    expect(client.getQueryData<HomeSessionIndex>(cache.indexKey)?.sessions.map((item) => item.id)).toEqual(["kept"])
  })

  test("does not misfire: a route-404 removal for an unlisted session leaves the index intact", () => {
    const client = new QueryClient()
    const cache = createHomeSessionIndexCache(client, "server-1")
    // An archived session is excluded from the index and its route renders normally,
    // so the self-heal never targets a listed row for it; a stray removal must be inert.
    const sessions = parseHomeSessionIndex([session({ id: "kept", updated: Date.now() })])
    client.setQueryData<HomeSessionIndex>(cache.indexKey, { sessions, eventSequence: 0 })
    client.setQueryData<HomeSessionEvents>(cache.eventsKey, { sequence: 0, entries: [] })

    cache.apply(removedHomeSessionEvent("archived-or-absent"))

    expect(client.getQueryData<HomeSessionIndex>(cache.indexKey)?.sessions.map((item) => item.id)).toEqual(["kept"])
  })

  test("writes the index through the same client the panel reads (single shared cache)", () => {
    const client = new QueryClient()
    const cache = createHomeSessionIndexCache(client, "server-1")
    // The Agents panel reads via cache.queryClient; the writer must expose that exact
    // instance or live events land in a sibling cache the panel never renders.
    expect(cache.queryClient).toBe(client)

    client.setQueryData<HomeSessionIndex>(cache.indexKey, { sessions: [], eventSequence: 0 })
    client.setQueryData<HomeSessionEvents>(cache.eventsKey, { sequence: 0, entries: [] })
    const created = legacy({ id: "live", updated: Date.now() })
    cache.apply({ type: "session.created", properties: { sessionID: created.id, info: created } })

    // A reader on the exposed client sees the applied event with no refetch.
    expect(cache.queryClient.getQueryData<HomeSessionIndex>(cache.indexKey)?.sessions.map((item) => item.id)).toEqual([
      "live",
    ])
  })

  test("refetches after reconnect, disposal, and session moves", () => {
    expect(homeSessionIndexRefresh("server.connected", false)).toEqual({ connected: true, refetch: false })
    expect(homeSessionIndexRefresh("server.connected", true)).toEqual({ connected: true, refetch: true })
    expect(homeSessionIndexRefresh("global.disposed", true).refetch).toBe(true)
    expect(homeSessionIndexRefresh("session.next.moved", true).refetch).toBe(true)
  })
})
