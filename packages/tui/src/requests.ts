import type { CliRenderer } from "@opentui/core"
import type { Connection, Session } from "./server"
import type { DashboardState, MessageDraft } from "./state"
import type { Dialogs } from "./dialogs"
import type { SlashCommands } from "./slash"
import type { Mentions } from "./mentions"
import { owner, replyBlocked, type QuestionDraft, type RequestContext } from "./requests/context"
import { clearRestoredDraft, mention, restoreBlocker, restoreDraft } from "./requests/drafts"
import { permission } from "./requests/permission"
import { question } from "./requests/question"
import { sweepDrafts } from "./requests/question/draft"
import { followup, offerComposer } from "./requests/reply"
import { escapeStop, interrupt, kill, stopAll, stopRunning } from "./requests/stop"

export function createRequests(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string) => void,
  openSession: (id: string, inspect?: boolean, session?: Session) => void,
  slash: SlashCommands,
  mentions: Mentions,
  attend: () => void = () => {},
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
    shownPermissions: new Set<string>(),
    deliveries: new Map<string, MessageDraft["delivery"]>(),
    questionDrafts: new Map<string, QuestionDraft>(),
  }
  return {
    restoreBlocker: (sessionID: string, text: string) => restoreBlocker(ctx, sessionID, text),
    restoreDraft: (session: Session, messageID: string, text: string) => restoreDraft(ctx, session, messageID, text),
    clearRestoredDraft: (sessionID: string, messageID: string, text: string) =>
      clearRestoredDraft(ctx, sessionID, messageID, text),
    replyBlocked: (sessionID: string) => replyBlocked(ctx, sessionID),
    offerInput: () => offerInput(ctx, attend),
    followup: () => followup(ctx),
    permission: () => permission(ctx),
    question: (reject = false) => question(ctx, reject),
    interrupt: () => interrupt(ctx),
    stopRunning: (next = "") => stopRunning(ctx, next),
    escapeStop: (rewind: () => void) => escapeStop(ctx, rewind),
    kill: () => kill(ctx),
    stopAll: () => stopAll(ctx),
    hasDraft: (id: string) => ctx.messages.has(id),
    mention: (session: Session, text: string) => mention(ctx, session, text),
    /** Drops a saved draft whose session no longer exists. */
    forget: (id: string) => ctx.messages.delete(id),
    savedSessions: () => [...ctx.messages.values()].map((draft) => draft.recipient),
    unsentDrafts: () => unsentDrafts(ctx),
    updateRecipient: (session: Session) => {
      const draft = ctx.messages.get(session.id)
      if (draft) draft.recipient = session
    },
  }
}

/**
 * Opens what the selected session needs: its oldest pending permission, else its question, once per
 * request; otherwise the reply editor. A request takes the editor's place only while it is empty.
 */
function offerInput(ctx: RequestContext, attend: () => void) {
  // The task list can show ownership after the editor opened; a task-owned child takes no direct reply,
  // so the editor is set aside with its draft kept, and `f` then offers the owning session. A send the
  // server refused as task-owned keeps the editor, which shows that refusal.
  const open = ctx.state.modal?.composer && !ctx.state.modal.busy ? ctx.state.modal.recipient : undefined
  if (open && owner(ctx, open.id)) return ctx.dialogs.close()
  const request = unshownRequest(ctx)
  if (request && (!ctx.state.modal || yieldComposer(ctx))) {
    // Opening the prompt records it as shown, so the bell rings once per request.
    if (request === "permission") permission(ctx, true)
    else question(ctx)
    return attend()
  }
  offerComposer(ctx)
}

function unshownRequest(ctx: RequestContext) {
  const state = ctx.state
  const detail = state.detail
  // A request resolved elsewhere takes its draft with it, open dialog or not.
  sweepDrafts(state, ctx.questionDrafts)
  if (
    state.closed ||
    !state.connected ||
    state.searching ||
    state.tab !== "sessions" ||
    !detail ||
    detail.sessionID !== state.selected
  )
    return undefined
  const ask = detail.permissions[0]
  if (ask) return ctx.shownPermissions.has(`${ask.sessionID}:${ask.id}`) ? undefined : "permission"
  const request = detail.questions[0]
  if (!request || request.sessionID !== state.selected || ctx.shownQuestions.has(`${request.sessionID}:${request.id}`))
    return undefined
  return "question"
}

/** Closes the reply editor for a request when nothing is typed in it; text being written keeps it open. */
function yieldComposer(ctx: RequestContext) {
  const modal = ctx.state.modal
  if (!modal?.composer || modal.busy || modal.editor?.plainText.trim() || modal.editorLocked?.()) return false
  ctx.dialogs.close()
  return !ctx.state.modal
}

/** Replies that would be lost on quit: saved text, a send awaiting retry, or text in the open editor. */
function unsentDrafts(ctx: RequestContext) {
  const open = ctx.state.modal?.composer ? ctx.state.modal : undefined
  return [...ctx.messages.values()].filter(
    (draft) =>
      draft.submitted !== undefined ||
      !!(open?.recipient?.id === draft.recipient.id ? open.editor?.plainText : draft.text)?.trim(),
  ).length
}
