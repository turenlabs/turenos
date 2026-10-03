import { label } from "../state"
import type { Todo } from "../server"

const MARK = { pending: "[ ]", in_progress: "[>]", completed: "[x]", cancelled: "[-]" } as const

/** "3/7 to-dos", counting cancelled items as settled, or "" when the agent keeps no list. */
export function todoProgress(todos: readonly Todo[]) {
  if (!todos.length) return ""
  return `${todos.filter((todo) => todo.status === "completed" || todo.status === "cancelled").length}/${todos.length} to-dos`
}

export function todoText(todos: readonly Todo[]) {
  return [
    `TO-DOS · ${todoProgress(todos)}`,
    ...todos.slice(0, 12).map((todo) => `${MARK[todo.status]} ${label(todo.content, 160)}`),
    ...(todos.length > 12 ? [`… ${todos.length - 12} more`] : []),
  ].join("\n")
}
