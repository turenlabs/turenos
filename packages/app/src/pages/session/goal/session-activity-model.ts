import type { ToolPart } from "@turenlabs/sdk/v2"
import type { SessionLiveToolCall } from "../session-live-prototype"

export type SessionActivityKind = "context" | "write" | "verify" | "network" | "destructive" | "other"

export type SessionActivityGroup = {
  id: string
  kind: SessionActivityKind
  status: ToolPart["state"]["status"]
  title: string
  detail: string
  calls: SessionLiveToolCall[]
  duration: number
  paths: string[]
}

const toolKinds: Record<string, SessionActivityKind> = Object.fromEntries([
  ...["read", "glob", "grep", "memory_search", "memory_read", "reflection_read", "board_read", "list_agents", "get_goal"].map(
    (tool) => [tool, "context"] as const,
  ),
  ...["edit", "write", "apply_patch"].map((tool) => [tool, "write"] as const),
  ...["webfetch", "websearch", "pentest_request", "pentest_replay", "mcp_search", "mcp_load"].map(
    (tool) => [tool, "network"] as const,
  ),
  ...["interrupt_agent", "memory_forget"].map((tool) => [tool, "destructive"] as const),
])

export function sessionActivityKind(part: ToolPart): SessionActivityKind {
  const kind = toolKinds[part.tool]
  if (kind) return kind
  if (part.tool !== "bash") return "other"

  const command = stringInput(part, "command")
  if (/\b(?:curl|wget)\b|https?:\/\//i.test(command)) return "network"
  if (/\b(test|typecheck|check|lint|build)\b/i.test(command)) return "verify"
  if (/\b(rm|rmdir|git\s+(?:reset|clean)|drop|delete)\b/i.test(command)) return "destructive"
  return "other"
}

export function groupSessionActivity(calls: SessionLiveToolCall[]) {
  return calls.reduce<SessionActivityGroup[]>((groups, call) => {
    const kind = sessionActivityKind(call.part)
    const previous = groups.at(-1)
    const groupable = kind === "context" || kind === "write"
    if (
      groupable &&
      previous?.kind === kind &&
      previous.status !== "error" &&
      call.part.state.status !== "error" &&
      activityTurn(previous.calls.at(-1)!) === activityTurn(call)
    ) {
      previous.calls.push(call)
      previous.status = aggregateStatus(previous.calls)
      previous.duration = activityDuration(previous.calls)
      previous.paths = activityPaths(previous.calls)
      previous.detail = activityDetail(kind, previous.calls, previous.paths)
      return groups
    }
    const paths = activityPaths([call])
    groups.push({
      id: call.part.callID,
      kind,
      status: call.part.state.status,
      title: activityTitle(kind, call),
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
  if (calls.some((call) => call.part.state.status === "error")) return "error"
  if (calls.some((call) => call.part.state.status === "running")) return "running"
  if (calls.some((call) => call.part.state.status === "pending")) return "pending"
  return "completed"
}

function activityTitle(kind: SessionActivityKind, call: SessionLiveToolCall) {
  if (kind === "context") return "Investigated context"
  if (kind === "write") return "Changed files"
  if (kind === "verify") {
    if (call.part.state.status === "error") return "Verification failed"
    if (call.part.state.status === "completed") return "Verification passed"
    return "Verification running"
  }
  if (kind === "network") return "Network activity"
  if (kind === "destructive") return "Consequential activity"
  return call.part.tool
}

function activityDetail(kind: SessionActivityKind, calls: SessionLiveToolCall[], paths: string[]) {
  if (kind === "context") return `${calls.length} read-only ${calls.length === 1 ? "call" : "calls"}`
  if (kind === "write") return paths.length ? paths.join(", ") : `${calls.length} write ${calls.length === 1 ? "call" : "calls"}`
  if (kind === "verify") {
    const call = calls[0]!
    const command = stringInput(call.part, "command") || call.part.tool
    const count = activityOutput(call.part).match(/\b(\d+)\s+(?:pass|tests?)\b/i)?.[1]
    return count ? `${command} · ${count} tests` : command
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
