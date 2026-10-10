import type { MessagesListOutput } from "@turenlabs/client"
import { TurnInterruption } from "@turenlabs/client/turn-interruption"
import { display, toolResult } from "../messages"
import { changeDiff } from "./changes"
import { codeSpan, literal } from "./literal"
import type { Collapse } from "./collapse"
import { answeredQuestions } from "./question"
import { startedAgents } from "./subagent"
import { todoChecklist } from "./todos"

type Message = MessagesListOutput["data"][number]
export type ToolPart = Extract<Extract<Message, { type: "assistant" }>["content"][number], { type: "tool" }>

/** `raw` shows the server's bounded text untouched; `rich` is the dashboard view, which may collapse and style. */
export type ToolView = Collapse & { raw: boolean }

/** A status line for one tool call followed by its result, shortened to the first lines in the dashboard. */
export function toolBlock(part: ToolPart, view: ToolView) {
  const state = part.state
  const stopped = state.status === "error" && state.error.message === TurnInterruption.TOOL
  // The status is one of the fixed words the response validation allows, and the name has no control characters.
  const status = stopped ? "interrupted" : display(state.status, 32)
  const failure =
    state.status === "error" && !stopped
      ? `\n${view.rich ? literal(state.error.message) : display(state.error.message)}`
      : ""
  return `  [${status}] ${toolName(part.name, view.rich)}${toolSummary(state, view.rich)}\n${toolBody(part, view)}${failure}`
}

/** The name on one line; any Markdown in it is shown as written. */
function toolName(name: string, rich: boolean) {
  const shown = display(name.length > 120 ? `${name.slice(0, 119)}…` : name)
  return rich ? codeSpan(shown) : shown
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
  const started = view.rich ? startedAgents(part, view) : undefined
  if (started) return started
  const text = state.content.map((item) => (item.type === "text" ? toolResult(item.text) : fileLine(item))).join("\n")
  return view.rich ? literal(text, 16000, view) : text
}

function fileLine(item: { uri: string }) {
  return `[file] ${display(item.uri, 1000)}`
}

// Search inputs come before paths so a grep reads as its pattern, not its folder.
// A task's description comes last, so a command or path still wins over it.
const summaryKeys = ["command", "pattern", "query", "url", "filePath", "path", "file", "description"]

/** One line saying what a tool ran: " · <command, path or pattern>", or nothing when the input has none. */
function toolSummary(state: ToolPart["state"], rich: boolean) {
  if (state.status === "pending" || typeof state.input !== "object" || state.input === null) return ""
  const input = state.input as Record<string, unknown>
  const key = summaryKeys.find((key) => typeof input[key] === "string" && (input[key] as string).trim())
  if (!key) return ""
  const line = display((input[key] as string).slice(0, 400))
    .replace(/\s+/g, " ")
    .trim()
  const shown = line.length > 120 ? `${line.slice(0, 119)}…` : line
  return ` · ${rich ? codeSpan(shown) : shown}`
}
