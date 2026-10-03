import type { MessagesListOutput } from "@turenlabs/client"
import type { createLiveProjection } from "../live-projection"
import type { Connection } from "../server"
import type { DashboardState } from "../state"

export type LiveSessionHooks = {
  paint: (messages: MessagesListOutput["data"]) => void
  snapshot: (metadata?: boolean) => void
  status: () => void
  invalidate?: (sessionID?: string) => void
}

/** What the live-event consumer mutates; its functions take this explicitly. */
export type LiveSession = {
  state: DashboardState
  connection: Connection
  hooks: LiveSessionHooks
  abort: AbortController
  selected: string
  projection: ReturnType<typeof createLiveProjection> | undefined
  paintTimer: ReturnType<typeof setTimeout> | undefined
  snapshotTimer: ReturnType<typeof setTimeout> | undefined
  metadataRefresh: boolean
  started: boolean
  retry: number
}
