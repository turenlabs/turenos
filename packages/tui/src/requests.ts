import type { CliRenderer } from "@opentui/core"
import type { Connection, Session } from "./server"
import type { DashboardState, MessageDraft } from "./state"
import type { Dialogs } from "./dialogs"
import type { SlashCommands } from "./slash"
import type { Mentions } from "./mentions"
import { replyBlocked, type QuestionDraft, type RequestContext } from "./requests/context"
import { clearRestoredDraft, mention, restoreBlocker, restoreDraft } from "./requests/drafts"
import { permission } from "./requests/permission"
import { question } from "./requests/question"
import { followup } from "./requests/reply"
import { interrupt, kill, stopAll } from "./requests/stop"

export function createRequests(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string) => void,
  openSession: (id: string, inspect?: boolean, session?: Session) => void,
  slash: SlashCommands,
  mentions: Mentions,
) {
  const ctx: RequestContext = {
    renderer,
    state,
    connection,
    dialogs,
    say,
    openSession,
    slash,
    mentions,
    messages: new Map<string, MessageDraft>(),
    owned: new Set<string>(),
    shownQuestions: new Set<string>(),
    questionDrafts: new Map<string, QuestionDraft>(),
  }
  return {
    restoreBlocker: (sessionID: string, text: string) => restoreBlocker(ctx, sessionID, text),
    restoreDraft: (session: Session, messageID: string, text: string) => restoreDraft(ctx, session, messageID, text),
    clearRestoredDraft: (sessionID: string, messageID: string, text: string) =>
      clearRestoredDraft(ctx, sessionID, messageID, text),
    replyBlocked: (sessionID: string) => replyBlocked(ctx, sessionID),
    offerQuestion: () => offerQuestion(ctx),
    followup: () => followup(ctx),
    permission: () => permission(ctx),
    question: (reject = false) => question(ctx, reject),
    interrupt: () => interrupt(ctx),
    kill: () => kill(ctx),
    stopAll: () => stopAll(ctx),
    hasDraft: (id: string) => ctx.messages.has(id),
    mention: (session: Session, text: string) => mention(ctx, session, text),
    /** Drops a saved draft whose session no longer exists. */
    forget: (id: string) => ctx.messages.delete(id),
    savedSessions: () => [...ctx.messages.values()].map((draft) => draft.recipient),
    updateRecipient: (session: Session) => {
      const draft = ctx.messages.get(session.id)
      if (draft) draft.recipient = session
    },
  }
}

function offerQuestion(ctx: RequestContext) {
  const state = ctx.state
  const detail = state.detail
  const request = detail?.questions[0]
  if (
    state.closed ||
    !state.connected ||
    state.modal ||
    state.searching ||
    state.tab !== "sessions" ||
    !detail ||
    detail.sessionID !== state.selected ||
    detail.permissions.length ||
    !request ||
    request.sessionID !== state.selected ||
    ctx.shownQuestions.has(`${request.sessionID}:${request.id}`)
  )
    return
  question(ctx)
}
