import type { MessagesListOutput } from "@turenlabs/client"
import type { Connection } from "./server"
import type { DashboardState } from "./state"
import { createLiveProjection } from "./live-projection"

export function createLiveSession(
  state: DashboardState,
  connection: Connection,
  hooks: {
    paint: (messages: MessagesListOutput["data"]) => void
    snapshot: (metadata?: boolean) => void
    status: () => void
    invalidate?: (sessionID?: string) => void
  },
) {
  const abort = new AbortController()
  let selected = ""
  let projection: ReturnType<typeof createLiveProjection> | undefined
  let paintTimer: ReturnType<typeof setTimeout> | undefined
  let snapshotTimer: ReturnType<typeof setTimeout> | undefined
  let metadataRefresh = false
  let started = false

  function current(sessionID: string) {
    if (selected !== sessionID) {
      selected = sessionID
      projection = undefined
      if (paintTimer) clearTimeout(paintTimer)
      paintTimer = undefined
    }
    const session = state.snapshot?.sessions.find((item) => item.id === sessionID)
    if (session?.revert) {
      projection = undefined
      return
    }
    if (!projection && session) projection = createLiveProjection(session)
    return projection
  }

  function snapshot(sessionID?: string, metadata = false) {
    metadataRefresh ||= metadata
    if (snapshotTimer) return
    snapshotTimer = setTimeout(() => {
      snapshotTimer = undefined
      const full = metadataRefresh
      metadataRefresh = false
      if (
        state.closed ||
        abort.signal.aborted ||
        state.tab !== "sessions" ||
        (!full && (state.history || state.modal?.inline))
      )
        return
      if (!full && sessionID !== undefined && sessionID !== state.selected) return
      hooks.snapshot(full)
    }, 100)
  }

  function paint(sessionID: string) {
    if (paintTimer) return
    paintTimer = setTimeout(() => {
      paintTimer = undefined
      if (
        state.closed ||
        abort.signal.aborted ||
        state.selected !== sessionID ||
        selected !== sessionID ||
        state.tab !== "sessions" ||
        state.history ||
        state.modal?.inline ||
        state.detail?.sessionID !== sessionID
      )
        return
      if (projection) hooks.paint(projection.messages())
    }, 50)
  }

  async function run() {
    let retry = 250
    while (!abort.signal.aborted && !state.closed) {
      try {
        for await (const event of connection.events(abort.signal)) {
          if (state.closed || abort.signal.aborted) break
          if (event.type === "server.connected") {
            hooks.invalidate?.()
            selected = ""
            projection = undefined
            state.streamStatus = "live"
            retry = 250
            hooks.status()
            if (snapshotTimer) clearTimeout(snapshotTimer)
            snapshotTimer = undefined
            snapshot(undefined, true)
            continue
          }
          const sessionID = event.data.sessionID
          if (typeof sessionID === "string" && /^session\.next\.revert\.(staged|cleared|committed)$/.test(event.type)) {
            hooks.invalidate?.(sessionID)
            if (selected === sessionID) {
              projection = undefined
              if (paintTimer) clearTimeout(paintTimer)
              paintTimer = undefined
            }
            if (sessionID === state.selected) snapshot(sessionID, true)
            continue
          }
          if (state.tab !== "sessions") {
            selected = ""
            projection = undefined
            continue
          }
          if (typeof sessionID !== "string" || sessionID !== state.selected) continue
          if (state.snapshot?.sessions.find((session) => session.id === sessionID)?.revert) continue
          const changed = current(sessionID)?.apply(event)
          if (changed) {
            if (
              state.snapshot &&
              (event.type === "session.next.step.started" || event.type === "session.next.tool.called")
            )
              state.snapshot.active = { ...state.snapshot.active, [sessionID]: { type: "running" } }
            paint(sessionID)
          }
          if (!changed || /\.(ended|failed|success)$/.test(event.type)) snapshot(sessionID)
        }
      } catch {
        // Snapshot polling remains available when live events are unsupported or interrupted.
      }
      if (state.closed || abort.signal.aborted) break
      const wasLive = state.streamStatus === "live"
      selected = ""
      projection = undefined
      state.streamStatus = "polling"
      hooks.status()
      if (wasLive) snapshot()
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer)
          abort.signal.removeEventListener("abort", finish)
          resolve()
        }
        const timer = setTimeout(finish, retry)
        abort.signal.addEventListener("abort", finish, { once: true })
      })
      retry = Math.min(retry * 2, 5000)
    }
  }

  return {
    invalidate(sessionID: string) {
      if (selected !== sessionID) return
      projection = undefined
      if (paintTimer) clearTimeout(paintTimer)
      paintTimer = undefined
    },
    project(sessionID: string, messages: MessagesListOutput["data"]) {
      return current(sessionID)?.snapshot(messages) ?? messages
    },
    start() {
      if (started) return
      started = true
      void run()
    },
    dispose() {
      abort.abort()
      if (paintTimer) clearTimeout(paintTimer)
      if (snapshotTimer) clearTimeout(snapshotTimer)
      projection = undefined
    },
  }
}
