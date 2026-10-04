import { label } from "../state"
import type { Todo } from "../server"

const MARK = { pending: "○", in_progress: "◐", completed: "●", cancelled: "×" } as const

const settled = (todos: readonly Todo[]) =>
  todos.filter((todo) => todo.status === "completed" || todo.status === "cancelled").length

/** "3/7 to-dos", counting cancelled items as settled, or "" when the agent keeps no list. */
export function todoProgress(todos: readonly Todo[]) {
  return todos.length ? `${settled(todos)}/${todos.length} to-dos` : ""
}

export function todoText(todos: readonly Todo[]) {
  return [
    `TO-DOS · ${settled(todos)}/${todos.length} done · read-only`,
    ...todos.slice(0, 12).map((todo) => `${MARK[todo.status]} ${label(todo.content, 160)}`),
    ...(todos.length > 12 ? [`… ${todos.length - 12} more`] : []),
  ].join("\n")
}
