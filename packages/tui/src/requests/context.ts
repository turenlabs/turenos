import { TextRenderable, type CliRenderer } from "@opentui/core"
import type { Connection, Session } from "../server"
import { label, sessionTitle, type DashboardState, type MessageDraft, type ModalState } from "../state"
import { color } from "../theme"
import type { Dialogs } from "../dialogs"
import type { SlashCommands } from "../slash"
import type { Mentions } from "../mentions"

export type QuestionDraft = {
  signature: string
  selections: Set<number>[]
  custom: string[]
  customOn: boolean[]
  cursors: number[]
  page: number
  review: boolean
  reject: boolean
  editing: boolean
  cursor: number
}

/** Everything the request flows share: the dashboard wiring plus the per-session draft stores. */
export type RequestContext = {
  renderer: CliRenderer
  state: DashboardState
  connection: Connection
  dialogs: Dialogs
  say: (message: string) => void
  openSession: (id: string, inspect?: boolean, session?: Session) => void
  slash: SlashCommands
  mentions: Mentions
  messages: Map<string, MessageDraft>
  owned: Set<string>
  shownQuestions: Set<string>
  shownPermissions: Set<string>
  /** Recorded by the first Esc; a second Esc before `until` interrupts a running session or opens undo for an idle one. */
  stopArmed?: { sessionID: string; until: number; action: "stop" | "rewind" }
  /** The last Steer/Queue choice per session, kept while the process lives. */
  deliveries: Map<string, MessageDraft["delivery"]>
  questionDrafts: Map<string, QuestionDraft>
}

export const maxDrafts = 16
export const maxMessageLength = 32000

export function newMessageID() {
  return `msg_${crypto.randomUUID().replaceAll("-", "")}`
}

export function owner(ctx: RequestContext, sessionID: string) {
  const detail = ctx.state.detail?.sessionID === sessionID ? ctx.state.detail : undefined
  return [...(detail?.tasks.data ?? []), ...(detail?.tasks.active ?? [])].find(
    (task) => task.childSessionID === sessionID,
  )
}

export function replyBlocked(ctx: RequestContext, sessionID: string) {
  return ctx.owned.has(sessionID) || !!owner(ctx, sessionID)
}

export function recipient(ctx: RequestContext, dialog: ModalState, sessionID: string) {
  const session = ctx.state.snapshot?.sessions.find((item) => item.id === sessionID)
  dialog.recipient = session
  dialog.form.add(
    new TextRenderable(ctx.renderer, {
      content: [sessionTitle(session?.title ?? sessionID), label(session?.location.directory ?? ""), label(sessionID)].join(
        "\n",
      ),
      fg: color.muted,
      wrapMode: "word",
    }),
  )
}
