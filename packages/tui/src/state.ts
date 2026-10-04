import type {
  BoxRenderable,
  InputRenderable,
  ScrollBoxRenderable,
  SelectRenderable,
  TextareaRenderable,
  TextRenderable,
} from "@opentui/core"
import type { KeyEvent } from "@opentui/core"
import { display } from "./messages"
import type { Connection, Detail, Session, Snapshot } from "./server"

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
  worktree?: { name: string; attempted: boolean; directory?: string }
  start: ReturnType<Connection["launch"]>
}
export type MessageDraft = {
  text: string
  id: string
  recipient: Session
  delivery: "steer" | "queue"
  submitted?: string
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
  history: boolean
  historyCursor: string | undefined
  connectionError: string
  sidebarHidden: boolean | undefined
  previousSession: string
  searching: { query: string; selected: string } | undefined
  modal: ModalState | undefined
  reducedMotion: boolean
  rawResponses: boolean
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
    history: false,
    historyCursor: undefined,
    connectionError: "",
    sidebarHidden: undefined,
    previousSession: "",
    searching: undefined,
    modal: undefined,
    reducedMotion: process.env.TURENOS_REDUCED_MOTION === "1",
    rawResponses: false,
    serverSwitching: false,
    retries: {},
    sentMessages: new Set(),
  }
}

export function label(value: string, limit = 150) {
  return display(value, limit).replace(/\s/g, " ")
}
