import { BoxRenderable, TextRenderable } from "@opentui/core"
import { refused, type Session } from "../server"
import { sessionTitle, type MessageDraft, type ModalState } from "../state"
import { color } from "../theme"
import { matchesKey } from "../keys"
import { outsideNotice } from "../mentions/outside"
import { promptPayload } from "../prompt-files"
import { dockedEditor } from "../dialogs/docked-editor"
import { armStop, stopPrompt } from "./stop"
import { replyHeading, replyHint, replyPlaceholder, type ReplyFacts } from "./reply-hint"
import { showAttachments } from "./attachments"
import { openBlockedReply } from "./blocked-reply"
import { permission } from "./permission"
import { question } from "./question"
import {
  maxDrafts,
  maxMessageLength,
  newMessageID,
  replyBlocked,
  sentNotice,
  waitingRequest,
  type RequestContext,
} from "./context"

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
  armStop(ctx, sessionID, "stop", stopPrompt(ctx, sessionID))
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
  showAttachments(ctx, dialog, task, draft)
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
  dialog.beforeSubmit = () => reviewRequest(ctx, session.id, task, draft)
  // Whether Enter reviews the waiting request or sends text changes with the first and last character.
  const typed = task.onContentChange
  let empty = !task.plainText.trim()
  task.onContentChange = (event) => {
    typed?.(event)
    if (empty === !task.plainText.trim()) return
    empty = !empty
    dialog.refresh?.()
  }
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

/** The hint and the context meter share one row: the hint gives way, the meter keeps its width. Returns the meter. */
function shareHintRow(ctx: RequestContext, dialog: ModalState) {
  const tail = new TextRenderable(ctx.renderer, { content: "", fg: color.muted, height: 1, flexShrink: 0 })
  const row = new BoxRenderable(ctx.renderer, { flexDirection: "row", flexShrink: 0, gap: 2 })
  dialog.frame.remove(dialog.error)
  dialog.error.flexGrow = 1
  dialog.error.minWidth = 0
  row.add(dialog.error)
  row.add(tail)
  dialog.frame.add(row)
  return tail
}

function replyFacts(ctx: RequestContext, dialog: ModalState, session: Session, draft: MessageDraft): ReplyFacts {
  // The server may retitle the session while the editor is open.
  const title = ctx.state.snapshot?.sessions.find((item) => item.id === session.id)?.title ?? session.title
  const waiting = waitingRequest(ctx, session.id)
  return {
    live: running(ctx, session.id),
    queue: draft.delivery === "queue",
    waiting,
    // An empty editor's Enter opens the request; with text typed, Enter sends it, so the heading points at Esc.
    review: !!waiting && !dialog.editor?.plainText.trim() && draft.submitted === undefined,
    revert: !!session.revert,
    queued: dialog.queued ?? 0,
    elsewhere: ctx.state.selected === session.id ? undefined : sessionTitle(title, 60),
    draft: !!dialog.editor?.plainText.trim(),
    listed: (dialog.suggestionRows ?? 0) + (dialog.mentionRows ?? 0) > 0,
  }
}

/** Adds the heading (only when it has news), the hint row with its right-hand meter, and the Ctrl+T mode switch; the returned function repaints them. */
function wireDelivery(ctx: RequestContext, dialog: ModalState, session: Session, draft: MessageDraft) {
  const heading = new TextRenderable(ctx.renderer, {
    content: "",
    fg: color.muted,
    height: 1,
    visible: false,
    truncate: true,
    wrapMode: "none",
  })
  dialog.form.add(heading)
  dialog.headingRows = 0
  const tail = shareHintRow(ctx, dialog)
  const shown: { content?: typeof dialog.error.content; meter?: string } = {}
  const delivery = () => {
    const facts = replyFacts(ctx, dialog, session, draft)
    const waiting = facts.waiting
    const room = (dialog.frame.width || ctx.renderer.width - 4) - 5
    const text = replyHeading(facts, room)
    heading.content = text
    heading.visible = text.length > 0
    heading.fg = waiting || session.revert ? color.warning : color.muted
    tail.content = facts.listed ? "" : (dialog.meter ?? "")
    // Reassigning an unchanged placeholder re-wraps it at the editor's old width and inflates the editor.
    const placeholder = replyPlaceholder(ctx.renderer.width)
    if (dialog.editor && dialog.editor.placeholder !== placeholder) dialog.editor.placeholder = placeholder
    const flashed = ctx.flash && Date.now() < ctx.flash.until ? ctx.flash.text : ""
    const hint = flashed || replyHint(facts, room - tail.plainText.length - 2)
    const rows = text ? 1 : 0
    // A refresh may repaint the hint, but never over a message that replaced it.
    const free = !shown.content || dialog.error.content === shown.content
    if (free && (hint !== dialog.error.plainText || rows !== dialog.headingRows || tail.plainText !== shown.meter)) {
      dialog.error.content = hint
      dialog.headingRows = rows
      // A one-line hint gives its second row back to the transcript.
      dialog.error.height = hint.split("\n").length
      ctx.dialogs.resize()
    }
    shown.meter = tail.plainText
    if (free) shown.content = dialog.error.content
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
    ctx.say(draft.delivery === "queue" ? "Queue: sent when the agent is idle" : "Steer: read at the next step")
    return true
  }
  return delivery
}

/**
 * Enter in an empty editor goes to what the session waits on instead of failing to send nothing; a Ctrl+S that
 * follows a digit answer is swallowed, because the digit already confirmed it.
 */
function reviewRequest(ctx: RequestContext, sessionID: string, task: ReplyEditor, draft: MessageDraft) {
  if (task.plainText.trim() || draft.submitted !== undefined) return false
  if (Date.now() < (ctx.answeredUntil ?? 0)) return true
  const waiting = waitingRequest(ctx, sessionID)
  if (!waiting) return false
  ctx.dialogs.close()
  if (waiting === "permission") permission(ctx)
  else question(ctx)
  return true
}

function createReplyEditor(ctx: RequestContext, dialog: ModalState, draft: MessageDraft) {
  return dockedEditor(
    ctx.dialogs,
    dialog,
    draft.text,
    draft.cursor,
    () => draft.submitted !== undefined,
    replyPlaceholder(ctx.renderer.width),
  )
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
  const request = prepare(ctx, draft, task.plainText, current)
  if (draft.submitted === undefined && !draft.shell && !draft.command) {
    const notice = outsideNotice(task.plainText, directory, attached.acknowledged, {
      missingFiles: ctx.connection.missingFiles,
      workspaceID: current.location.workspaceID,
    })
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
    if (refused(error)) {
      draft.submitted = undefined
      draft.prompt = undefined
    }
    throw ownedError(ctx, sessionID, error)
  }
  ctx.messages.delete(sessionID)
  if (draft.shell) return ctx.say("Shell command sent to the server.")
  if (draft.command || !running(ctx, sessionID)) return ctx.say(sentNotice)
  flash(ctx, draft.delivery === "queue" ? "Reply queued." : sentNotice)
}

/** The confirmation for a reply sent to a running turn borrows the editor's hint row for two seconds: the working line above already shows the state. */
function flash(ctx: RequestContext, text: string) {
  ctx.flash = { text, until: Date.now() + 2000 }
  clearTimeout(ctx.flashTimer)
  ctx.flashTimer = setTimeout(() => {
    if (!ctx.state.closed) ctx.state.modal?.refresh?.()
  }, 2000)
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
function prepare(ctx: RequestContext, draft: MessageDraft, text: string, session: Session) {
  const sessionID = session.id
  if (draft.shell) {
    const command = draft.shell
    ctx.connection.checkShell(sessionID, draft.id, command)
    return () => ctx.connection.shell(sessionID, draft.id, command)
  }
  if (draft.command) {
    const command = draft.command
    return () => ctx.connection.client.sessions.command({ sessionID, id: draft.id, ...command, resume: true })
  }
  if (draft.submitted === undefined)
    draft.prompt = promptPayload(text, session.location.directory, {
      missingFiles: ctx.connection.missingFiles,
      workspaceID: session.location.workspaceID,
    })
  const prompt = draft.prompt!
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
