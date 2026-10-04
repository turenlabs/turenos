import { TextRenderable, type InputRenderable } from "@opentui/core"
import type { Detail } from "../server"
import { label, type ModalState } from "../state"
import { color } from "../theme"
import type { SessionActionsContext } from "./context"
import { todoText } from "./todos"

type LoadedTask = Detail["tasks"]["data"][number]

/** The task list dialog's selection state; its operations below act on it in place. */
export type TaskPicker = {
  ctx: SessionActionsContext
  dialog: ModalState
  query: InputRenderable
  todos: TextRenderable
  /** The empty state, shown in the list area where the rows would be. */
  empty: TextRenderable
  detail: Detail
  tasks: LoadedTask[]
  revision: string
  matches: LoadedTask[]
  selected: number
  rows: TextRenderable[]
}

/** Recent and active tasks of the root, de-duplicated by ID. */
export function loadedTasks(detail: Detail) {
  return [...new Map([...detail.tasks.data, ...detail.tasks.active].map((task) => [task.id, task])).values()]
}

export function reveal(picker: TaskPicker) {
  const { dialog } = picker
  const top = picker.selected * 3
  if (top < dialog.form.scrollTop) dialog.form.scrollTo(top)
  if (top + 3 > dialog.form.scrollTop + dialog.form.viewport.height)
    dialog.form.scrollTo(top + 3 - dialog.form.viewport.height)
}

function paint(picker: TaskPicker, index: number) {
  const task = picker.matches[index]
  const row = picker.rows[index]
  if (!task || !row) return
  const selected = index === picker.selected
  row.bg = selected ? color.accent : color.panel
  row.fg = selected ? color.bg : task.status === "failed" ? color.error : color.text
  row.content = `${selected ? "▶" : " "} [${task.status}] ${label(task.description, 200)}\n  ${label(task.agent)} · ${task.childSessionID}\n  ${task.error ? `Failure: ${label(task.error, 500)}` : `Task: ${task.id}`}`
}

export function choose(picker: TaskPicker, index: number) {
  const previous = picker.selected
  picker.selected = Math.max(0, Math.min(index, picker.matches.length - 1))
  paint(picker, previous)
  paint(picker, picker.selected)
  reveal(picker)
  picker.empty.visible = !picker.matches.length
  picker.empty.content = picker.tasks.length
    ? "No matching loaded tasks."
    : "No tasks yet. Subagent work started in this session appears here."
  picker.dialog.error.content = picker.matches.length
    ? `${picker.selected + 1}/${picker.matches.length} · ↑/↓ choose · Enter open · Esc close\nPgUp/PgDn page${picker.detail.tasks.cursor.next ? " · Older tasks are not loaded" : ""}`
    : "Esc close"
}

/** Re-matches the search terms, rebuilds the rows and keeps the previously chosen task selected when it survives. */
export function filter(picker: TaskPicker) {
  const { ctx, dialog } = picker
  const id = picker.matches[picker.selected]?.id
  const terms = picker.query.value.toLowerCase().trim().split(/\s+/).filter(Boolean)
  picker.matches = picker.tasks.filter((task) => {
    const text =
      `${task.description} ${task.agent} ${task.status} ${task.id} ${task.childSessionID} ${task.error ?? ""}`.toLowerCase()
    return terms.every((term) => text.includes(term))
  })
  picker.selected = Math.max(
    0,
    picker.matches.findIndex((task) => task.id === id),
  )
  picker.rows.forEach((row) => row.destroyRecursively())
  picker.rows = picker.matches.map((_, index) => {
    const row = new TextRenderable(ctx.renderer, {
      height: 3,
      flexShrink: 0,
      width: "100%",
      wrapMode: "none",
      truncate: true,
      onMouseDown: (event) => {
        event.preventDefault()
        if (event.button !== 0 || dialog.busy) return
        choose(picker, index)
        void ctx.dialogs.submit()
      },
    })
    dialog.form.add(row)
    return row
  })
  picker.rows.forEach((_, index) => paint(picker, index))
  choose(picker, picker.selected)
}

/** Picks up background detail refreshes while the dialog is open; only changed task lists re-filter. */
export function refreshPicker(picker: TaskPicker, sessionID: string) {
  const { state } = picker.ctx
  if (state.modal !== picker.dialog || picker.dialog.busy || state.detail?.sessionID !== sessionID) return
  const next = JSON.stringify(state.detail.tasks)
  picker.todos.content = todoText(state.detail.todos)
  picker.todos.visible = state.detail.todos.length > 0
  if (picker.revision === next) return
  picker.revision = next
  picker.detail = state.detail
  picker.tasks = loadedTasks(picker.detail)
  filter(picker)
}
