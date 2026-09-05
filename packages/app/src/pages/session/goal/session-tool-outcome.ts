import type { ToolPart } from "@turenlabs/sdk/v2"

/** Tool completion acknowledges execution; a shell command has a separate outcome. */
export function sessionToolOutcome(part: ToolPart) {
  if (part.state.status === "error") return "failure"
  if (part.state.status !== "completed") return
  if (part.tool !== "bash") return "success"

  const structured = part.state.metadata.structured
  const result = structured && typeof structured === "object" ? structured : part.state.metadata
  if ("timeout" in result && result.timeout === true) return "failure"
  if (!("exit" in result) || typeof result.exit !== "number" || !Number.isFinite(result.exit)) return "unknown"
  return result.exit === 0 ? "success" : "failure"
}
