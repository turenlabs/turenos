import { fg, StyledText, type KeyEvent, type TextareaRenderable } from "@opentui/core"
import { assignedHandles, mentionedHandles, mergeMessages, roomCoordinator } from "@turenlabs/client/team"
import { dockedEditor } from "../dialogs/docked-editor"
import { matchesKey } from "../keys"
import { maxDrafts, newMessageID } from "../requests/context"
import { errorText, httpStatus, refused } from "../server"
import { label, type ModalState } from "../state"
import { color } from "../theme"
import { createCompletion } from "./complete"
import { handleOf } from "./format"
import { MAX_MESSAGES, viewOf, type TeamContext, type TeamView } from "./types"

/** A message being written for one room. The ID is made with the draft, so a retry cannot post twice. */
export type PostDraft = { text: string; id: string; submitted?: string; cursor?: number }

const MAX_TEXT = 20_000
const HINT = "Enter post · Shift/Alt+Enter newline · @ mentions a teammate · Esc shortcuts · F4 discard"
const LIST_HINT = "Up/Down choose · Tab complete · Enter pick · Esc close list · F4 discard"

export type Poster = {
  ctx: TeamContext
  /** Drafts last until the TUI quits, like reply drafts. */
  drafts: Map<string, PostDraft>
  /** The open editor's `@` list, which the dashboard's key router asks first. */
  key: (event: KeyEvent) => boolean
  atTop: () => boolean
  older: () => void
  /** The room whose editor is open. */
  editing?: string
}

export function openPost(poster: Poster) {
  const { ctx } = poster
  const view = viewOf(ctx.state)
  const room = view.room
  if (ctx.state.tab !== "team" || !room || room.id !== ctx.state.selected) return ctx.say("Select a room first.")
  if (room.archived) return ctx.say("Archived rooms are read-only.", true)
  ctx.state.detailFocused = true
  if (ctx.state.modal?.composer) return ctx.state.modal.editor?.focus()
  if (!poster.drafts.has(room.id) && poster.drafts.size >= maxDrafts)
    return ctx.say("16 message drafts are saved. Send or discard one before starting another.")
  const dialog = ctx.dialogs.open(`Post to # ${label(room.name, 60)}`, false, 24, true)
  if (!dialog) return
  dialog.composer = true
  const draft = poster.drafts.get(room.id) ?? { text: "", id: newMessageID() }
  if (draft.submitted !== undefined) draft.text = draft.submitted
  poster.drafts.set(room.id, draft)
  const editor = dockedEditor(
    ctx.dialogs,
    dialog,
    draft.text,
    draft.cursor,
    () => draft.submitted !== undefined,
    "Message the room · @ mentions a teammate",
  )
  wire(poster, dialog, editor, room.id, draft)
  ctx.dialogs.resize()
  editor.focus()
}

function wire(poster: Poster, dialog: ModalState, editor: TextareaRenderable, roomID: string, draft: PostDraft) {
  const { ctx } = poster
  const completion = createCompletion(
    ctx,
    dialog,
    editor,
    () => viewOf(ctx.state).teammates,
    () => draft.submitted !== undefined,
  )
  poster.key = completion.key
  poster.editing = roomID
  const previousSubmit = dialog.beforeSubmit
  dialog.beforeSubmit = () => completion.submit() || (previousSubmit?.() ?? false)
  dialog.save = () => {
    draft.text = draft.submitted ?? editor.plainText
    draft.cursor = editor.cursorOffset
    // An empty editor leaves no draft, so there is nothing to resume.
    if (draft.text || draft.submitted !== undefined) return ctx.say("Post draft kept · Enter or f to resume")
    poster.drafts.delete(roomID)
  }
  dialog.discard = () => {
    poster.drafts.delete(roomID)
  }
  dialog.submit = () => submitPost(poster, editor, roomID, draft)
  dialog.key = (key) => {
    // PageUp at the top of the log loads the page before it; anywhere else it scrolls as usual.
    if (!matchesKey(key, "pageup") || !poster.atTop() || !viewOf(ctx.state).hasMore) return false
    poster.older()
    return true
  }
  const paint = (edited: boolean) => paintHint(ctx, dialog, editor, edited)
  dialog.refresh = () => paint(false)
  const changed = editor.onContentChange
  editor.onContentChange = (event) => {
    changed?.(event)
    paint(true)
  }
  paint(true)
}

/** The lines under the editor: who the message tasks, then the keys. A failure message stays until the text changes. */
function paintHint(ctx: TeamContext, dialog: ModalState, editor: TextareaRenderable, edited: boolean) {
  if (!edited && dialog.error.plainText.includes("Ctrl+S retry")) return
  const lines = mentionLines(viewOf(ctx.state), editor.plainText)
  const hint = (dialog.suggestionRows ?? 0) > 0 ? LIST_HINT : HINT
  const wanted = lines.length + 2
  dialog.error.content = new StyledText([
    ...lines.map((line) => fg(line.warn ? color.warning : color.muted)(`${line.text}\n`)),
    fg(color.muted)(hint),
  ])
  dialog.error.fg = color.muted
  if (dialog.error.height === wanted) return
  dialog.error.height = wanted
  ctx.dialogs.resize()
}

function mentionLines(view: TeamView, text: string) {
  const handles = mentionedHandles(text)
  const known = assignedHandles(text, view.teammates)
  if (!handles.length) {
    const coordinator = view.room ? roomCoordinator(view.room, view.teammates) : undefined
    return [
      {
        text: coordinator
          ? `No mention: @${label(coordinator.handle, 32)} (coordinator) replies.`
          : "No active teammate will reply.",
        warn: false,
      },
    ]
  }
  return [
    ...(known.length ? [{ text: `Tasks for: ${known.map((handle) => `@${handle}`).join(", ")}`, warn: false }] : []),
    ...handles
      .filter((handle) => !known.includes(handle))
      .slice(0, 2)
      .map((handle) => ({ text: `@${label(handle, 32)} is not in this room`, warn: true })),
  ]
}

async function submitPost(poster: Poster, editor: TextareaRenderable, roomID: string, draft: PostDraft) {
  const { ctx } = poster
  if (!ctx.state.connected) throw new Error("Reconnect before posting. Your draft is kept.")
  if (ctx.state.team?.rooms.find((room) => room.id === roomID)?.archived)
    throw new Error("Archived rooms are read-only.")
  const text = editor.plainText
  if (!text.trim() || text.length > MAX_TEXT) throw new Error("Enter a message between 1 and 20,000 characters.")
  if (draft.submitted !== undefined && draft.submitted !== text)
    throw new Error("Retry the original message. Escape keeps its request ID; F4 discards the local draft.")
  draft.text = text
  draft.submitted = text
  const posted = await ctx.connection.client.team
    .messagePost({ id: draft.id, roomID, text })
    .catch((error: unknown) => {
      // The server stores a message by its ID and answers an exact retry with the stored message and tasks
      // (packages/core/src/team/workspace.ts), so a timeout, network error or 5xx keeps the ID and locks the text.
      // A 4xx admitted nothing. A 409 means this ID was never stored for this text (archived room, or an ID the
      // server holds for different text), so it also unlocks, with a new ID for the next send.
      if (refused(error) || httpStatus(error) === 409) draft.submitted = undefined
      if (httpStatus(error) === 409) draft.id = newMessageID()
      throw new Error(errorText(error))
    })
  poster.drafts.delete(roomID)
  ctx.say(applyPosted(ctx, posted))
}

/** Puts the answer in the log at once and returns what to tell the user. */
function applyPosted(
  ctx: TeamContext,
  posted: Awaited<ReturnType<TeamContext["connection"]["client"]["team"]["messagePost"]>>,
) {
  const view = viewOf(ctx.state)
  const message = posted.message as TeamView["messages"][number]
  const tasks = posted.tasks as TeamView["tasks"]
  const last = view.messages.at(-1)?.seq
  // Appending across a gap would make the next poll skip what others posted meanwhile; the poll adds it instead.
  if (view.room?.id === message.roomID && (last === undefined || message.seq === last + 1)) {
    const merged = mergeMessages(view.messages, [message])
    view.messages = merged.length > MAX_MESSAGES ? merged.slice(-MAX_MESSAGES) : merged
    view.hasMore = view.hasMore || merged.length > MAX_MESSAGES
    view.tasks = [...tasks, ...view.tasks.filter((task) => !tasks.some((item) => item.id === task.id))]
    view.follow = true
  }
  const handles = [...new Set(tasks.map((task) => handleOf(view.teammates, task.teammateID)))]
  if (!handles.length) return "Posted."
  const names = handles.length > 1 ? `${handles.slice(0, -1).join(", ")} and ${handles.at(-1)}` : handles[0]
  return `Posted. ${names} got ${handles.length > 1 ? "tasks" : "a task"}.`
}

/** Post drafts that would be lost on quit, counting the text in the open editor. */
export function unsent(poster: Poster) {
  const open = poster.ctx.state.modal?.composer ? poster.ctx.state.modal.editor : undefined
  return [...poster.drafts.entries()].filter(
    ([room, draft]) =>
      draft.submitted !== undefined || !!(open && poster.editing === room ? open.plainText : draft.text).trim(),
  ).length
}
