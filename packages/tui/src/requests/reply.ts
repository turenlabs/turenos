import { TextRenderable } from "@opentui/core"
import { refused, type Session } from "../server"
import { label, type MessageDraft, type ModalState } from "../state"
import { color } from "../theme"
import { matchesKey } from "../keys"
import { outsideNotice } from "../mentions/outside"
import { promptPayload } from "../prompt-files"
import { showAttachments } from "./attachments"
import { openBlockedReply } from "./blocked-reply"
import { maxDrafts, maxMessageLength, newMessageID, replyBlocked, type RequestContext } from "./context"

export function followup(ctx: RequestContext) {
  if (ctx.state.tab !== "sessions" || !ctx.state.selected) return ctx.say("Select a session first.")
  const sessionID = ctx.state.selected
  const session = ctx.state.snapshot?.sessions.find((session) => session.id === sessionID)
  if (!session) return ctx.say("This session is no longer available. Refresh the list.")
  if (replyBlocked(ctx, sessionID)) return openBlockedReply(ctx, session, () => followup(ctx))
  if (!ctx.messages.has(sessionID) && ctx.messages.size >= maxDrafts)
    return ctx.say("16 message drafts are saved. Send or discard one before starting another.")
  openReply(ctx, session)
}

function openReply(ctx: RequestContext, session: Session) {
  const sessionID = session.id
  const dialog = ctx.dialogs.open("Reply", false, 24, true)
  if (!dialog) return
  dialog.recipient = session
  const draft: MessageDraft = ctx.messages.get(sessionID) ?? {
    text: "",
    id: newMessageID(),
    recipient: session,
    delivery: "steer",
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
    if (!draft.text && draft.submitted === undefined) ctx.messages.delete(sessionID)
    ctx.say("Message draft kept · f to resume")
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
  const delivery = () => {
    heading.content = `${draft.delivery === "queue" ? "Queue" : "Steer"} · Reply to ${label(session.title, 100)}${session.revert ? " · undo staged" : ""}`
    heading.fg = session.revert ? color.warning : color.muted
    dialog.error.content = session.revert
      ? "Enter Send + commit undo · Alt+Enter newline\nEsc keep · F4 discard · Ctrl+T mode"
      : "Enter Send · Shift/Alt+Enter newline\nEsc keep · F4 discard · Ctrl+T mode"
  }
  dialog.key = (key) => {
    if (!matchesKey(key, "t", { ctrl: true })) return false
    if (draft.submitted !== undefined) {
      dialog.error.content = "Retry keeps the original delivery mode. F4 discards the local draft."
      return true
    }
    draft.delivery = draft.delivery === "steer" ? "queue" : "steer"
    delivery()
    return true
  }
  return delivery
}

/** The reply editor, sized from `lineInfo.lineSources.length` (virtualLineCount can be viewport-limited). */
function createReplyEditor(ctx: RequestContext, dialog: ModalState, draft: MessageDraft) {
  const task = ctx.dialogs.prompt(dialog, "Your message", draft.text, draft.cursor)
  dialog.editor = task
  dialog.editorLocked = () => draft.submitted !== undefined
  task.height = Math.max(3, Math.min(6, task.lineInfo.lineSources.length))
  task.marginBottom = 0
  const contentChanged = task.onContentChange
  const resizeTask = () => {
    const height = Math.max(3, Math.min(6, task.lineInfo.lineSources.length))
    if (task.height === height) return
    task.height = height
    ctx.dialogs.resize()
  }
  task.onContentChange = (event) => {
    contentChanged?.(event)
    resizeTask()
  }
  task.onSizeChange = resizeTask
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
  if ((draft.command || draft.shell) && draft.delivery === "queue")
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
  draft.submitted = draft.text
  try {
    await request()
  } catch (error) {
    // A definite 4xx admitted nothing, so the text is editable again; the ID stays for the next send.
    if (refused(error)) draft.submitted = undefined
    throw ownedError(ctx, sessionID, error)
  }
  ctx.messages.delete(sessionID)
  ctx.say(draft.shell ? "Shell command sent to the server." : "Reply sent.")
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
