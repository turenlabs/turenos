import { Binary } from "@turenlabs/core/util/binary"
import { retry } from "@turenlabs/core/util/retry"
import type {
  Message,
  ForgeClient,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionStatus,
  SnapshotFileDiff,
  Todo,
} from "@turenlabs/sdk/v2/client"
import { Session as SessionSchema } from "@turenlabs/schema/session"
import { createStore, produce, reconcile } from "solid-js/store"
import { diffs as cleanDiffs, message as cleanMessage } from "@/utils/diffs"
import { sessionNotFoundError } from "@/utils/server-errors"
import { rootSession } from "@/utils/session-route"
import { dropSessionCaches, pickSessionCacheEvictions, SESSION_CACHE_LIMIT } from "./global-sync/session-cache"
import { retainStreamedText, streamedText } from "./global-sync/part-snapshot"

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])
const sessionInfoLimit = 2_048

/**
 * How a V2 lifecycle event on the *global* SSE moves a session's busy indicator.
 *
 * The nav rail, sidebar and tab strip all read `data.session_status` from this store, but
 * until now nothing wrote it for sessions that are not on screen: core stopped publishing
 * the legacy `session.status` event, and the V2 timeline controller's durable stream and
 * `active()` poll are subscribed for the focused session only and torn down on tab switch.
 * A background session that finished therefore stayed "busy" until it was next focused.
 * The global `/event` stream does deliver `session.next.step/shell/compaction` events for
 * every session in the location, so this table lets `apply` consume them.
 *
 * "busy" writes immediately. "settle" must not write "idle" directly — a turn is many
 * steps and `step.ended` also fires between them — so it asks `v2.session.active()` for
 * the server's word, exactly like the focused-session controller's poll does.
 *
 * This deliberately mirrors `sessionEventStatusTransition` in the V2 timeline controller
 * rather than importing it: that module imports the sync contexts, which import this one.
 */
export function sessionNextStatusTransition(type: string): "busy" | "settle" | undefined {
  switch (type) {
    case "session.next.step.started":
    case "session.next.shell.started":
    case "session.next.compaction.started":
      return "busy"
    case "session.next.step.ended":
    case "session.next.step.failed":
    case "session.next.shell.ended":
    case "session.next.compaction.ended":
    case "session.next.compaction.failed":
      return "settle"
    default:
      return undefined
  }
}

// One `active()` snapshot settles a whole burst of boundary events; a session the server
// still reports (a mid-turn boundary, or teardown that has not deregistered yet) is
// re-checked on a modest interval that stops as soon as nothing is left to settle.
const STATUS_SETTLE_DEBOUNCE_MS = 300
const STATUS_SETTLE_RECHECK_MS = 2_000

type OptimisticItem = {
  message: Message
  parts: Part[]
  confirmedParts?: Part[]
  confirmedMessage?: boolean
}

function runInflight(map: Map<string, Promise<void>>, key: string, task: () => Promise<void>) {
  const pending = map.get(key)
  if (pending) return pending
  const promise = task().finally(() => {
    if (map.get(key) === promise) map.delete(key)
  })
  map.set(key, promise)
  return promise
}

function merge<T extends { id: string }>(a: readonly T[], b: readonly T[]) {
  const items = new Map(a.map((item) => [item.id, item] as const))
  for (const item of b) items.set(item.id, item)
  return [...items.values()].sort((x, y) => cmp(x.id, y.id))
}

/**
 * Locate an item by ID without assuming the array is ID-sorted.
 *
 * `data.message` / `data.part` usually are — but Session V2 owns them now and writes them
 * in *presentation* order (`project()` in
 * pages/session/goal/session-v2-timeline-controller.ts), which is only incidentally ID
 * order: a turn's user message is emitted before its assistant message whatever their IDs
 * compare as, and a user message's synthesised file/agent part IDs sort ahead of the text
 * part they follow. A bare `Binary.search` over such an array reports `found: false` for an
 * item that is plainly there, and the live event about it is then either dropped on the
 * floor or inserted a second time — a tool part frozen mid-run, a turn that never finishes,
 * a part rendered twice. `index` stays the binary-search insertion point so a genuinely new
 * item still lands in sorted position; only `found` is repaired.
 *
 * `createTimelineProjection`'s `activeMessageID` already carries the same linear fallback
 * for exactly this reason.
 */
function locate<T extends { id: string }>(items: T[], id: string) {
  const result = Binary.search(items, id, (item) => item.id)
  if (result.found) return result
  const index = items.findIndex((item) => item.id === id)
  if (index === -1) return result
  return { found: true, index }
}

/**
 * Session transcripts are read exclusively through the Session V2 endpoints, which the
 * timeline controller drains directly into `data.message` / `data.part`. This store owns
 * session metadata, live SSE application and optimistic echoes only — it never issues a
 * transcript read of its own.
 */
export function createServerSession(client: ForgeClient) {
  const [data, setData] = createStore({
    info: {} as Record<string, Session | undefined>,
    session_status: {} as Record<string, SessionStatus>,
    session_diff: {} as Record<string, SnapshotFileDiff[]>,
    todo: {} as Record<string, Todo[]>,
    permission: {} as Record<string, PermissionRequest[]>,
    question: {} as Record<string, QuestionRequest[]>,
    message: {} as Record<string, Message[]>,
    part: {} as Record<string, Part[]>,
    part_text_accum_delta: {} as Record<string, string>,
    session_working(id: string) {
      return (this.session_status[id]?.type ?? "idle") !== "idle"
    },
  })
  const requests = new Map<string, Promise<Session>>()
  const inflight = new Map<string, Promise<void>>()
  const inflightDiff = new Map<string, Promise<void>>()
  const inflightTodo = new Map<string, Promise<void>>()
  const optimistic = new Map<string, Map<string, OptimisticItem>>()
  const deltaBases = new Map<string, { base: string; sessionID: string }>()
  const deleteMessageParts = (
    cache: { part: Record<string, Part[] | undefined>; part_text_accum_delta: Record<string, string | undefined> },
    messageID: string,
  ) => {
    for (const part of cache.part[messageID] ?? []) {
      delete cache.part_text_accum_delta[part.id]
      deltaBases.delete(part.id)
    }
    delete cache.part[messageID]
  }
  const seen = new Set<string>()
  const infoSeen = new Set<string>()
  const internalSessions = new Set<string>()
  // Status snapshots are directory-scoped while this cache is server-scoped. Track ownership
  // and revisions so lazy status hydration can remove unknown stale IDs without overwriting a
  // newer live event or a newer snapshot that completed first.
  const statusDirectories = new Map<string, { directory: string; revision: number }>()
  const statusSnapshots = new Map<string, number>()
  const statusRevisions = new Map<string, number>()
  const statusSettlementHolds = new Map<string, number>()
  let statusRevision = 0
  const pinned = new Map<string, number>()
  const generations = new Map<string, object>()
  const generation = (sessionID: string) => {
    const current = generations.get(sessionID)
    if (current) return current
    const created = {}
    generations.set(sessionID, created)
    return created
  }
  // `at` records when a session's metadata was last resolved, which is the only
  // freshness signal this store still owns now that transcripts come from V2.
  const [meta, setMeta] = createStore({
    at: {} as Record<string, number | undefined>,
  })

  const remember = (session: Session) => {
    if (SessionSchema.isInternal(session)) {
      internalSessions.add(session.id)
      generations.delete(session.id)
      statusDirectories.delete(session.id)
      clearOptimistic(session.id)
      requests.delete(session.id)
      inflight.delete(session.id)
      inflightDiff.delete(session.id)
      inflightTodo.delete(session.id)
      statusSettlePending.delete(session.id)
      statusInfoPending.delete(session.id)
      statusRevisions.delete(session.id)
      statusSettlementHolds.delete(session.id)
      const evicted = new Set([session.id])
      for (const [partID, item] of deltaBases) {
        if (evicted.has(item.sessionID)) deltaBases.delete(partID)
      }
      setData(
        produce((draft) => {
          dropSessionCaches(draft, [session.id])
        }),
      )
      setMeta(produce((draft) => void delete draft.at[session.id]))
      return session
    }
    setData("info", session.id, reconcile(session))
    // A local optimistic status can be written before its metadata arrives. Once the
    // metadata is known, attach that status to its directory so a later snapshot can
    // clean it up safely instead of leaving an unowned entry forever.
    if (data.session_status[session.id] && !statusDirectories.has(session.id)) {
      statusDirectories.set(session.id, { directory: session.directory, revision: statusRevision })
    }
    infoSeen.delete(session.id)
    infoSeen.add(session.id)
    if (infoSeen.size > sessionInfoLimit) {
      const preserve = new Set([
        ...pinned.keys(),
        ...requests.keys(),
        ...inflight.keys(),
        ...inflightDiff.keys(),
        ...inflightTodo.keys(),
        ...optimistic.keys(),
        ...Object.entries(data.permission)
          .filter(([, items]) => items.length > 0)
          .map(([sessionID]) => sessionID),
        ...Object.entries(data.question)
          .filter(([, items]) => items.length > 0)
          .map(([sessionID]) => sessionID),
        ...Object.entries(data.session_status)
          .filter(([, status]) => status.type !== "idle")
          .map(([sessionID]) => sessionID),
      ])
      for (const sessionID of preserve) {
        let current = data.info[sessionID]
        while (current) {
          preserve.add(current.id)
          current = current.parentID ? data.info[current.parentID] : undefined
        }
      }
      const stale: string[] = []
      for (const sessionID of infoSeen) {
        if (infoSeen.size - stale.length <= sessionInfoLimit) break
        if (!preserve.has(sessionID)) stale.push(sessionID)
      }
      stale.forEach((sessionID) => infoSeen.delete(sessionID))
      stale.forEach((sessionID) => generations.delete(sessionID))
      setData(
        "info",
        produce((draft) => stale.forEach((sessionID) => delete draft[sessionID])),
      )
    }
    return session
  }

  const resolve = (sessionID: string, options?: { force?: boolean }) => {
    const cached = data.info[sessionID]
    if (cached && !options?.force) return Promise.resolve(cached)
    const pending = requests.get(sessionID)
    if (pending) return pending
    const active = generation(sessionID)
    const request = client.session.get({ sessionID }).then((result) => {
      if (!result.data) throw sessionNotFoundError(sessionID)
      if (generations.get(sessionID) !== active) return result.data
      return remember(result.data)
    })
    requests.set(sessionID, request)
    const cleanup = () => {
      if (requests.get(sessionID) === request) requests.delete(sessionID)
      if (
        generations.get(sessionID) === active &&
        !data.info[sessionID] &&
        !requests.has(sessionID) &&
        !inflight.has(sessionID) &&
        !inflightDiff.has(sessionID) &&
        !inflightTodo.has(sessionID)
      )
        generations.delete(sessionID)
    }
    void request.then(cleanup, cleanup)
    return request
  }

  const peekLineage = (sessionID: string) => {
    const session = data.info[sessionID]
    if (!session) return
    const seen = new Set([session.id])
    let root = session
    while (root.parentID) {
      if (seen.has(root.parentID)) throw new Error(`Session parent cycle: ${root.parentID}`)
      seen.add(root.parentID)
      const parent = data.info[root.parentID]
      if (!parent) return
      root = parent
    }
    return { session, root }
  }

  const clearOptimistic = (sessionID: string, messageID?: string) => {
    if (!messageID) {
      optimistic.delete(sessionID)
      return
    }
    const items = optimistic.get(sessionID)
    if (!items) return
    items.delete(messageID)
    if (items.size === 0) optimistic.delete(sessionID)
  }

  const clearOptimisticPart = (sessionID: string, messageID: string, partID: string) => {
    const items = optimistic.get(sessionID)
    const item = items?.get(messageID)
    if (!items || !item) return
    const parts = item.parts.filter((part) => part.id !== partID)
    const confirmedParts = item.confirmedParts?.filter((part) => part.id !== partID)
    if (parts.length === 0) {
      clearOptimistic(sessionID, messageID)
      return
    }
    items.set(messageID, { ...item, parts, confirmedParts, confirmedMessage: true })
  }

  const confirmOptimisticPart = (sessionID: string, messageID: string, part: Part) => {
    const items = optimistic.get(sessionID)
    const item = items?.get(messageID)
    if (!items || !item) return
    const parts = item.parts.filter((value) => value.id !== part.id)
    if (parts.length === 0) {
      clearOptimistic(sessionID, messageID)
      return
    }
    items.set(messageID, {
      ...item,
      parts,
      confirmedParts: merge(item.confirmedParts ?? [], [part]),
      confirmedMessage: true,
    })
  }

  const confirmOptimistic = (sessionID: string, messageID: string, confirmedParts: Part[]) => {
    const items = optimistic.get(sessionID)
    const item = items?.get(messageID)
    if (!items || !item) return
    const confirmed = new Set(confirmedParts.map((part) => part.id))
    const parts = item.parts.filter((part) => !confirmed.has(part.id))
    if (parts.length === 0) {
      clearOptimistic(sessionID, messageID)
      return
    }
    items.set(messageID, {
      ...item,
      parts,
      confirmedParts: merge(item.confirmedParts ?? [], confirmedParts),
      confirmedMessage: true,
    })
  }

  const evict = (sessionIDs: string[]) => {
    if (sessionIDs.length === 0) return
    const evicted = new Set(sessionIDs)
    for (const [partID, item] of deltaBases) {
      if (evicted.has(item.sessionID)) deltaBases.delete(partID)
    }
    sessionIDs.forEach((sessionID) => {
      generations.delete(sessionID)
      statusDirectories.delete(sessionID)
      clearOptimistic(sessionID)
      requests.delete(sessionID)
      inflight.delete(sessionID)
      inflightDiff.delete(sessionID)
      inflightTodo.delete(sessionID)
      statusSettlePending.delete(sessionID)
      statusInfoPending.delete(sessionID)
      statusRevisions.delete(sessionID)
      statusSettlementHolds.delete(sessionID)
    })
    setData(
      produce((draft) => {
        dropSessionCaches(draft, sessionIDs)
      }),
    )
    setMeta(
      produce((draft) => {
        for (const sessionID of sessionIDs) delete draft.at[sessionID]
      }),
    )
  }

  const protectedSessions = () =>
    new Set([
      ...pinned.keys(),
      ...requests.keys(),
      ...inflight.keys(),
      ...inflightDiff.keys(),
      ...inflightTodo.keys(),
      ...optimistic.keys(),
      ...Object.entries(data.permission)
        .filter(([, items]) => items.length > 0)
        .map(([sessionID]) => sessionID),
      ...Object.entries(data.question)
        .filter(([, items]) => items.length > 0)
        .map(([sessionID]) => sessionID),
      ...Object.entries(data.session_status)
        .filter(([, status]) => status.type !== "idle")
        .map(([sessionID]) => sessionID),
    ])

  const touch = (sessionID: string) =>
    evict(
      pickSessionCacheEvictions({ seen, keep: sessionID, limit: SESSION_CACHE_LIMIT, preserve: protectedSessions() }),
    )

  const sync = (sessionID: string, options?: { force?: boolean }) => {
    touch(sessionID)
    return runInflight(inflight, sessionID, async () => {
      if (data.info[sessionID] && !options?.force) return
      await resolve(sessionID, options)
      setMeta("at", sessionID, Date.now())
    })
  }

  // Warms session metadata for sessions the user is likely to open next. Transcript
  // content is not prefetchable from here: the V2 timeline controller owns it and
  // only hydrates the session actually on screen.
  const prefetch = async (sessionID: string) => {
    touch(sessionID)
    await inflight.get(sessionID)
    if (Date.now() - (meta.at[sessionID] ?? 0) <= 15_000) return
    await sync(sessionID)
  }

  // Sessions whose latest lifecycle event said "this turn may be over"; settled against
  // one shared `active()` snapshot instead of one request per event.
  const statusSettlePending = new Set<string>()
  // Sessions owed a forced metadata refresh: cost and tokens accrue server-side with no
  // event of their own, so the step boundary that scheduled a settle is also the moment
  // `info.cost` (the context meter) goes stale. Event-seeded only — the 2s re-check loop
  // re-adds `statusSettlePending` but never this set, so a long turn is not polled.
  const statusInfoPending = new Set<string>()
  let statusSettleTimer: ReturnType<typeof setTimeout> | undefined
  const armStatusSettle = (delay: number) => {
    if (statusSettleTimer !== undefined) return
    statusSettleTimer = setTimeout(() => {
      statusSettleTimer = undefined
      void settleStatuses()
    }, delay)
  }
  const scheduleStatusSettle = (sessionID: string) => {
    statusSettlePending.add(sessionID)
    statusInfoPending.add(sessionID)
    armStatusSettle(STATUS_SETTLE_DEBOUNCE_MS)
  }

  const markStatus = (sessionID: string, directory?: string) => {
    statusRevision += 1
    statusRevisions.set(sessionID, statusRevision)
    const owner = directory ?? statusDirectories.get(sessionID)?.directory ?? data.info[sessionID]?.directory
    if (owner) statusDirectories.set(sessionID, { directory: owner, revision: statusRevision })
    return statusRevision
  }

  const beginStatusSnapshot = () => ++statusRevision

  const settleStatuses = async () => {
    const refresh = [...statusInfoPending]
    statusInfoPending.clear()
    refresh.forEach((sessionID) => void resolve(sessionID, { force: true }).catch(() => undefined))
    const ids = [...statusSettlePending]
    statusSettlePending.clear()
    if (ids.length === 0) return
    const revisions = new Map(ids.map((sessionID) => [sessionID, statusRevisions.get(sessionID) ?? 0]))
    try {
      const response = await client.v2.session.active()
      const active = response.data?.data ?? {}
      for (const sessionID of ids) {
        if ((statusRevisions.get(sessionID) ?? 0) !== revisions.get(sessionID)) continue
        if (active[sessionID]) {
          // Still running: a boundary between steps, or teardown that has not
          // deregistered yet. Keep it tracked; the next busy event untracks it.
          statusSettlePending.add(sessionID)
          continue
        }
        if (statusSettlementHolds.has(sessionID)) {
          statusSettlePending.add(sessionID)
          continue
        }
        // Only downgrade a plain "busy". A "retry" is richer information owned by the
        // focused-session controller and resolves through its own step events.
        if (data.session_status[sessionID]?.type === "busy") {
          markStatus(sessionID)
          setData("session_status", sessionID, { type: "idle" })
        }
      }
    } catch {
      for (const sessionID of ids) statusSettlePending.add(sessionID)
    }
    if (statusSettlePending.size > 0) armStatusSettle(STATUS_SETTLE_RECHECK_MS)
  }

  const setStatuses = (
    directory: string,
    statuses: Record<string, SessionStatus>,
    snapshotRevision = statusRevision,
  ) => {
    const previousSnapshot = statusSnapshots.get(directory)
    if (previousSnapshot !== undefined && snapshotRevision < previousSnapshot) return
    statusSnapshots.set(directory, snapshotRevision)
    const keep = new Set(Object.keys(statuses))
    const stale = new Set<string>()
    const candidates = new Set([...Object.keys(data.session_status), ...statusDirectories.keys()])
    for (const sessionID of candidates) {
      if (keep.has(sessionID)) continue
      if (statusSettlementHolds.has(sessionID)) {
        statusSettlePending.add(sessionID)
        continue
      }
      const statusOwner = statusDirectories.get(sessionID)
      if (
        (statusOwner?.directory === directory && statusOwner.revision <= snapshotRevision) ||
        (!statusOwner && data.info[sessionID]?.directory === directory)
      )
        stale.add(sessionID)
    }
    const writable = [...keep].filter((sessionID) => {
      if (statusSettlementHolds.has(sessionID) && statuses[sessionID]?.type === "idle") {
        statusSettlePending.add(sessionID)
        return false
      }
      const statusOwner = statusDirectories.get(sessionID)
      return !statusOwner || statusOwner.revision <= snapshotRevision
    })

    for (const sessionID of stale) {
      markStatus(sessionID, directory)
      statusDirectories.delete(sessionID)
    }
    for (const sessionID of writable) markStatus(sessionID, directory)

    // A direct local status write without cached metadata has no safe directory owner. Keep it
    // until the session is resolved; clearing it from an arbitrary directory snapshot could
    // erase a status belonging to another directory.

    setData(
      "session_status",
      produce((draft) => {
        for (const sessionID of stale) delete draft[sessionID]
        for (const sessionID of writable) draft[sessionID] = statuses[sessionID]!
      }),
    )
  }

  const eventSessionID = (event: { type: string; properties?: unknown }) => {
    const properties = event.properties
    if (!properties || typeof properties !== "object") return
    if ("sessionID" in properties && typeof properties.sessionID === "string") return properties.sessionID
    if (
      "info" in properties &&
      properties.info &&
      typeof properties.info === "object" &&
      "sessionID" in properties.info &&
      typeof properties.info.sessionID === "string"
    )
      return properties.info.sessionID
    if (
      "part" in properties &&
      properties.part &&
      typeof properties.part === "object" &&
      "sessionID" in properties.part &&
      typeof properties.part.sessionID === "string"
    )
      return properties.part.sessionID
  }

  const apply = (event: { type: string; properties?: unknown }, directory?: string) => {
    const eventID = eventSessionID(event)
    if (eventID && (eventID.startsWith("ses_lobby_") || internalSessions.has(eventID))) {
      if (event.type === "session.deleted") internalSessions.delete(eventID)
      return
    }
    if (eventID) {
      touch(eventID)
      if (
        !data.info[eventID] &&
        event.type !== "session.created" &&
        event.type !== "session.updated" &&
        event.type !== "session.deleted"
      )
        void resolve(eventID).catch(() => {})
      const transition = sessionNextStatusTransition(event.type)
      if (transition === "busy") {
        markStatus(eventID, directory)
        statusSettlePending.delete(eventID)
        if (data.session_status[eventID]?.type !== "busy") setData("session_status", eventID, { type: "busy" })
        return
      }
      if (transition === "settle") {
        markStatus(eventID, directory)
        scheduleStatusSettle(eventID)
        return
      }
    }
    switch (event.type) {
      case "session.created":
        remember((event.properties as { info: Session }).info)
        return
      case "session.updated": {
        const info = (event.properties as { info: Session }).info
        remember(info)
        if (info.time.archived) evict([info.id])
        return
      }
      case "session.deleted": {
        const sessionID = (event.properties as { info: Session }).info.id
        infoSeen.delete(sessionID)
        setData(
          "info",
          produce((draft) => void delete draft[sessionID]),
        )
        evict([sessionID])
        return
      }
      // V2 renames are a one-field delta rather than a whole-session snapshot, so patch the field.
      // An uncached session has already been queued for a full resolve above.
      case "session.next.title.updated": {
        const props = event.properties as { sessionID: string; title: string }
        if (!data.info[props.sessionID]) return
        setData("info", props.sessionID, "title", props.title)
        return
      }
      case "session.diff": {
        const props = event.properties as { sessionID: string; diff: SnapshotFileDiff[] }
        setData("session_diff", props.sessionID, reconcile(cleanDiffs(props.diff), { key: "file" }))
        return
      }
      case "todo.updated": {
        const props = event.properties as { sessionID: string; todos: Todo[] }
        setData("todo", props.sessionID, reconcile(props.todos, { key: "id" }))
        return
      }
      case "session.status": {
        const props = event.properties as { sessionID: string; status: SessionStatus }
        markStatus(props.sessionID, directory)
        setData("session_status", props.sessionID, reconcile(props.status))
        return
      }
      case "message.updated": {
        const info = cleanMessage((event.properties as { info: Message }).info)
        const items = optimistic.get(info.sessionID)
        const item = items?.get(info.id)
        if (items && item) {
          if (item.parts.length === 0) clearOptimistic(info.sessionID, info.id)
          if (item.parts.length > 0) items.set(info.id, { ...item, confirmedMessage: true })
        }
        const messages = data.message[info.sessionID]
        if (!messages) {
          setData("message", info.sessionID, [info])
          return
        }
        const result = locate(messages, info.id)
        if (result.found) setData("message", info.sessionID, result.index, reconcile(info))
        if (!result.found)
          setData("message", info.sessionID, (value = []) => {
            const next = value.slice()
            next.splice(result.index, 0, info)
            return next
          })
        return
      }
      case "message.removed": {
        const props = event.properties as { sessionID: string; messageID: string }
        clearOptimistic(props.sessionID, props.messageID)
        setData(
          produce((draft) => {
            const messages = draft.message[props.sessionID]
            if (messages) {
              const result = locate(messages, props.messageID)
              if (result.found) messages.splice(result.index, 1)
            }
            deleteMessageParts(draft, props.messageID)
          }),
        )
        return
      }
      case "message.part.updated": {
        const incoming = (event.properties as { part: Part }).part
        if (SKIP_PARTS.has(incoming.type)) return
        const messages = data.message[incoming.sessionID]
        // Accepting a part without its ordered parent message would create an unbounded orphan.
        if (!messages || !locate(messages, incoming.messageID).found) return
        const part = retainStreamedText(
          incoming,
          streamedText(
            data.part_text_accum_delta,
            data.part[incoming.messageID]?.find((item) => item.id === incoming.id),
          ),
        )
        deltaBases.delete(part.id)
        confirmOptimisticPart(part.sessionID, part.messageID, part)
        setData(
          "part_text_accum_delta",
          produce((draft) => void delete draft[part.id]),
        )
        const parts = data.part[part.messageID]
        if (!parts) {
          setData("part", part.messageID, [part])
          return
        }
        const result = locate(parts, part.id)
        if (result.found) setData("part", part.messageID, result.index, reconcile(part))
        if (!result.found)
          setData("part", part.messageID, (value = []) => {
            const next = value.slice()
            next.splice(result.index, 0, part)
            return next
          })
        return
      }
      case "message.part.removed": {
        const props = event.properties as { sessionID: string; messageID: string; partID: string }
        clearOptimisticPart(props.sessionID, props.messageID, props.partID)
        setData(
          produce((draft) => {
            delete draft.part_text_accum_delta[props.partID]
            deltaBases.delete(props.partID)
            const parts = draft.part[props.messageID]
            if (!parts) return
            const result = locate(parts, props.partID)
            if (result.found) parts.splice(result.index, 1)
            if (parts.length === 0) delete draft.part[props.messageID]
          }),
        )
        return
      }
      case "message.part.delta": {
        const props = event.properties as {
          sessionID: string
          messageID: string
          partID: string
          field: string
          delta: string
        }
        const parts = data.part[props.messageID]
        if (!parts) return
        const result = locate(parts, props.partID)
        if (!result.found) return
        const field = props.field as keyof (typeof parts)[number]
        const current = parts[result.index]?.[field]
        if (!deltaBases.has(props.partID) && typeof current === "string")
          deltaBases.set(props.partID, { base: current, sessionID: props.sessionID })
        setData(
          "part_text_accum_delta",
          props.partID,
          (value) => (value ?? (typeof current === "string" ? current : "")) + props.delta,
        )
        setData(
          "part",
          props.messageID,
          produce((draft) => {
            if (!draft) return
            const part = draft[result.index]
            const field = props.field as keyof typeof part
            ;(part[field] as string) = ((part[field] as string | undefined) ?? "") + props.delta
          }),
        )
        return
      }
      case "permission.asked": {
        const permission = event.properties as PermissionRequest
        const permissions = data.permission[permission.sessionID]
        if (!permissions) {
          setData("permission", permission.sessionID, [permission])
          return
        }
        const result = Binary.search(permissions, permission.id, (item) => item.id)
        if (result.found) setData("permission", permission.sessionID, result.index, reconcile(permission))
        if (!result.found)
          setData(
            "permission",
            permission.sessionID,
            produce((draft) => void draft.splice(result.index, 0, permission)),
          )
        return
      }
      case "permission.replied": {
        const props = event.properties as { sessionID: string; requestID: string }
        setData(
          "permission",
          props.sessionID,
          produce((draft) => {
            if (!draft) return
            const result = Binary.search(draft, props.requestID, (item) => item.id)
            if (result.found) draft.splice(result.index, 1)
          }),
        )
        return
      }
      case "question.v2.asked": {
        const question = event.properties as QuestionRequest
        const questions = data.question[question.sessionID]
        if (!questions) {
          setData("question", question.sessionID, [question])
          return
        }
        const result = Binary.search(questions, question.id, (item) => item.id)
        if (result.found) setData("question", question.sessionID, result.index, reconcile(question))
        if (!result.found)
          setData(
            "question",
            question.sessionID,
            produce((draft) => void draft.splice(result.index, 0, question)),
          )
        return
      }
      case "question.v2.replied":
      case "question.v2.rejected": {
        const props = event.properties as { sessionID: string; requestID: string }
        setData(
          "question",
          props.sessionID,
          produce((draft) => {
            if (!draft) return
            const result = Binary.search(draft, props.requestID, (item) => item.id)
            if (result.found) draft.splice(result.index, 1)
          }),
        )
      }
    }
  }

  const set = ((...input: unknown[]) => {
    if (input[0] === "session_status" && typeof input[1] === "string") markStatus(input[1])
    return (setData as (...args: unknown[]) => unknown)(...input)
  }) as typeof setData

  return {
    data,
    set,
    setStatuses,
    beginStatusSnapshot,
    statusRevision: (sessionID: string) => statusRevisions.get(sessionID) ?? 0,
    holdStatusSettlement(sessionID: string) {
      statusSettlementHolds.set(sessionID, (statusSettlementHolds.get(sessionID) ?? 0) + 1)
      let held = true
      return () => {
        if (!held) return
        held = false
        const count = statusSettlementHolds.get(sessionID)
        if (!count || count === 1) statusSettlementHolds.delete(sessionID)
        if (count && count > 1) statusSettlementHolds.set(sessionID, count - 1)
        if (statusSettlePending.has(sessionID)) armStatusSettle(0)
      }
    },
    get: (sessionID: string) => data.info[sessionID],
    peek: (sessionID: string) => data.info[sessionID],
    remember,
    resolve,
    lineage: {
      peek: peekLineage,
      async resolve(sessionID: string) {
        const session = await resolve(sessionID)
        return { session, root: await rootSession(session, resolve) }
      },
    },
    sync,
    prefetch,
    shouldPrefetch(sessionID: string) {
      if (data.info[sessionID] === undefined) return true
      return Date.now() - (meta.at[sessionID] ?? 0) > 15_000
    },
    fresh(sessionID: string, ttl: number) {
      return Date.now() - (meta.at[sessionID] ?? 0) <= ttl
    },
    optimistic: {
      add(input: { sessionID: string; message: Message; parts: Part[] }) {
        const parts = input.parts
          .filter((part) => !!part?.id && !SKIP_PARTS.has(part.type))
          .sort((a, b) => cmp(a.id, b.id))
        const items = optimistic.get(input.sessionID)
        if (items) items.set(input.message.id, { ...input, parts, confirmedParts: [] })
        if (!items)
          optimistic.set(input.sessionID, new Map([[input.message.id, { ...input, parts, confirmedParts: [] }]]))
        setData("message", input.sessionID, (messages = []) => merge(messages, [input.message]))
        setData(
          "part_text_accum_delta",
          produce((draft) => {
            for (const part of [...(data.part[input.message.id] ?? []), ...parts]) {
              delete draft[part.id]
              deltaBases.delete(part.id)
            }
          }),
        )
        setData("part", input.message.id, parts)
      },
      remove(input: { sessionID: string; messageID: string }) {
        const item = optimistic.get(input.sessionID)?.get(input.messageID)
        if (!item) return
        clearOptimistic(input.sessionID, input.messageID)
        if (item.confirmedMessage) {
          const partIDs = new Set(item.parts.map((part) => part.id))
          setData(
            produce((draft) => {
              for (const part of item.parts) {
                delete draft.part_text_accum_delta[part.id]
                deltaBases.delete(part.id)
              }
              const parts = draft.part[input.messageID]
              if (!parts) return
              draft.part[input.messageID] = parts.filter((part) => !partIDs.has(part.id))
              if (draft.part[input.messageID]?.length === 0) delete draft.part[input.messageID]
            }),
          )
          return
        }
        setData("message", input.sessionID, (messages) => messages?.filter((message) => message.id !== input.messageID))
        setData(produce((draft) => deleteMessageParts(draft, input.messageID)))
      },
    },
    diff(sessionID: string, options?: { force?: boolean }) {
      touch(sessionID)
      if (data.session_diff[sessionID] !== undefined && !options?.force) return Promise.resolve()
      return runInflight(inflightDiff, sessionID, () => {
        const active = generation(sessionID)
        return retry(() => client.session.diff({ sessionID })).then((result) => {
          if (generations.get(sessionID) !== active) return
          setData("session_diff", sessionID, reconcile(cleanDiffs(result.data), { key: "file" }))
        })
      })
    },
    todo(sessionID: string, options?: { force?: boolean }) {
      touch(sessionID)
      if (data.todo[sessionID] !== undefined && !options?.force) return Promise.resolve()
      return runInflight(inflightTodo, sessionID, () => {
        const active = generation(sessionID)
        return retry(() => client.session.todo({ sessionID })).then((result) => {
          if (generations.get(sessionID) !== active) return
          setData("todo", sessionID, reconcile(result.data ?? [], { key: "id" }))
        })
      })
    },
    evict(sessionID: string) {
      if (protectedSessions().has(sessionID)) return
      seen.delete(sessionID)
      evict([sessionID])
    },
    pin(sessionID: string) {
      pinned.set(sessionID, (pinned.get(sessionID) ?? 0) + 1)
      touch(sessionID)
    },
    unpin(sessionID: string) {
      const count = pinned.get(sessionID)
      if (!count || count === 1) pinned.delete(sessionID)
      if (count && count > 1) pinned.set(sessionID, count - 1)
    },
    apply,
  }
}

export type ServerSession = ReturnType<typeof createServerSession>
