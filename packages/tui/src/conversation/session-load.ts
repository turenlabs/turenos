import { pendingQuestions, transcript, display } from "../messages"
import { label, type DashboardState } from "../state"
import { color } from "../theme"
import type { Conversation } from "./context"
import { drawLive, mergeLive, syncLayout } from "./live-cache"
import { atBottom, commitPrepend, restorePosition, stagedMessageID } from "./position"

type Snapshot = NonNullable<DashboardState["snapshot"]>
type Session = Snapshot["sessions"][number]
type Detail = NonNullable<DashboardState["detail"]>

/** Fetches the selected session's detail (or history page) and paints it at the right reading position. */
export async function loadSession(c: Conversation, snapshot: Snapshot, session: Session, version: number) {
  const { state, ui } = c
  const id = session.id
  if (state.detail?.sessionID !== id) {
    state.detail = undefined
    if (!c.live.has(id) || state.history) {
      ui.renderContent(`Loading ${display(session.title)}…`)
    }
  }
  ui.sessionTitle.content = label(session.title || "Untitled session", 150)
  ui.context.visible = !state.modal?.inline
  ui.context.fg = color.muted
  ui.context.content = `${state.history ? "History" : "Transcript"}${Object.hasOwn(snapshot.active, id) ? " · Working" : ""} · ${label(session.location.directory, 250)}`
  const page = state.history && c.pageRequest?.sessionID === id ? c.pageRequest : undefined
  const result = await c.connection.detail(id, state.history ? (page?.cursor ?? state.historyCursor) : undefined)
  if (version !== state.detailVersion || state.closed) return
  if (page) {
    c.pageRequest = undefined
    // The API supplies cursors even at boundaries. Do not replace the last
    // readable page with an empty result or lose the way back.
    if (!result.messages.length) {
      c.hooks.say(page.direction === "next" ? "Start of history reached." : "Newest history page.")
      return
    }
    state.historyCursor = page.cursor
    c.position = { sessionID: id, history: true, scroll: 0 }
    ui.detail.scrollTo(0)
  }
  if (!state.history && c.hooks.project) result.messages = [...c.hooks.project(id, result.messages)]
  state.detail = result
  state.modal?.refresh?.()
  describeResult(c, session, result)
  commitPrepend(c)
  const questionPreview = trackPending(c, id, result)
  paintResult(c, id, result, questionPreview)
}

function describeResult(c: Conversation, session: Session, result: Detail) {
  const { state, ui } = c
  const tasks = [...new Map([...result.tasks.data, ...result.tasks.active].map((task) => [task.id, task])).values()]
  if (tasks.length) {
    const active = tasks.filter((task) => ["queued", "starting", "running"].includes(task.status)).length
    const failed = tasks.filter((task) => task.status === "failed").length
    ui.context.content = `${state.history ? "History" : "Transcript"} · Tasks: ${active} active, ${failed} failed · ${label(session.location.directory, 150)}`
  }
  if (result.permissions.length || result.questions.length) {
    ui.context.content = `Needs input · ${label(session.location.directory, 250)}`
    ui.context.fg = color.warning
  }
}

/** Parks the reading position while a question preview takes over, and restores it afterwards. */
function trackPending(c: Conversation, id: string, result: Detail) {
  const { state, ui } = c
  const pendingKey = `${id}:${result.permissions[0]?.id ?? ""}:${result.questions[0]?.id ?? ""}`
  if (pendingKey !== c.lastPending) {
    c.lastPending = pendingKey
    if (result.questions.length && !c.hooks.questionsInPanel) {
      c.beforeQuestion ??= c.position ?? {
        sessionID: id,
        history: state.history,
        scroll: !state.history && atBottom(c) ? Number.MAX_SAFE_INTEGER : ui.detail.scrollTop,
      }
      c.position = { sessionID: id, history: state.history, scroll: 0 }
    } else if (c.beforeQuestion?.sessionID === id) {
      c.position = c.beforeQuestion
      c.beforeQuestion = undefined
    }
    if (result.permissions.length || result.questions.length) c.hooks.say("Needs input · p permission · o question")
  }
  c.hooks.actions()
  return c.hooks.questionsInPanel ? "" : pendingQuestions(result.questions)
}

function paintResult(c: Conversation, id: string, result: Detail, questionPreview: string) {
  const { state, ui } = c
  const follow =
    !state.history &&
    !questionPreview &&
    (c.position?.scroll === Number.MAX_SAFE_INTEGER || (!c.position && atBottom(c)))
  if (follow) c.position = { sessionID: id, history: false, scroll: Number.MAX_SAFE_INTEGER }
  if (!state.history) {
    mergeLive(c, result.messages)
    drawLive(c)
    return
  }
  const content = transcript(result.messages, state.rawResponses) || "No messages yet."
  const staged = stagedMessageID(c) ? "UNDO STAGED - this History view includes later, staged-away messages.\n\n" : ""
  ui.renderContent(`${questionPreview ? `${questionPreview}\n\n` : ""}${staged}${content}`, !questionPreview)
  syncLayout(c)
  restorePosition(c)
}
