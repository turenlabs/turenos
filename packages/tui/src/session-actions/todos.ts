import { label } from "../state"
import type { Todo } from "../server"

// The labels pad to the longest ("[in progress]") so every glyph and every text start in the same column.
const MARK = {
  pending: "[to do]       ○",
  in_progress: "[in progress] ◐",
  completed: "[completed]   ●",
  cancelled: "[cancelled]   ×",
} as const

const settled = (todos: readonly Todo[]) =>
  todos.filter((todo) => todo.status === "completed" || todo.status === "cancelled").length

/** "3/7 to-dos", counting cancelled items as settled, or "" when the agent keeps no list. */
export function todoProgress(todos: readonly Todo[]) {
  return todos.length ? `${settled(todos)}/${todos.length} to-dos` : ""
}

export function todoText(todos: readonly Todo[]) {
  return [
    `TO-DOS · ${settled(todos)}/${todos.length} done · read-only (the agent keeps this list)`,
    ...todos.slice(0, 12).map((todo) => `${MARK[todo.status]} ${label(todo.content, 160)}`),
    ...(todos.length > 12 ? [`… ${todos.length - 12} more`] : []),
  ].join("\n")
}
