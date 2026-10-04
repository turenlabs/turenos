import { InputRenderable, TextRenderable } from "@opentui/core"
import { matchesKey } from "../keys"
import type { Detail } from "../server"
import { label, type ModalState } from "../state"
import { color } from "../theme"
import { openSessionById } from "./update"
import { selectedSession, type SessionActionsContext } from "./context"
import { choose, filter, loadedTasks, refreshPicker, reveal, type TaskPicker } from "./task-picker"
import { todoText } from "./todos"

export function openTasks(ctx: SessionActionsContext): void {
  const { state, dialogs } = ctx
  const session = selectedSession(ctx)
  if (!session) return
  const detail = state.detail?.sessionID === session.id ? state.detail : undefined
  if (!detail) return ctx.say("Refresh this session's details before opening tasks.")
  const tasks = loadedTasks(detail)
  const dialog = dialogs.open(`${label(session.title || session.id, 40)} › Tasks`, false, 32)
  if (!dialog) return
  dialog.frame.maxWidth = 96
  const { query, todos, empty } = addTaskWidgets(ctx, dialog, detail)
  const picker: TaskPicker = {
    ctx,
    dialog,
    query,
    todos,
    empty,
    detail,
    tasks,
    revision: JSON.stringify(detail.tasks),
    matches: tasks,
    selected: 0,
    rows: [],
  }
  dialog.submit = async () => {
    const task = picker.matches[picker.selected]
    if (!task) throw new Error("Choose a loaded task first.")
    await openSessionById(ctx, task.childSessionID)
  }
  query.on("input", () => filter(picker))
  dialog.refresh = () => refreshPicker(picker, session.id)
  bindScrolling(picker)
  dialog.key = (key) => taskKey(picker, key)
  filter(picker)
  query.focus()
}

function bindScrolling(picker: TaskPicker) {
  const { dialog } = picker
  // The scrollbox is not a keyboard field; clicking its whitespace cannot steal search focus.
  dialog.form.onMouseDown = (event) => event.preventDefault()
  dialog.form.content.onMouse = (event) => {
    if (dialog.busy || event.type !== "scroll" || !event.scroll || !["up", "down"].includes(event.scroll.direction))
      return
    event.preventDefault()
    event.stopPropagation()
    choose(picker, picker.selected + (event.scroll.direction === "up" ? -3 : 3))
  }
  dialog.form.content.on("resize", () => reveal(picker))
  dialog.form.viewport.on("resize", () => reveal(picker))
}

function taskKey(picker: TaskPicker, key: Parameters<NonNullable<TaskPicker["dialog"]["key"]>>[0]) {
  if (matchesKey(key, "up") || matchesKey(key, "down")) {
    choose(picker, picker.selected + (key.name === "up" ? -1 : 1))
    return true
  }
  if (matchesKey(key, "pageup") || matchesKey(key, "pagedown")) {
    const page = Math.max(1, Math.floor(picker.dialog.form.viewport.height / 3))
    choose(picker, picker.selected + (key.name === "pageup" ? -1 : 1) * page)
    return true
  }
  if (!matchesKey(key, "enter")) return false
  if (picker.matches.length) void picker.ctx.dialogs.submit()
  return true
}

function addTaskWidgets(ctx: SessionActionsContext, dialog: ModalState, detail: Detail) {
  const query = new InputRenderable(ctx.renderer, {
    placeholder: "Search task description, agent, status, or ID",
    maxLength: 256,
    width: "100%",
    flexShrink: 0,
    backgroundColor: color.bg,
    focusedBackgroundColor: color.selected,
    textColor: color.text,
    placeholderColor: color.muted,
  })
  dialog.frame.add(query, 0)
  dialog.frame.add(
    new TextRenderable(ctx.renderer, {
      content: "Root-wide recent and active tasks, including nested delegation.",
      fg: color.muted,
      flexShrink: 0,
      wrapMode: "word",
    }),
    1,
  )
  const todos = new TextRenderable(ctx.renderer, {
    content: todoText(detail.todos),
    visible: detail.todos.length > 0,
    fg: color.text,
    flexShrink: 0,
    wrapMode: "none",
    truncate: true,
  })
  dialog.frame.add(todos, 2)
  const empty = new TextRenderable(ctx.renderer, { content: "", fg: color.muted, wrapMode: "word", flexShrink: 0 })
  dialog.form.add(empty)
  ctx.dialogs.track(dialog, query)
  return { query, todos, empty }
}
