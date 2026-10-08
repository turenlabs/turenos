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

/** One cached message with its text in both views; `turn` opens a new turn, `continued` is another step of the one before. */
export type LiveMessage = {
  id: string
  message: MessagesListOutput["data"][number]
  formatted: string
  raw: string
  turn: boolean
  continued: boolean
}

export type LivePage = {
  messages: LiveMessage[]
  /** Whether `formatted` was built with whole tool bodies. */
  toolsExpanded: boolean
  cursor?: string
  capped: boolean
  expanded: boolean
  boundary?: string
}

/**
 * The part of a History page on screen. A page whose text exceeds the size budget is read in parts, so
 * every message can be read: `pin` is the edge that stays put (`at` unset: the page's end), and `start`
 * and `end` are the messages painted.
 */
export type HistoryPart = {
  key: string
  pin: { edge: "start" | "end"; at?: number }
  sizes: number[]
  start: number
  end: number
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
  part: HistoryPart | undefined
  textAnchor: TextAnchor | undefined
  /** The last painted live content, and whether it changed while the reader was away from the tail. */
  drawn: string
  unread: boolean
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
    part: undefined,
    textAnchor: undefined,
    drawn: "",
    unread: false,
  }
}
