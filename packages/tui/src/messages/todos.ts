import { display } from "../messages"

const mark = { completed: "[x]", in_progress: "[>]", pending: "[ ]", cancelled: "[-]" } as Record<string, string>

/** A todowrite input as a checklist, or undefined when it does not carry one. */
export function todoChecklist(input: unknown) {
  const todos = typeof input === "object" && input !== null && "todos" in input ? input.todos : undefined
  if (!Array.isArray(todos) || !todos.length) return undefined
  return todos
    .slice(0, 50)
    .flatMap((todo: unknown) => {
      if (typeof todo !== "object" || todo === null || !("content" in todo) || typeof todo.content !== "string")
        return []
      const status = "status" in todo && typeof todo.status === "string" ? todo.status : "pending"
      return [`  ${mark[status] ?? "[ ]"} ${display(todo.content, 300).replace(/\s+/g, " ").trim()}`]
    })
    .join("\n")
}
