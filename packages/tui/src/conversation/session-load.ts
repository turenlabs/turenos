import { pendingQuestions } from "../messages"
import { label, sessionTitle, type DashboardState } from "../state"
import { color } from "../theme"
import type { Conversation } from "./context"
import { sentByReader } from "./follow"
import { openPart, paintHistory } from "./history-part"
import { drawLive, mergeLive } from "./live-cache"
import { atBottom, commitPrepend } from "./position"

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
      ui.renderContent(`Loading ${sessionTitle(session.title)}…`)
    }
  }
  ui.sessionTitle.content = `${sessionTitle(session.title || "Untitled session", 150)}${session.time.archived !== undefined ? " · Archived" : ""}`
  ui.context.visible = !state.modal?.inline
  ui.context.fg = color.muted
  ui.context.content = contextText([viewName(state), subagentOf(snapshot, session), label(session.location.directory, 250)])
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
    // Reading older, the eye continues from the bottom of the older page; reading newer, from its top.
    const older = page.direction === "next"
    state.historyPage = Math.max(1, state.historyPage + (older ? 1 : -1))
    openPart(c, page.direction)
    c.position = { sessionID: id, history: true, scroll: older ? Number.MAX_SAFE_INTEGER : 0 }
    ui.detail.scrollTo(older ? Number.MAX_SAFE_INTEGER : 0)
  }
  if (!state.history && c.hooks.project) result.messages = [...c.hooks.project(id, result.messages)]
  state.detail = result
  state.modal?.refresh?.()
  describeResult(c, session, result)
  commitPrepend(c)
  const questionPreview = trackPending(c, id, result)
  paintResult(c, id, result, questionPreview)
}

/** The view and, in History, where the reader is and the keys that move; the server counts no pages, so there is no total. */
function viewName(state: DashboardState) {
  return state.history ? `History · page ${state.historyPage} · [ older · ] newer · h back to live` : ""
}

/** The context line's fields in order; the view name is empty on the live transcript, and the header already says Working and Needs input. */
function contextText(fields: string[]) {
  return fields.filter(Boolean).join(" · ")
}

/** A child session names the one it came from and the key that goes back; f opens the owning session. */
function subagentOf(snapshot: Snapshot | undefined, session: Session) {
  if (!session.parentID) return ""
  const parent = snapshot?.sessions.find((item) => item.id === session.parentID)
  return `Subagent of ${parent ? sessionTitle(parent.title || "Untitled session", 40) : "its parent session"} · f returns`
}

function describeResult(c: Conversation, session: Session, result: Detail) {
  const { state, ui } = c
  const tasks = [...new Map([...result.tasks.data, ...result.tasks.active].map((task) => [task.id, task])).values()]
  if (tasks.length) {
    const active = tasks.filter((task) => ["queued", "starting", "running"].includes(task.status)).length
    const failed = tasks.filter((task) => task.status === "failed").length
    const counts = [
      `${tasks.length} task${tasks.length === 1 ? "" : "s"}`,
      ...(active ? [`${active} active`] : []),
      ...(failed ? [`${failed} failed`] : []),
    ]
    ui.context.content = contextText([
      viewName(state),
      counts.join(", "),
      subagentOf(state.snapshot, session),
      label(session.location.directory, 150),
    ])
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
  const { state } = c
  const follow =
    !state.history &&
    !questionPreview &&
    (sentByReader(c, result.messages) || c.position?.scroll === Number.MAX_SAFE_INTEGER || (!c.position && atBottom(c)))
  if (follow) c.position = { sessionID: id, history: false, scroll: Number.MAX_SAFE_INTEGER }
  if (!state.history) {
    mergeLive(c, result.messages)
    drawLive(c)
    return
  }
  paintHistory(c, result, questionPreview)
}
