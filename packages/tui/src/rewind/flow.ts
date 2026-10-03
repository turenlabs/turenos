import type { CliRenderer, InputRenderable, SelectRenderable, TextRenderable } from "@opentui/core"
import type { Dialogs } from "../dialogs"
import type { changeSummary } from "../diff"
import type { Connection, Session } from "../server"
import type { DashboardState, ModalState } from "../state"
import { boundary, sameSession } from "./session"

export type RewindAction = "undo" | "redo"

export type RewindHooks = {
  blocked: (id: string) => boolean
  changed: (session: Session) => void
  restoreDraft: (session: Session, messageID: string, text: string) => boolean
  clearRestoredDraft: (sessionID: string, messageID: string, text: string) => void
}

export type RewindEnv = {
  renderer: CliRenderer
  state: DashboardState
  connection: Connection
  dialogs: Dialogs
  say: (message: string, error?: boolean) => void
  hooks: RewindHooks
}

export type Prompt = { id: string; text: string }

/** One open rewind confirmation: the captured session plus the state its inspect and submit steps share. */
export type RewindFlow = RewindEnv & {
  action: RewindAction
  dialog: ModalState
  session: Session
  initialBoundary: string
  summary: ReturnType<typeof changeSummary>
  preview: TextRenderable
  changes: TextRenderable
  expanded: boolean
  target?: Prompt
  previous?: Prompt
  ready: boolean
  loading: boolean
  attempted: boolean
  intent?: { messageID?: string; files: boolean }
  acknowledged: Session["revert"]
  hasAcknowledgement: boolean
  files?: SelectRenderable
  confirmation?: InputRenderable
}

export function owned(flow: RewindFlow) {
  if (flow.state.closed || flow.state.modal !== flow.dialog) throw new Error("Confirmation is no longer open.")
  if (!flow.state.connected) throw new Error("Reconnect before changing this session.")
  if (flow.hooks.blocked(flow.session.id))
    throw new Error("Task-owned subagent: use its owning session. Nothing changed.")
}

export async function fresh(flow: RewindFlow, unchanged: boolean) {
  owned(flow)
  const current = await flow.connection.client.sessions.get({ sessionID: flow.session.id })
  owned(flow)
  if (!sameSession(flow.session, current)) throw new Error("Session identity changed. Close and reopen this control.")
  if (unchanged && boundary(current.revert) !== flow.initialBoundary)
    throw new Error("Staged boundary changed. Close and reopen this control.")
  return current
}
