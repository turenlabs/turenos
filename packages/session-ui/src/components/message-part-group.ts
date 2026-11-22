import type { Part, ToolPart } from "@turenlabs/sdk/v2"

const READ_TOOLS = new Set(["read", "memory_read"])
const SEARCH_TOOLS = new Set(["glob", "grep", "code_search", "memory_search"])
const SHELL_TOOLS = new Set(["bash", "shell_job"])
const COORDINATION_TOOLS = new Set([
  "reflection_read",
  "reflection_state",
  "reflection_complete",
  "board_read",
  "board_post",
  "room_read",
  "room_post",
  "room_claim",
  "room_wait",
  "spawn_agent",
  "spawn_agents",
  "send_agent",
  "wait_agents",
  "interrupt_agent",
  "list_agents",
  "peek_agent",
  "notify_parent",
])

export function searchOutcome(part: ToolPart) {
  const state = part.state
  if (part.tool !== "grep") return
  if (state.status === "completed" && (state.output === "No matches found" || state.output === "No files found"))
    return "no-matches"
  if (state.status !== "error") return
  if (state.error.startsWith("Search path not found: ")) return "missing-path"
  // Older saved transcripts include the filesystem error after the original search input.
  const path = typeof state.input.path === "string" ? state.input.path : "."
  const pattern = state.input.pattern
  if (
    typeof pattern === "string" &&
    state.error.startsWith(`Unable to grep for ${pattern} in ${path}: NotFound: FileSystem.stat (`)
  )
    return "missing-path"
}

export function isContextGroupTool(part: Part): part is ToolPart {
  if (part.type === "tool" && part.tool === "bash" && part.state.status === "completed") {
    const result: unknown = part.state.metadata?.structured ?? part.state.metadata
    if (
      result &&
      typeof result === "object" &&
      (("exit" in result && typeof result.exit === "number" && result.exit !== 0) ||
        ("timeout" in result && result.timeout === true))
    )
      return false
  }
  // A missing search path is an ordinary probe outcome. Other failures stay visible.
  return (
    part.type === "tool" &&
    (part.state.status !== "error" || searchOutcome(part) === "missing-path") &&
    (READ_TOOLS.has(part.tool) ||
      SEARCH_TOOLS.has(part.tool) ||
      SHELL_TOOLS.has(part.tool) ||
      part.tool === "list" ||
      COORDINATION_TOOLS.has(part.tool))
  )
}

export function contextToolSummary(parts: ToolPart[]) {
  const summary = { read: 0, search: 0, list: 0, shell: 0, coordination: 0, missing: 0 }
  parts.forEach((part) => {
    if (READ_TOOLS.has(part.tool)) summary.read++
    if (SEARCH_TOOLS.has(part.tool)) summary.search++
    if (SHELL_TOOLS.has(part.tool)) summary.shell++
    if (part.tool === "list") summary.list++
    if (COORDINATION_TOOLS.has(part.tool)) summary.coordination++
    if (searchOutcome(part) === "missing-path") summary.missing++
  })
  return summary
}

export type PartRef = {
  messageID: string
  partID: string
}

export type PartGroup =
  | {
      key: string
      type: "part"
      ref: PartRef
    }
  | {
      key: string
      type: "context"
      refs: PartRef[]
    }
  | {
      key: string
      type: "failure"
      refs: PartRef[]
    }

function sameRef(a: PartRef, b: PartRef) {
  return a.messageID === b.messageID && a.partID === b.partID
}

function sameGroup(a: PartGroup, b: PartGroup) {
  if (a === b) return true
  if (a.key !== b.key) return false
  if (a.type !== b.type) return false
  if (a.type === "part") {
    if (b.type !== "part") return false
    return sameRef(a.ref, b.ref)
  }
  if (b.type !== "context" && b.type !== "failure") return false
  if (a.refs.length !== b.refs.length) return false
  return a.refs.every((ref, i) => sameRef(ref, b.refs[i]))
}

export function sameGroups(a: readonly PartGroup[] | undefined, b: readonly PartGroup[] | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((item, i) => sameGroup(item, b[i]))
}

const failedTool = (part: Part): part is ToolPart => part.type === "tool" && part.state.status === "error"

const failureText = (part: ToolPart) => (part.state.status === "error" ? part.state.error : undefined)

const sameFailure = (a: ToolPart, b: ToolPart) => a.tool === b.tool && failureText(a) === failureText(b)

export function groupParts(parts: { messageID: string; part: Part }[]) {
  const result: PartGroup[] = []
  let start = -1
  let failureStart = -1

  const flush = (end: number) => {
    if (start < 0) return
    const first = parts[start]
    const last = parts[end]
    if (!first || !last) {
      start = -1
      return
    }
    result.push({
      key: `context:${first.part.id}`,
      type: "context",
      refs: parts.slice(start, end + 1).map((item) => ({
        messageID: item.messageID,
        partID: item.part.id,
      })),
    })
    start = -1
  }

  // A lone failure still renders as its own card; the group exists only for a
  // retry storm of identical rejections, which are one fact shown once.
  const flushFailure = (end: number) => {
    if (failureStart < 0) return
    const first = parts[failureStart]
    if (!first) {
      failureStart = -1
      return
    }
    const refs = parts.slice(failureStart, end + 1).map((item) => ({
      messageID: item.messageID,
      partID: item.part.id,
    }))
    if (refs.length === 1) {
      result.push({ key: `part:${first.messageID}:${first.part.id}`, type: "part", ref: refs[0]! })
    } else {
      result.push({ key: `failure:${first.part.id}`, type: "failure", refs })
    }
    failureStart = -1
  }

  parts.forEach((item, index) => {
    const previous = index > 0 ? parts[index - 1] : undefined
    if (isContextGroupTool(item.part)) {
      flushFailure(index - 1)
      if (start < 0) start = index
      return
    }

    flush(index - 1)
    if (failedTool(item.part)) {
      const extendsRun = previous && failedTool(previous.part) && sameFailure(previous.part, item.part)
      if (extendsRun) {
        if (failureStart < 0) failureStart = index - 1
        return
      }
      flushFailure(index - 1)
      failureStart = index
      return
    }

    flushFailure(index - 1)
    result.push({
      key: `part:${item.messageID}:${item.part.id}`,
      type: "part",
      ref: {
        messageID: item.messageID,
        partID: item.part.id,
      },
    })
  })

  flushFailure(parts.length - 1)
  flush(parts.length - 1)
  return result
}
