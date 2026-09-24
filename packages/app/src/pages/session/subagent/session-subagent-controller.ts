import { batch, createEffect, createMemo, onCleanup, type Accessor } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { SwarmRoomEntry, SwarmRoomState } from "@turenlabs/sdk/v2/client"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { sessionTurnActivity } from "@/pages/session/goal/session-v2-timeline-controller"
import {
  applySessionTaskSnapshot,
  sessionTaskActive,
  sessionTaskIDs,
  sessionTaskRoot,
  type SessionTaskInfo,
} from "./session-subagent"

const SUBAGENT_TOOLS = new Set([
  "spawn_agent",
  "spawn_agents",
  "send_agent",
  "wait_agents",
  "interrupt_agent",
  "room_post",
  "room_read",
  "room_claim",
])
const RECONCILE_DEBOUNCE_MS = 200
const ROOM_POLL_INTERVAL_MS = 30_000
const MAX_ROOM_ENTRIES = 200

export function createSessionSubagentController(input: { sessionID: Accessor<string | undefined> }) {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const [store, setStore] = createStore({
    tasks: {} as Record<string, SessionTaskInfo | undefined>,
    roots: {} as Record<string, string | undefined>,
    loading: {} as Record<string, boolean | undefined>,
    loadFailure: {} as Record<string, string | undefined>,
    cancelPending: {} as Record<string, boolean | undefined>,
    cancelFailure: {} as Record<string, string | undefined>,
    room: {} as Record<string, SwarmRoomState | undefined>,
    roomEntries: {} as Record<string, SwarmRoomEntry[] | undefined>,
    roomLoading: {} as Record<string, boolean | undefined>,
    roomFailure: {} as Record<string, string | undefined>,
    roomSending: {} as Record<string, boolean | undefined>,
  })
  let hydration = 0
  const roomInFlight = new Set<string>()

  const apply = (task: SessionTaskInfo) => {
    const summary: SessionTaskInfo = {
      id: task.id,
      rootSessionID: task.rootSessionID,
      parentSessionID: task.parentSessionID,
      childSessionID: task.childSessionID,
      parentTaskID: task.parentTaskID,
      agent: task.agent,
      model: task.model,
      description: task.description,
      wave: task.wave,
      depth: task.depth,
      status: task.status,
      revision: task.revision,
      result: task.result,
      error: task.error,
      time: task.time,
    }
    batch(() => {
      setStore("tasks", summary.id, (current) => applySessionTaskSnapshot(current, summary))
      setStore("roots", summary.rootSessionID, summary.rootSessionID)
      setStore("roots", summary.childSessionID, summary.rootSessionID)
      if (!sessionTaskActive(summary)) {
        setStore("cancelPending", summary.id, false)
        setStore("cancelFailure", summary.id, undefined)
      }
    })
  }

  const roomNotFound = (error: unknown) =>
    (error as { _tag?: string } | undefined)?._tag === "SwarmRoomNotFoundError"

  const refreshRoom = (selectedSessionID = input.sessionID(), options?: { silent?: boolean }) => {
    if (!selectedSessionID) return Promise.resolve()
    const sessionID = selectedSessionID
    if (roomInFlight.has(sessionID)) return Promise.resolve()
    roomInFlight.add(sessionID)
    const client = sdk().client
    if (!options?.silent) {
      setStore("roomLoading", sessionID, true)
      setStore("roomFailure", sessionID, undefined)
    }
    const tail = store.roomEntries[sessionID]?.at(-1)?.seq
    return Promise.all([
      client.v2.session.swarmRoom({ sessionID }),
      client.v2.session.swarmRoomEntries({
        sessionID,
        ...(tail === undefined ? {} : { after: String(tail) }),
      }),
    ])
      .then(([roomResponse, entriesResponse]) => {
        if (!roomResponse.data || !entriesResponse.data) {
          const error = roomResponse.error ?? entriesResponse.error
          if (roomNotFound(error)) {
            batch(() => {
              setStore("room", sessionID, undefined)
              setStore("roomEntries", sessionID, undefined)
            })
            return
          }
          throw error ?? new Error("Room request failed")
        }
        const page = entriesResponse.data.data
        batch(() => {
          setStore("room", sessionID, roomResponse.data!.data)
          const existing = store.roomEntries[sessionID] ?? []
          const seen = new Set(existing.map((entry) => entry.id))
          setStore(
            "roomEntries",
            sessionID,
            [...existing, ...page.entries.filter((entry) => !seen.has(entry.id))]
              .toSorted((left, right) => left.seq - right.seq)
              .slice(-MAX_ROOM_ENTRIES),
          )
          setStore("roomFailure", sessionID, undefined)
        })
      })
      .catch((error) => {
        if (roomNotFound(error)) {
          batch(() => {
            setStore("room", sessionID, undefined)
            setStore("roomEntries", sessionID, undefined)
          })
          return
        }
        if (!options?.silent) setStore("roomFailure", sessionID, taskFailureMessage(error))
      })
      .finally(() => {
        roomInFlight.delete(sessionID)
        if (!options?.silent) setStore("roomLoading", sessionID, false)
      })
  }

  const postRoomMessage = (text: string) => {
    const sessionID = input.sessionID()
    const trimmed = text.trim()
    if (!sessionID || !trimmed || store.roomSending[sessionID]) return Promise.resolve(false)
    const client = sdk().client
    setStore("roomSending", sessionID, true)
    return client.v2.session
      .swarmRoomPost({ sessionID, swarmRoomHumanPostInput: { text: trimmed } })
      .then(async (response) => {
        if (!response.data) throw response.error
        await refreshRoom(sessionID, { silent: true })
        return true
      })
      .catch((error) => {
        setStore("roomFailure", sessionID, taskFailureMessage(error))
        return false
      })
      .finally(() => setStore("roomSending", sessionID, false))
  }

  const refresh = (selectedSessionID = input.sessionID()) => {
    if (!selectedSessionID) return Promise.resolve()
    const sessionID = selectedSessionID
    const request = ++hydration
    const client = sdk().client
    const pages: SessionTaskInfo[] = []
    setStore("loading", sessionID, true)
    setStore("loadFailure", sessionID, undefined)
    const roomLoad = refreshRoom(sessionID)
    function load(params: Parameters<typeof client.v2.session.task.list>[0]): Promise<void> {
      return client.v2.session.task.list(params).then((response) => {
        if (request !== hydration || input.sessionID() !== sessionID) return
        pages.push(...response.data!.active, ...response.data!.data)
        const cursor = response.data!.cursor.next
        if (cursor) return load({ sessionID, cursor })
        const tasks = [...new Map(pages.map((task) => [task.id, task])).values()]
        batch(() => {
          tasks.forEach(apply)
          setStore("roots", sessionID, tasks[0]?.rootSessionID ?? sessionTaskRoot(store.tasks, store.roots, sessionID))
        })
      })
    }
    const taskLoad = load({ sessionID })
      .catch((error) => {
        if (request !== hydration || input.sessionID() !== sessionID) return
        setStore("loadFailure", sessionID, taskFailureMessage(error))
      })
      .finally(() => {
        if (request !== hydration || input.sessionID() !== sessionID) return
        setStore("loading", sessionID, false)
      })
    return Promise.all([taskLoad, roomLoad]).then(() => undefined)
  }

  // Coalesces the burst a fan-out produces (four spawns in ~45s, each with a call and a
  // settlement) into one list fetch, while still landing well inside a frame budget.
  let reconcileTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleReconcile = () => {
    if (reconcileTimer !== undefined) return
    reconcileTimer = setTimeout(() => {
      reconcileTimer = undefined
      void refresh()
    }, RECONCILE_DEBOUNCE_MS)
  }
  onCleanup(() => {
    if (reconcileTimer !== undefined) clearTimeout(reconcileTimer)
  })

  createEffect(() => {
    const sessionID = input.sessionID()
    if (!sessionID) return
    void refresh(sessionID)
  })

  // Room entries are durable, but their live event can be missed during a reconnect. Keep the
  // fallback deliberately slow and single-flight; tool events still make normal updates land
  // immediately through scheduleReconcile().
  createEffect(() => {
    const sessionID = input.sessionID()
    if (!sessionID) return
    const timer = window.setInterval(() => {
      if (input.sessionID() !== sessionID) return
      if (!roomInFlight.has(sessionID)) void refreshRoom(sessionID, { silent: true })
    }, ROOM_POLL_INTERVAL_MS)
    onCleanup(() => window.clearInterval(timer))
  })

  // The primary live trigger. The `sdk().event` subscriptions below listen on the
  // per-directory global bus, whose delivery of durable session events depends on how the
  // publisher attributed the event's location — in practice a spawn could land without
  // this store ever hearing about it, leaving the panel frozen until the next remount.
  // The timeline controller drains the session's own durable stream (the transcript's
  // source of truth) and bumps this counter on every subagent-tool start and settlement,
  // so the panel reconciles while you watch. The bus subscriptions stay as fallback for
  // events from elsewhere in the task tree.
  createEffect(() => {
    const sessionID = input.sessionID()
    if (!sessionID) return
    const version = sessionTurnActivity.get(sessionID).agentToolEvents
    if (version === 0) return
    scheduleReconcile()
  })

  createEffect(() => {
    const current = sdk()
    const updated = current.event.on("session.next.task.updated", (event) => apply(event.properties.task))
    onCleanup(updated)
  })

  // Live room posts land as located events; the fallback is the same reconcile the
  // board uses, so a missed event only delays the stream by one poll.
  createEffect(() => {
    const current = sdk()
    const sessionID = input.sessionID()
    if (!sessionID) return
    const dispose = current.event.on("swarm.room.posted", (event) => {
      const root = event.properties.rootSessionID
      if (root !== sessionID && root !== rootSessionID()) return
      void refreshRoom(sessionID, { silent: true })
    })
    onCleanup(dispose)
  })

  createEffect(() => {
    const current = serverSDK()
    const reconnect = current.event.on("global", (event) => {
      if (event.type !== "server.connected" && event.type !== "global.disposed") return
      void refresh()
    })
    onCleanup(reconnect)
  })

  const rootSessionID = createMemo(() => {
    const sessionID = input.sessionID()
    return sessionID ? sessionTaskRoot(store.tasks, store.roots, sessionID) : undefined
  })
  const taskIDs = createMemo(() => {
    const root = rootSessionID()
    return root ? sessionTaskIDs(store.tasks, root) : []
  })

  // Task updates are advisory live events and can be lost across a disconnect or reconnect.
  // Subagent *tool* events also signal that the task list may have changed, so use them to
  // reconcile the durable list instead of relying on the task stream alone.
  createEffect(() => {
    const current = sdk()
    const sessionID = input.sessionID()
    if (!sessionID) return
    const pending = new Set<string>()
    const pendingKey = (origin: string, callID: string) => `${origin}\0${callID}`
    const inTree = (origin: string) => sessionTaskRoot(store.tasks, store.roots, origin) === rootSessionID()
    const disposers = [
      current.event.on("session.next.tool.called", (event) => {
        const { tool, callID, sessionID: origin } = event.properties
        if (!SUBAGENT_TOOLS.has(tool)) return
        if (!inTree(origin)) return
        // `tool.called` fires before the tool body runs, so the row may not exist yet; the
        // matching settlement below is what guarantees a refresh that can see it.
        pending.add(pendingKey(origin, callID))
        scheduleReconcile()
      }),
      current.event.on("session.next.tool.success", (event) => {
        if (!pending.delete(pendingKey(event.properties.sessionID, event.properties.callID))) return
        scheduleReconcile()
      }),
      current.event.on("session.next.tool.failed", (event) => {
        if (!pending.delete(pendingKey(event.properties.sessionID, event.properties.callID))) return
        scheduleReconcile()
      }),
    ]
    onCleanup(() => disposers.forEach((dispose) => dispose()))
  })
  const owner = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID) return
    return taskIDs()
      .map((id) => store.tasks[id])
      .find((task) => task?.childSessionID === sessionID)
  })

  const cancel = (taskID: string) => {
    const sessionID = input.sessionID()
    const task = store.tasks[taskID]
    if (!sessionID || !task || !sessionTaskActive(task) || store.cancelPending[taskID]) return Promise.resolve()
    const client = sdk().client
    setStore("cancelPending", taskID, true)
    setStore("cancelFailure", taskID, undefined)
    return client.v2.session.task
      .cancel({
        sessionID,
        taskID,
        sessionTaskCancelPayload: { expectedRevision: task.revision },
      })
      .then((response) => apply(response.data!.data))
      .catch((error) => {
        setStore("cancelFailure", taskID, taskFailureMessage(error))
        return client.v2.session.task
          .get({ sessionID, taskID })
          .then((response) => apply(response.data!.data))
          .catch(() => undefined)
      })
      .finally(() => setStore("cancelPending", taskID, false))
  }

  return {
    sessionID: input.sessionID,
    rootSessionID,
    taskIDs,
    task: (taskID: string) => store.tasks[taskID],
    owner,
    loading: () => {
      const sessionID = input.sessionID()
      return sessionID ? !!store.loading[sessionID] : false
    },
    loadFailure: () => {
      const sessionID = input.sessionID()
      return sessionID ? store.loadFailure[sessionID] : undefined
    },
    room: () => {
      const sessionID = input.sessionID()
      return sessionID ? store.room[sessionID] : undefined
    },
    roomEntries: () => {
      const sessionID = input.sessionID()
      return sessionID ? (store.roomEntries[sessionID] ?? []) : []
    },
    roomLoading: () => {
      const sessionID = input.sessionID()
      return sessionID ? !!store.roomLoading[sessionID] : false
    },
    roomFailure: () => {
      const sessionID = input.sessionID()
      return sessionID ? store.roomFailure[sessionID] : undefined
    },
    roomSending: () => {
      const sessionID = input.sessionID()
      return sessionID ? !!store.roomSending[sessionID] : false
    },
    cancelPending: (taskID: string) => !!store.cancelPending[taskID],
    cancelFailure: (taskID: string) => store.cancelFailure[taskID],
    dismissCancelFailure: (taskID: string) => setStore("cancelFailure", taskID, undefined),
    refresh,
    refreshRoom,
    postRoomMessage,
    cancel,
  }
}

function taskFailureMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  return "Request failed"
}

export type SessionSubagentController = ReturnType<typeof createSessionSubagentController>
