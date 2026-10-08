import type {
  BoxRenderable,
  InputRenderable,
  ScrollBoxRenderable,
  SelectRenderable,
  TextareaRenderable,
  TextRenderable,
} from "@opentui/core"
import type { KeyEvent } from "@opentui/core"
import { SessionTitle } from "@turenlabs/client/session-title"
import { display } from "./messages"
import { stamp } from "./menus/stamp"
import type { Connection, Detail, Session, Snapshot } from "./server"
import type { promptPayload } from "./prompt-files"

export type Tab = "sessions" | "terminals" | "automations"
export type Field = InputRenderable | TextareaRenderable | SelectRenderable
export type Row = { id: string; name: string; description: string }
export type LaunchDraft = {
  directory: string
  agent?: string
  model: string
  variant?: string
  prompt: string
  cursor?: number
  /** Wants a new git worktree: `worktree` keeps its name across retries and its folder once ready. */
  isolate?: boolean
  worktree?: { name: string; attempted: boolean; directory?: string; agent?: string }
  start: ReturnType<Connection["launch"]>
}
export type MessageDraft = {
  text: string
  id: string
  recipient: Session
  delivery: "steer" | "queue"
  submitted?: string
  prompt?: ReturnType<typeof promptPayload>
  command?: { command: string; arguments: string }
  shell?: string
  restoredFrom?: string
  cursor?: number
}

export type ModalState = {
  box: BoxRenderable
  frame: BoxRenderable
  form: ScrollBoxRenderable
  fields: Field[]
  index: number
  submit?: () => Promise<void>
  beforeSubmit?: () => boolean
  afterSubmit?: () => void
  busy: boolean
  inline: boolean
  docked: boolean
  height: number
  recipient?: Session
  /** The reply editor docked under the transcript, which stays open while the session is in view. */
  composer?: boolean
  editor?: TextareaRenderable
  suggestionRows?: number
  mentionRows?: number
  editorLocked?: () => boolean
  send?: TextRenderable
  error: TextRenderable
  reference?: string
  settings?: () => void
  chooseModel?: () => void
  chooseAgent?: () => void
  chooseVariant?: () => void
  allowNavigation?: boolean
  onNavigate?: () => void
  questionKey?: string
  sidebar?: boolean
  refresh?: () => void
  back?: () => void
  save?: () => void
  discard?: () => void
  key?: (key: KeyEvent) => boolean
}

export type DashboardState = {
  tab: Tab
  snapshot: Snapshot | undefined
  detail: Detail | undefined
  selected: string
  workingDirectory?: string
  query: string
  inspection: string
  inspected: Session | undefined
  rows: Row[]
  closed: boolean
  connected: boolean
  streamStatus: "connecting" | "live" | "polling"
  detailVersion: number
  detailFocused: boolean
  /** Esc left the reply editor: single-letter shortcuts work until Enter, f or opening a session types again. */
  navigating: boolean
  history: boolean
  historyCursor: string | undefined
  connectionError: string
  sidebarHidden: boolean | undefined
  previousSession: string
  searching: { query: string; selected: string } | undefined
  modal: ModalState | undefined
  reducedMotion: boolean
  /** Bell and terminal title when a session needs the user; Settings › Appearance, off with TURENOS_NO_ATTENTION=1. */
  attention: boolean
  /** The title last written to the terminal, so only changes are written; empty when none is set. */
  terminalTitle: string
  /** The selected session while its turn runs, so the end of that turn rings once. */
  workingSession: string
  rawResponses: boolean
  /** Show whole tool results; by default long ones show their first lines (Ctrl+O). */
  expandToolOutput: boolean
  /** The app can switch servers (s); a bare dashboard cannot. */
  serverSwitching: boolean
  /** Provider retries the server announced per session, until the turn makes progress again. */
  retries: { [sessionID: string]: Retry }
  /** IDs of the messages this client sent, so the transcript follows only its own sends. */
  sentMessages: Set<string>
}

export type Retry = { attempt: number; at: number; message: string }

export function createDashboardState(): DashboardState {
  return {
    tab: "sessions",
    snapshot: undefined,
    detail: undefined,
    selected: "",
    query: "",
    inspection: "",
    inspected: undefined,
    rows: [],
    closed: false,
    connected: false,
    streamStatus: "connecting",
    detailVersion: 0,
    detailFocused: false,
    navigating: false,
    history: false,
    historyCursor: undefined,
    connectionError: "",
    sidebarHidden: undefined,
    previousSession: "",
    searching: undefined,
    modal: undefined,
    reducedMotion: process.env.TURENOS_REDUCED_MOTION === "1",
    attention: process.env.TURENOS_NO_ATTENTION !== "1",
    terminalTitle: "",
    workingSession: "",
    rawResponses: false,
    expandToolOutput: false,
    serverSwitching: false,
    retries: {},
    sentMessages: new Set(),
  }
}

/** One line of untrusted text, at most `limit` characters; a cut ends in "…" so it reads as one label. */
export function label(value: string, limit = 150) {
  // Control characters are removed before measuring; text past the bounded window is cut either way.
  const window = value.slice(0, limit * 4 + 256)
  const text = display(window, window.length).replace(/\s/g, " ")
  if (text.length <= limit && window.length === value.length) return text
  return `${text.slice(0, Math.max(0, limit - 1))}…`
}

/**
 * A session title as people read it. The server names an untitled session `New session - <ISO time>` (a child
 * session `Child session - <ISO time>`) and keeps that name when its first turn fails, so the timestamp is shown
 * as a local `YYYY-MM-DD HH:MM`, like every other date.
 */
export function sessionTitle(title: string, limit = 150) {
  const placeholder = SessionTitle.parsePlaceholder(title)
  if (!placeholder || Number.isNaN(placeholder.at)) return label(title, limit)
  return label(`${placeholder.kind === "child" ? "Child" : "New"} session · ${stamp(placeholder.at)}`, limit)
}
