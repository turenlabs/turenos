import { display } from "../messages"
import { literal } from "./literal"

const OPEN = "<forge-parent-session-context>"
const CLOSE = "</forge-parent-session-context>"
// The block is reference data for the model; past this size it is not parsed, only counted as hidden.
const PARSE_LIMIT = 2_000_000

/**
 * A child session's first message carries the parent's tools and harness state as JSON between these tags
 * (packages/core/src/tool/subagent.ts). The dashboard folds that block to one line and shows it literally
 * when tool output is expanded; the rest of the message is unchanged.
 */
export function foldParentContext(text: string, expanded: boolean) {
  const open = text.indexOf(OPEN)
  const close = open < 0 ? -1 : text.indexOf(CLOSE, open + OPEN.length)
  if (close < 0) return display(text)
  const body = text.slice(open + OPEN.length, close).trim()
  const shown = expanded ? `Parent session context\n${literal(display(body))}` : summary(body)
  return [display(text.slice(0, open)).trimEnd(), shown, display(text.slice(close + CLOSE.length)).trim()]
    .filter(Boolean)
    .join("\n\n")
}

function summary(body: string) {
  const count = toolCount(body)
  const tools = count === undefined ? "" : `: ${count} tool${count === 1 ? "" : "s"}`
  return `Parent session context${tools} (hidden; Ctrl+O shows it)`
}

function toolCount(body: string) {
  if (body.length > PARSE_LIMIT) return undefined
  try {
    const value: unknown = JSON.parse(body)
    return typeof value === "object" && value !== null && "tools" in value && Array.isArray(value.tools)
      ? value.tools.length
      : undefined
  } catch {
    return undefined
  }
}
