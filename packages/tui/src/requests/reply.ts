import { TextRenderable } from "@opentui/core"
import { refused, type Session } from "../server"
import { label, type MessageDraft, type ModalState } from "../state"
import { color } from "../theme"
import { matchesKey } from "../keys"
import { outsideNotice } from "../mentions/outside"
import { promptPayload } from "../prompt-files"
import { followText } from "../suggest/editor-height"
import { showAttachments } from "./attachments"
import { openBlockedReply } from "./blocked-reply"
import { maxDrafts, maxMessageLength, newMessageID, replyBlocked, type RequestContext } from "./context"

export function followup(ctx: RequestContext) {
  if (ctx.state.tab !== "sessions" || !ctx.state.selected) return ctx.say("Select a session first.")
  // Asking to reply means typing again: the editor stays open after sending, until Esc.
  ctx.state.navigating = false
  ctx.state.detailFocused = true
  if (ctx.state.modal?.composer) return ctx.state.modal.editor?.focus()
  const sessionID = ctx.state.selected
  const session = ctx.state.snapshot?.sessions.find((session) => session.id === sessionID)
  if (!session) return ctx.say("This session is no longer available. Refresh the list.")
  if (replyBlocked(ctx, sessionID)) return openBlockedReply(ctx, session, () => followup(ctx))
  if (!ctx.messages.has(sessionID) && ctx.messages.size >= maxDrafts)
    return ctx.say("16 message drafts are saved. Send or discard one before starting another.")
  openReply(ctx, session)
}

/**
 * Opens the reply editor unasked while the selected session is in view with the transcript focused, so
 * typing goes into it. Esc leaves it (`navigating`) until Enter, f, or opening a session.
 */
export function offerComposer(ctx: RequestContext) {
  const state = ctx.state
  const id = state.selected
  if (state.closed || !state.connected || state.modal || state.searching || state.tab !== "sessions") return
  if (!id || !state.detailFocused || state.navigating || state.history || replyBlocked(ctx, id)) return
  if (!ctx.messages.has(id) && ctx.messages.size >= maxDrafts) return
  const session = state.snapshot?.sessions.find((item) => item.id === id)
  // Opened unasked, so a notice such as "Reply sent." stays on screen.
  if (session) openReply(ctx, session, true)
}

/** Esc in the reply editor: single-letter shortcuts work again, and on a running turn the next Esc stops it. */
function leaveComposer(ctx: RequestContext, sessionID: string) {
  ctx.state.navigating = true
  if (!Object.hasOwn(ctx.state.snapshot?.active ?? {}, sessionID)) return
  ctx.stopArmed = { sessionID, until: Date.now() + 2000, action: "stop" }
  ctx.say("Press Esc again to stop this turn")
}

function openReply(ctx: RequestContext, session: Session, keepNotice = false) {
  const sessionID = session.id
  const dialog = ctx.dialogs.open("Reply", false, 24, true, false, keepNotice)
  if (!dialog) return
  dialog.composer = true
  dialog.back = () => leaveComposer(ctx, sessionID)
  dialog.recipient = session
  const draft: MessageDraft = ctx.messages.get(sessionID) ?? {
    text: "",
    id: newMessageID(),
    recipient: session,
    delivery: ctx.deliveries.get(sessionID) ?? "steer",
  }
  draft.recipient = session
  if (draft.submitted !== undefined) draft.text = draft.submitted
  ctx.messages.set(sessionID, draft)
  const delivery = wireDelivery(ctx, dialog, session, draft)
  const task = createReplyEditor(ctx, dialog, draft)
  showAttachments(ctx, dialog, task, session.location.directory)
  dialog.save = () => {
    draft.text = draft.submitted ?? task.plainText
    draft.cursor = task.cursorOffset
    // An empty editor leaves no draft, so there is nothing to resume.
    if (draft.text || draft.submitted !== undefined) return ctx.say("Message draft kept · Enter or f to resume")
    ctx.messages.delete(sessionID)
  }
  dialog.discard = () => {
    ctx.messages.delete(sessionID)
  }
  const attached: { acknowledged?: string } = {}
  dialog.submit = () => submitReply(ctx, session, draft, task, attached)
  delivery()
  ctx.slash.attach(
    dialog,
    task,
    () => session.location,
    () => draft.submitted !== undefined,
  )
  ctx.mentions.attach(
    dialog,
    task,
    () => session.location,
    () => draft.submitted !== undefined,
  )
  ctx.dialogs.resize()
  task.focus()
}

/** Adds the delivery heading and the Ctrl+T mode switch; the returned function repaints both. */
function wireDelivery(ctx: RequestContext, dialog: ModalState, session: Session, draft: MessageDraft) {
  const heading = new TextRenderable(ctx.renderer, {
    content: "",
    fg: color.muted,
    height: 1,
    truncate: true,
    wrapMode: "none",
  })
  dialog.form.add(heading)
  const shown: { content?: typeof dialog.error.content } = {}
  const delivery = () => {
    const live = running(ctx, session.id)
    // The server may retitle the session while the editor is open.
    const title = ctx.state.snapshot?.sessions.find((item) => item.id === session.id)?.title ?? session.title
    const mode = !live ? "Send" : draft.delivery === "queue" ? "Queue" : "Steer"
    const waiting = waitingRequest(ctx, session.id)
    heading.content = waiting
      ? `${mode} · ${waiting} · Esc then Enter to answer`
      : `${mode} · Reply to ${label(title, 100)}${session.revert ? " · undo staged" : ""}`
    heading.fg = waiting || session.revert ? color.warning : color.muted
    const listed = (dialog.suggestionRows ?? 0) + (dialog.mentionRows ?? 0) > 0
    const hint = listed
      ? `Up/Down choose · Tab complete\nEnter pick · Esc close list · F4 discard`
      : session.revert
        ? `Enter Send + commit undo · Alt+Enter newline\nEsc shortcuts · F4 discard${live ? " · Ctrl+T mode" : ""}`
        : `Enter Send · Shift/Alt+Enter newline\nEsc shortcuts · F4 discard${live ? " · Ctrl+T mode" : ""}`
    // A refresh may repaint the hint, but never over a message that replaced it.
    if (!shown.content || dialog.error.content === shown.content) dialog.error.content = hint
    shown.content = dialog.error.content
  }
  // The mode only means something while the agent runs, so the dashboard refresh repaints it.
  dialog.refresh = delivery
  dialog.key = (key) => {
    if (!matchesKey(key, "t", { ctrl: true })) return false
    if (!running(ctx, session.id)) return true
    if (draft.submitted !== undefined) {
      dialog.error.content = "Retry keeps the original delivery mode. F4 discards the local draft."
      return true
    }
    draft.delivery = draft.delivery === "steer" ? "queue" : "steer"
    ctx.deliveries.set(session.id, draft.delivery)
    delivery()
    return true
  }
  return delivery
}

/** A permission or question the open reply would otherwise hide: the editor stays, so it says what waits. */
function waitingRequest(ctx: RequestContext, sessionID: string) {
  const detail = ctx.state.detail?.sessionID === sessionID ? ctx.state.detail : undefined
  if (detail?.permissions.length) return "Permission waiting"
  if (detail?.questions.length) return "Question waiting"
  return ""
}

/** The reply editor, one row for a short message and growing with the text. */
function createReplyEditor(ctx: RequestContext, dialog: ModalState, draft: MessageDraft) {
  const task = ctx.dialogs.prompt(dialog, "Your message", draft.text, draft.cursor, true)
  dialog.editor = task
  dialog.editorLocked = () => draft.submitted !== undefined
  task.marginBottom = 0
  followText(task, 1, 6, ctx.dialogs.resize)
  return task
}

export type ReplyEditor = ReturnType<typeof createReplyEditor>

async function submitReply(
  ctx: RequestContext,
  session: Session,
  draft: MessageDraft,
  task: ReplyEditor,
  attached: { acknowledged?: string },
) {
  const sessionID = session.id
  if (!ctx.state.connected) throw new Error("Reconnect before sending. Your draft is kept.")
  if (replyBlocked(ctx, sessionID))
    throw new Error("This is a task-owned subagent. Draft kept. Press Esc, then f to open its owning session.")
  if (!task.plainText.trim() || task.plainText.length > maxMessageLength)
    throw new Error("Enter a message between 1 and 32,000 characters.")
  if (draft.submitted !== undefined && draft.submitted !== task.plainText)
    throw new Error("Retry the original message. Escape keeps its request ID; F4 discards the local draft.")
  const current = await ctx.connection.client.sessions.get({ sessionID })
  if (draft.submitted === undefined && current.revert?.messageID !== session.revert?.messageID)
    throw new Error("The undo position changed. Your draft is kept; close and reopen Reply before sending.")
  if (draft.submitted === undefined) await classify(ctx, draft, task.plainText, current)
  // Steer and Queue are the same for an idle session, and Ctrl+T is inert then, so a remembered Queue must not block commands.
  const delivery = draft.submitted === undefined && !running(ctx, sessionID) ? "steer" : draft.delivery
  if ((draft.command || draft.shell) && delivery === "queue")
    throw new Error(
      `${draft.shell ? "Shell commands" : "Slash commands"} do not support Queue. Press Ctrl+T to choose Steer before sending.`,
    )
  // Every local check runs before the draft locks: a message that was never sent stays editable.
  const directory = current.location.directory
  const request = prepare(ctx, draft, task.plainText, sessionID, directory)
  if (draft.submitted === undefined && !draft.shell && !draft.command) {
    const notice = outsideNotice(task.plainText, directory, attached.acknowledged)
    attached.acknowledged = notice.key
    if (notice.message) throw new Error(notice.message)
  }
  draft.text = task.plainText
  draft.delivery = delivery
  draft.submitted = draft.text
  ctx.state.sentMessages.add(draft.id)
  try {
    await request()
  } catch (error) {
    // A definite 4xx admitted nothing, so the text is editable again; the ID stays for the next send.
    if (refused(error)) draft.submitted = undefined
    throw ownedError(ctx, sessionID, error)
  }
  ctx.messages.delete(sessionID)
  ctx.say(draft.shell ? "Shell command sent to the server." : sentStatus(ctx, sessionID, draft))
}

/** Queue and Steer only differ while the agent runs, so the status says which one happened then. */
function sentStatus(ctx: RequestContext, sessionID: string, draft: MessageDraft) {
  if (draft.command || !running(ctx, sessionID)) return "Reply sent."
  return draft.delivery === "queue"
    ? "Reply queued. The agent reads it when it is idle."
    : "Reply sent. The agent reads it at its next step."
}

/** Decides, once per draft, whether the text is a shell command, a slash command or a prompt. */
async function classify(ctx: RequestContext, draft: MessageDraft, text: string, current: Session) {
  const shell = /^!(.+)/s.exec(text)?.[1]?.trim()
  // A shell command is not a prompt, so it cannot carry the staged revert
  // that this editor promises to commit on send.
  if (shell && current.revert)
    throw new Error("Commit or clear the staged undo before running a shell command. Your draft is kept.")
  draft.shell = shell
  draft.command = shell
    ? undefined
    : await ctx.connection.resolveCommand(text, current.location.directory, current.location.workspaceID)
}

/** Builds the exact request from validated input, so nothing that can throw locally runs after the lock. */
function prepare(ctx: RequestContext, draft: MessageDraft, text: string, sessionID: string, directory: string) {
  if (draft.shell) {
    const command = draft.shell
    ctx.connection.checkShell(sessionID, draft.id, command)
    return () => ctx.connection.shell(sessionID, draft.id, command)
  }
  if (draft.command) {
    const command = draft.command
    return () => ctx.connection.client.sessions.command({ sessionID, id: draft.id, ...command, resume: true })
  }
  const prompt = promptPayload(text, directory)
  return () => ctx.connection.client.sessions.prompt({ sessionID, id: draft.id, prompt, delivery: draft.delivery })
}

function ownedError(ctx: RequestContext, sessionID: string, error: unknown) {
  if (!error || typeof error !== "object" || !("kind" in error) || error.kind !== "session_task_owned") return error
  ctx.owned.add(sessionID)
  return new Error("This is a task-owned subagent. Draft kept. Press Esc, then f to open its owning session.")
}

function running(ctx: RequestContext, sessionID: string) {
  return Object.hasOwn(ctx.state.snapshot?.active ?? {}, sessionID)
}
