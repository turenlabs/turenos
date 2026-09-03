export * as SessionTodoGuidance from "./todo-guidance"

import type { SessionTodo } from "@turenlabs/schema/session-todo"

export type Todo = typeof SessionTodo.Info.Type
export type Prompt = "initial" | "reconcile"

export const SYSTEM = [
  "Todo workflow:",
  "- When the `todowrite` tool is available, use it for non-trivial work that has multiple concrete steps.",
  "- Create the list before substantive work, keep exactly one active item `in_progress`, and update it after meaningful progress and before the final response.",
  "- Mark work `completed` only after the required verification. Keep unfinished work `pending` or `in_progress`; do not use `update_goal` as a substitute for todo bookkeeping.",
  "- Skip todo bookkeeping for trivial requests or when the tool is unavailable.",
].join("\n")

export const hasOpenItems = (todos: ReadonlyArray<Todo>) =>
  todos.some((todo) => todo.status === "pending" || todo.status === "in_progress")

export const prompt = (kind: Prompt, todos: ReadonlyArray<Todo>) => {
  const instruction =
    kind === "reconcile"
      ? "The previous provider turn made substantive progress without a successful `todowrite` update. Reconcile the list now before continuing."
      : "Before substantive work, decide whether this request is multi-step. If it is, create or update the list now before continuing."
  return [
    "<todo_checkpoint>",
    "This is internal bookkeeping, not a user request. Never answer or mention it; continue handling the most recent user instruction.",
    instruction,
    currentList(todos),
    "If the request is trivial or `todowrite` is unavailable, continue without it. Do not narrate this checkpoint.",
    "</todo_checkpoint>",
  ].join("\n")
}

const MAX_ITEMS = 32
const MAX_CONTENT = 256

function currentList(todos: ReadonlyArray<Todo>) {
  if (todos.length === 0) return "No durable todo list exists yet. Create one now if this is multi-step work."
  const displayed = todos.slice(0, MAX_ITEMS)
  const omitted = todos.length - displayed.length
  return [
    "Current durable todo list:",
    ...displayed.map((todo, index) => {
      const content = todo.content.length > MAX_CONTENT ? `${todo.content.slice(0, MAX_CONTENT)}...` : todo.content
      return `${index + 1}. [${escapeXml(todo.status)}] (${escapeXml(todo.priority)}) ${escapeXml(content)}`
    }),
    ...(omitted > 0
      ? [
          `... ${omitted} additional todo items remain in durable storage.`,
          "This view is incomplete. Do not call `todowrite` from only the visible rows; preserve omitted items from the complete list.",
        ]
      : []),
  ].join("\n")
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}
