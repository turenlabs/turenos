import type { MessagesListOutput } from "@turenlabs/client"
import { display, toolResult } from "../messages"
import { changeDiff } from "./changes"
import { collapseText, type Collapse } from "./collapse"
import { answeredQuestions } from "./question"
import { todoChecklist } from "./todos"

type Message = MessagesListOutput["data"][number]
export type ToolPart = Extract<Extract<Message, { type: "assistant" }>["content"][number], { type: "tool" }>

/** `raw` shows the server's bounded text untouched; `rich` is the dashboard view, which may collapse and style. */
export type ToolView = Collapse & { raw: boolean }

// The server's wording for a tool that was stopped (packages/core/src/session/runner/llm.ts).
export const TOOL_INTERRUPTED = "Tool execution interrupted"

/** A status line for one tool call followed by its result, shortened to the first lines in the dashboard. */
export function toolBlock(part: ToolPart, view: ToolView) {
  const state = part.state
  const stopped = state.status === "error" && state.error.message === TOOL_INTERRUPTED
  const status = stopped ? "interrupted" : display(state.status, 32)
  const failure = state.status === "error" && !stopped ? `\n${display(state.error.message)}` : ""
  return `  [${status}] ${display(part.name, 200)}${toolSummary(state)}\n${toolBody(part, view)}${failure}`
}

function toolBody(part: ToolPart, view: ToolView) {
  const state = part.state
  if (state.status === "pending") return ""
  if (view.raw)
    return state.content.map((item) => (item.type === "text" ? display(item.text, 4000) : fileLine(item))).join("\n")
  // A checklist is a status display, never something to fold away.
  if (part.name === "todowrite") {
    const checklist = todoChecklist(state.input)
    if (checklist) return checklist
  }
  const answers = answeredQuestions(part)
  if (answers) return answers
  const diff = changeDiff(part, view)
  if (diff) return diff
  const text = state.content.map((item) => (item.type === "text" ? toolResult(item.text) : fileLine(item))).join("\n")
  return collapseText(text, view)
}

function fileLine(item: { uri: string }) {
  return `[file] ${display(item.uri, 1000)}`
}

// Search inputs come before paths so a grep reads as its pattern, not its folder.
// A task's description comes last, so a command or path still wins over it.
const summaryKeys = ["command", "pattern", "query", "url", "filePath", "path", "file", "description"]

/** One line saying what a tool ran: " · <command, path or pattern>", or nothing when the input has none. */
function toolSummary(state: ToolPart["state"]) {
  if (state.status === "pending" || typeof state.input !== "object" || state.input === null) return ""
  const input = state.input as Record<string, unknown>
  const key = summaryKeys.find((key) => typeof input[key] === "string" && (input[key] as string).trim())
  if (!key) return ""
  const line = display((input[key] as string).slice(0, 400))
    .replace(/\s+/g, " ")
    .trim()
  return ` · ${line.length > 120 ? `${line.slice(0, 119)}…` : line}`
}
