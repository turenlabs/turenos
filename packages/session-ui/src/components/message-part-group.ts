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
  const read = parts.filter((part) => part.tool === "read").length
  const search = parts.filter((part) => part.tool === "glob" || part.tool === "grep").length
  const list = parts.filter((part) => part.tool === "list").length
  const shell = parts.filter((part) => part.tool === "bash").length
  const coordination = parts.filter((part) => isCoordinationTool(part.tool)).length
  return { read, search, list, shell, coordination }
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
  if (b.type !== "context") return false
  if (a.refs.length !== b.refs.length) return false
  return a.refs.every((ref, i) => sameRef(ref, b.refs[i]))
}

export function sameGroups(a: readonly PartGroup[] | undefined, b: readonly PartGroup[] | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((item, i) => sameGroup(item, b[i]))
}

export function groupParts(parts: { messageID: string; part: Part }[]) {
  const result: PartGroup[] = []
  let start = -1

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

  parts.forEach((item, index) => {
    if (isContextGroupTool(item.part)) {
      if (start < 0) start = index
      return
    }

    flush(index - 1)
    result.push({
      key: `part:${item.messageID}:${item.part.id}`,
      type: "part",
      ref: {
        messageID: item.messageID,
        partID: item.part.id,
      },
    })
  })

  flush(parts.length - 1)
  return result
}
