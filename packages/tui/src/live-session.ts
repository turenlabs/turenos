import type { MessagesListOutput } from "@turenlabs/client"
import type { Connection } from "./server"
import type { DashboardState } from "./state"
import type { LiveSession, LiveSessionHooks } from "./live-session/context"
import { run } from "./live-session/run"
import { current, dropSession } from "./live-session/schedule"

export function createLiveSession(state: DashboardState, connection: Connection, hooks: LiveSessionHooks) {
  const s: LiveSession = {
    state,
    connection,
    hooks,
    abort: new AbortController(),
    selected: "",
    projection: undefined,
    paintTimer: undefined,
    snapshotTimer: undefined,
    metadataRefresh: false,
    started: false,
    retry: 250,
  }
  return {
    invalidate: (sessionID: string) => dropSession(s, sessionID),
    project: (sessionID: string, messages: MessagesListOutput["data"]) =>
      current(s, sessionID)?.snapshot(messages) ?? messages,
    start() {
      if (s.started) return
      s.started = true
      void run(s)
    },
    dispose() {
      s.abort.abort()
      if (s.paintTimer) clearTimeout(s.paintTimer)
      if (s.snapshotTimer) clearTimeout(s.snapshotTimer)
      s.projection = undefined
    },
  }
}
