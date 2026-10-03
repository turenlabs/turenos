import type { MessagesListOutput } from "@turenlabs/client"
import type { TextBufferRenderable } from "@opentui/core"
import type { DashboardLayout } from "../layout"
import type { Connection } from "../server"
import type { DashboardState } from "../state"

export type ConversationHooks = {
  actions: () => void
  say: (message: string, error?: boolean) => void
  clearNotice: (message: string) => void
  project?: (sessionID: string, messages: MessagesListOutput["data"]) => MessagesListOutput["data"]
  questionsInPanel?: boolean
}

export type SavedPosition = { history: boolean; latest: number; transcript: number; cursor?: string }

/** Where the conversation is scrolled: `MAX_SAFE_INTEGER` follows the tail. */
export type ReadingPosition = { sessionID: string; history: boolean; scroll: number }

export type LivePage = {
  messages: { id: string; formatted: string; raw: string }[]
  cursor?: string
  capped: boolean
  expanded: boolean
  boundary?: string
}

/** A logical text location from the last painted frame, kept across reflow. */
export type TextAnchor = {
  node: TextBufferRenderable
  width: number
  source: number
  column: number
  row: number
}

/** Everything the conversation view mutates; its functions take this explicitly. */
export type Conversation = {
  state: DashboardState
  connection: Connection
  ui: DashboardLayout
  hooks: ConversationHooks
  error: string
  lastPending: string
  loading: Promise<void> | undefined
  /** A refresh was requested while one was in flight; it runs once the current one ends. */
  refreshPending: boolean
  /** What the in-flight or last load was for; a different view discards loads for the old one. */
  loadKey: string
  disposed: boolean
  pageRequest: { sessionID: string; cursor: string; direction: "next" | "previous" } | undefined
  positions: Map<string, SavedPosition>
  position: ReadingPosition | undefined
  beforeQuestion: ReadingPosition | undefined
  live: Map<string, LivePage>
  earlier: Promise<void> | undefined
  generation: number
  viewKey: string
  prepend: { height: number; scroll: number } | undefined
  textAnchor: TextAnchor | undefined
}

export function newConversation(
  state: DashboardState,
  connection: Connection,
  ui: DashboardLayout,
  hooks: ConversationHooks,
): Conversation {
  return {
    state,
    connection,
    ui,
    hooks,
    error: "",
    lastPending: "",
    loading: undefined,
    refreshPending: false,
    loadKey: "",
    disposed: false,
    pageRequest: undefined,
    positions: new Map(),
    position: undefined,
    beforeQuestion: undefined,
    live: new Map(),
    earlier: undefined,
    generation: 0,
    viewKey: "",
    prepend: undefined,
    textAnchor: undefined,
  }
}
