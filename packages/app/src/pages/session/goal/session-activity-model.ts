import type { ToolPart } from "@turenlabs/sdk/v2"
import type { SessionLiveToolCall } from "../session-live-prototype"
import { sessionToolOutcome } from "./session-tool-outcome"

export type SessionActivityKind = "context" | "write" | "verify" | "network" | "destructive" | "other"

export type SessionActivityGroup = {
  id: string
  kind: SessionActivityKind
  status: ToolPart["state"]["status"]
  outcome?: ReturnType<typeof sessionToolOutcome>
  title: string
  detail: string
  calls: SessionLiveToolCall[]
  duration: number
  paths: string[]
}

const toolKinds: Record<string, SessionActivityKind> = Object.fromEntries([
  ...[
    "read",
    "glob",
    "grep",
    "memory_search",
    "memory_read",
    "reflection_read",
    "reflection_state",
    "room_read",
    "board_read",
    "list_agents",
    "get_goal",
  ].map((tool) => [tool, "context"] as const),
  ...["edit", "write", "apply_patch"].map((tool) => [tool, "write"] as const),
  ...["webfetch", "websearch", "mcp_search", "mcp_load"].map(
    (tool) => [tool, "network"] as const,
  ),
  ...["interrupt_agent", "memory_forget"].map((tool) => [tool, "destructive"] as const),
])

export function sessionActivityKind(part: ToolPart): SessionActivityKind {
  const kind = toolKinds[part.tool]
  if (kind) return kind
  if (part.tool !== "bash") return "other"

  const command = stringInput(part, "command")
    .trim()
    .replace(/^(?:\w+=[\w./:-]+\s+)*/, "")
  // A command name inside an argument or a compound shell expression is not evidence
  // that verification ran. Leave wrappers/pipelines neutral instead of guessing.
  if (/[;&|`\n<>]|\$\(/.test(command)) return "other"
  if (/^(?:curl|wget)(?=\s|$)/.test(command)) return "network"
  if (/^(?:rm|rmdir|git\s+(?:reset|clean)|drop|delete)(?=\s|$)/.test(command)) return "destructive"
  if (
    /^(?:(?:bun|npm|pnpm|yarn)(?:\s+run)?\s+(?:test(?::[\w-]+)?|typecheck|check|lint|build)|(?:cargo|go|dotnet)\s+(?:test|check|build)|(?:pytest|vitest|jest|tsc|eslint)|ruff\s+check)(?=\s|$)/.test(
      command,
    )
  )
    return "verify"
  return "other"
}

export function groupSessionActivity(calls: SessionLiveToolCall[]) {
  return calls.reduce<SessionActivityGroup[]>((groups, call) => {
    const kind = sessionActivityKind(call.part)
    const previous = groups.at(-1)
    const groupable = kind === "context" || kind === "write"
    // A retry storm of identical rejections is one fact: same tool, same error,
    // same turn. Distinct failures still get their own rows.
    if (
      previous !== undefined &&
      previous.status === "error" &&
      activityStatus(call.part) === "error" &&
      previous.calls.at(-1)!.part.tool === call.part.tool &&
      activityOutput(previous.calls.at(-1)!.part) === activityOutput(call.part) &&
      activityTurn(previous.calls.at(-1)!) === activityTurn(call)
    ) {
      previous.calls.push(call)
      previous.duration = activityDuration(previous.calls)
      previous.detail = activityOutput(call.part)
      return groups
    }
    if (
      groupable &&
      previous?.kind === kind &&
      previous.status !== "error" &&
      activityStatus(call.part) !== "error" &&
      activityTurn(previous.calls.at(-1)!) === activityTurn(call)
    ) {
      previous.calls.push(call)
      previous.status = aggregateStatus(previous.calls)
      previous.outcome = previous.status === "completed" ? "success" : undefined
      previous.title = activityTitle(kind, previous.status, previous.outcome)
      previous.duration = activityDuration(previous.calls)
      previous.paths = activityPaths(previous.calls)
      previous.detail = activityDetail(kind, previous.calls, previous.paths)
      return groups
    }
    const paths = activityPaths([call])
    groups.push({
      id: call.part.callID,
      kind,
      status: activityStatus(call.part),
      outcome: sessionToolOutcome(call.part),
      title: activityTitle(kind, activityStatus(call.part), sessionToolOutcome(call.part), call.part.tool),
      detail: activityDetail(kind, [call], paths),
      calls: [call],
      duration: activityDuration([call]),
      paths,
    })
    return groups
  }, [])
}

export function activityDuration(calls: SessionLiveToolCall[]) {
  return calls.reduce((total, call) => {
    const time = "time" in call.part.state ? call.part.state.time : undefined
    const start = typeof time?.start === "number" ? time.start : undefined
    const end = time && "end" in time && typeof time.end === "number" ? time.end : undefined
    if (start === undefined || end === undefined) return total
    return total + Math.max(0, end - start)
  }, 0)
}

function activityTurn(call: SessionLiveToolCall) {
  return "parentID" in call.message ? call.message.parentID : call.message.id
}

export function activityOutput(part: ToolPart) {
  if (part.state.status === "completed") return part.state.output
  if (part.state.status === "error") return part.state.error
  return ""
}

function aggregateStatus(calls: SessionLiveToolCall[]): ToolPart["state"]["status"] {
  if (calls.some((call) => activityStatus(call.part) === "error")) return "error"
  if (calls.some((call) => call.part.state.status === "running")) return "running"
  if (calls.some((call) => call.part.state.status === "pending")) return "pending"
  return "completed"
}

function activityStatus(part: ToolPart): ToolPart["state"]["status"] {
  return sessionToolOutcome(part) === "failure" ? "error" : part.state.status
}

function activityTitle(
  kind: SessionActivityKind,
  status: ToolPart["state"]["status"],
  outcome: ReturnType<typeof sessionToolOutcome>,
  tool = "Tool",
) {
  if (kind === "context") {
    if (status === "error") return "Context update failed"
    return status === "completed" ? "Updated context" : "Updating context"
  }
  if (kind === "write") {
    if (status === "error") return "File change failed"
    return status === "completed" ? "Changed files" : "Changing files"
  }
  if (kind === "verify") {
    if (outcome === "failure") return "Verification failed"
    if (outcome === "success") return "Verification passed"
    if (status === "completed") return "Verification finished"
    return status === "pending" ? "Verification pending" : "Verification running"
  }
  if (kind === "network") return "Network activity"
  if (kind === "destructive") return "Consequential activity"
  return tool
}

function activityDetail(kind: SessionActivityKind, calls: SessionLiveToolCall[], paths: string[]) {
  if (kind === "context") return `${calls.length} context ${calls.length === 1 ? "call" : "calls"}`
  if (kind === "write")
    return paths.length ? paths.join(", ") : `${calls.length} write ${calls.length === 1 ? "call" : "calls"}`
  if (kind === "verify") {
    const call = calls[0]!
    const command = stringInput(call.part, "command") || call.part.tool
    return command
  }
  if (kind === "network") return `${calls.length} network ${calls.length === 1 ? "request" : "requests"}`
  return calls.length === 1 ? calls[0]!.part.tool : `${calls.length} calls`
}

function activityPaths(calls: SessionLiveToolCall[]) {
  return [
    ...new Set(
      calls.flatMap((call) => {
        const path = call.part.state.input.path
        if (typeof path === "string") return [path]
        const patch = call.part.state.input.patchText
        if (typeof patch !== "string") return []
        return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1])
      }),
    ),
  ]
}

function stringInput(part: ToolPart, key: string) {
  const value = part.state.input[key]
  return typeof value === "string" ? value : ""
}
