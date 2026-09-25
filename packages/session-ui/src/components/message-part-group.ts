import type { Part, ToolPart } from "@turenlabs/sdk/v2"

const CONTEXT_GROUP_TOOLS = new Set(["read", "glob", "grep", "list", "bash"])
const COORDINATION_TOOLS = new Set([
  "reflection_read",
  "reflection_state",
  "reflection_complete",
  "board_read",
  "board_post",
  "spawn_agent",
  "send_agent",
  "wait_agents",
  "interrupt_agent",
  "list_agents",
])

export function isCoordinationTool(tool: string) {
  return COORDINATION_TOOLS.has(tool)
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
  // Failures stay in the main transcript as individual error cards, even when
  // surrounding successful tools collapse into a group.
  return (
    part.type === "tool" &&
    part.state.status !== "error" &&
    (CONTEXT_GROUP_TOOLS.has(part.tool) || isCoordinationTool(part.tool))
  )
}

export function contextToolSummary(parts: ToolPart[]) {
  const summary = { read: 0, search: 0, list: 0, shell: 0, coordination: 0 }
  parts.forEach((part) => {
    switch (part.tool) {
      case "read":
        summary.read++
        break
      case "glob":
      case "grep":
        summary.search++
        break
      case "list":
        summary.list++
        break
      case "bash":
        summary.shell++
        break
    }
    if (isCoordinationTool(part.tool)) summary.coordination++
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
