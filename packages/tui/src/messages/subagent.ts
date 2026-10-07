import { display, toolResult } from "../messages"
import { codeSpan, literal } from "./literal"
import type { Collapse } from "./collapse"
import type { ToolPart } from "./tool"

const SPAWN_TOOLS = ["spawn_agent", "spawn_agents"]

const field = (value: unknown, limit: number) =>
  typeof value === "string" ? display(value, limit).replace(/\s+/g, " ").trim() : ""

/**
 * What a spawn tool started, as one line per subagent. The model sees the JSON result, but the tool's
 * content is empty, so the reader would see nothing; an unrecognised shape is shown literally instead.
 */
export function startedAgents(part: ToolPart, view: Collapse) {
  const state = part.state
  if (!SPAWN_TOOLS.includes(part.name) || state.status !== "completed") return undefined
  const structured: Record<string, unknown> = state.structured ?? {}
  if (!Object.keys(structured).length) return undefined
  const tasks = Array.isArray(structured.results) ? structured.results : [structured]
  const lines = tasks.map((item) => (typeof item === "object" && item !== null ? agentLine(item) : undefined))
  if (!lines.length || lines.some((line) => !line)) return literal(toolResult(JSON.stringify(structured)), view)
  return lines.join("\n")
}

function agentLine(item: object) {
  if ("error" in item && typeof item.error === "string")
    return `Could not start a subagent: ${codeSpan(field(item.error, 300))}`
  const task = "task" in item && typeof item.task === "object" && item.task !== null ? item.task : undefined
  if (!task) return undefined
  const agent = "agent" in task ? field(task.agent, 60) : ""
  const id = "task_id" in task ? field(task.task_id, 80) : ""
  const session = "session_id" in task ? field(task.session_id, 80) : ""
  const status = "status" in task ? field(task.status, 20) : ""
  if (!agent || !id || !session) return undefined
  return `Started ${agent} subagent · task ${codeSpan(id)} · session ${codeSpan(session)}${status ? ` · ${status}` : ""}`
}
