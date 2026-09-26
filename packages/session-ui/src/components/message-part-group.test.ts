import { expect, test } from "bun:test"
import type { Part, ToolPart } from "@turenlabs/sdk/v2"
import { contextToolSummary, groupParts, sameGroups } from "./message-part-group"

function tool(
  id: string,
  name: string,
  status: "completed" | "running" | "error" = "completed",
  error = "Permission denied",
) {
  return {
    messageID: "assistant-1",
    part: {
      id,
      messageID: "assistant-1",
      sessionID: "session-1",
      type: "tool",
      callID: id,
      tool: name,
      state:
        status === "error"
          ? { status, input: {}, error, time: { start: 1, end: 2 } }
          : status === "running"
            ? { status, input: {}, time: { start: 1 } }
            : { status, input: {}, output: "raw result", metadata: {}, title: name, time: { start: 1, end: 2 } },
    } satisfies ToolPart,
  }
}

test("a long run of reads and routine coordination stays one expandable group with every original reference", () => {
  const names = [
    "read",
    "glob",
    "bash",
    "reflection_read",
    "reflection_state",
    "board_read",
    "board_post",
    "reflection_complete",
    "spawn_agent",
    "send_agent",
    "wait_agents",
  ]
  const parts = Array.from({ length: 700 }, (_, index) => tool(`part-${index}`, names[index % names.length]))
  const groups = groupParts(parts)
  expect(groups).toHaveLength(1)
  expect(groups[0]).toEqual({
    key: "context:part-0",
    type: "context",
    refs: parts.map((item) => ({ messageID: item.messageID, partID: item.part.id })),
  })
})

test("failed reads and coordination are individual error rows between routine groups", () => {
  for (const name of ["read", "bash", "reflection_state", "board_post"]) {
    const groups = groupParts([tool("before", "read"), tool("failure", name, "error"), tool("after", "board_read")])
    expect(groups.map((group) => group.type)).toEqual(["context", "part", "context"])
    expect(groups[1]).toEqual({
      key: "part:assistant-1:failure",
      type: "part",
      ref: { messageID: "assistant-1", partID: "failure" },
    })
  }
})

test("a run of identical tool rejections collapses into one failure group", () => {
  const parts = [
    tool("before", "read"),
    ...Array.from({ length: 5 }, (_, index) => tool(`fail-${index}`, "bash", "error", "Session active shell job limit reached")),
    tool("after", "read"),
  ]
  const groups = groupParts(parts)
  expect(groups.map((group) => group.type)).toEqual(["context", "failure", "context"])
  expect(groups[1]).toEqual({
    key: "failure:fail-0",
    type: "failure",
    refs: parts.slice(1, 6).map((item) => ({ messageID: item.messageID, partID: item.part.id })),
  })
})

test("failures only group when tool and error both match", () => {
  const groups = groupParts([
    tool("a", "bash", "error", "limit reached"),
    tool("b", "read", "error", "limit reached"),
    tool("c", "bash", "error", "different error"),
    tool("d", "bash", "error", "different error"),
  ])
  expect(groups.map((group) => group.type)).toEqual(["part", "part", "failure"])
  expect(groups[2]?.type === "failure" ? groups[2].refs.map((ref) => ref.partID) : []).toEqual(["c", "d"])
})

test("a failing running tool leaves its quiet group instead of hiding the error", () => {
  const running = groupParts([tool("read", "read"), tool("state", "reflection_state", "running")])
  const failed = groupParts([tool("read", "read"), tool("state", "reflection_state", "error")])
  expect(sameGroups(running, failed)).toBe(false)
  expect(failed.map((group) => group.type)).toEqual(["context", "part"])
})

test("questions, writes, and unknown tools are never quieted by a name substring", () => {
  const parts = ["question", "write", "custom_bash", "custom_reflection_state", "board_post_external"].map((name) =>
    tool(name, name),
  )
  expect(groupParts(parts).every((group) => group.type === "part")).toBe(true)
})

test("shell commands share a counted group with reads and running tools", () => {
  const parts = [tool("shell-1", "bash"), tool("read", "read"), tool("shell-2", "bash", "running")]
  expect(groupParts(parts)).toEqual([
    {
      key: "context:shell-1",
      type: "context",
      refs: parts.map((item) => ({ messageID: item.messageID, partID: item.part.id })),
    },
  ])
  expect(contextToolSummary(parts.map((item) => item.part))).toEqual({
    read: 1,
    search: 0,
    list: 0,
    shell: 2,
    coordination: 0,
  })
})

test("agent operations are counted as session activity", () => {
  const parts = [tool("spawn", "spawn_agent"), tool("send", "send_agent"), tool("wait", "wait_agents")]
  expect(groupParts(parts)).toEqual([
    {
      key: "context:spawn",
      type: "context",
      refs: parts.map((item) => ({ messageID: item.messageID, partID: item.part.id })),
    },
  ])
  expect(contextToolSummary(parts.map((item) => item.part))).toEqual({
    read: 0,
    search: 0,
    list: 0,
    shell: 0,
    coordination: 3,
  })
})

test("context tool summaries count each category independently", () => {
  const parts = [
    tool("read", "read"),
    tool("glob", "glob"),
    tool("grep", "grep"),
    tool("list", "list"),
    tool("bash", "bash"),
    tool("coordination-read", "reflection_read"),
    tool("coordination-agent", "spawn_agent"),
    tool("write", "write"),
  ]
  expect(contextToolSummary(parts.map((item) => item.part))).toEqual({
    read: 1,
    search: 2,
    list: 1,
    shell: 1,
    coordination: 2,
  })
})

test("context tool summaries skip sparse slots", () => {
  const parts = new Array<ToolPart>(2)
  parts[1] = tool("read", "read").part
  expect(contextToolSummary(parts)).toEqual({
    read: 1,
    search: 0,
    list: 0,
    shell: 0,
    coordination: 0,
  })
})

test("completed shell results with nonzero exits or timeouts remain visible", () => {
  for (const metadata of [{ structured: { exit: 1 } }, { exit: 2 }, { structured: { timeout: true } }]) {
    const shell = tool("shell", "bash")
    if (shell.part.state.status !== "completed") throw new Error("Expected completed fixture")
    shell.part.state.metadata = metadata
    expect(groupParts([tool("before", "read"), shell, tool("after", "read")]).map((group) => group.type)).toEqual([
      "context",
      "part",
      "context",
    ])
  }
})

test("assistant prose and message references remain in order around coordination groups", () => {
  const text = {
    id: "text",
    messageID: "assistant-2",
    sessionID: "session-1",
    type: "text",
    text: "I need your decision.",
  } satisfies Part
  const groups = groupParts([
    tool("before", "board_read"),
    { messageID: "assistant-2", part: text },
    tool("after", "reflection_state"),
  ])
  expect(groups.map((group) => group.key)).toEqual(["context:before", "part:assistant-2:text", "context:after"])
  expect(
    sameGroups(
      groups,
      groupParts([
        tool("before", "board_read"),
        { messageID: "assistant-2", part: text },
        tool("after", "reflection_state"),
      ]),
    ),
  ).toBe(true)
})
