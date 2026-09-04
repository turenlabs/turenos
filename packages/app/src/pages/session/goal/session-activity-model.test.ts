import { describe, expect, test } from "bun:test"
import type { Message, ToolPart } from "@turenlabs/sdk/v2"
import { groupSessionActivity, sessionActivityKind } from "./session-activity-model"

const message = { id: "assistant", parentID: "user", time: { created: 1 } } as Message
const call = (id: string, tool: string, status: ToolPart["state"]["status"] = "completed", input = {}) => ({
  id,
  message,
  part: {
    id,
    callID: id,
    tool,
    type: "tool",
    state:
      status === "completed"
        ? { status, input, output: "ok", title: "", metadata: {}, time: { start: 1, end: 3 } }
        : { status: "error" as const, input, error: "failed", time: { start: 1, end: 2 } },
  } as ToolPart,
})

describe("session activity model", () => {
  test("groups consecutive low-risk reads while retaining immutable calls", () => {
    const groups = groupSessionActivity([call("c1", "grep"), call("c2", "read")])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ id: "c1", kind: "context", duration: 4, detail: "2 read-only calls" })
    expect(groups[0]?.calls.map((item) => item.part.callID)).toEqual(["c1", "c2"])
  })

  test("keeps failures isolated and classifies consequential activity", () => {
    const groups = groupSessionActivity([
      call("c1", "read"),
      call("c2", "read", "error"),
      call("c3", "bash", "completed", { command: "rm old.txt" }),
    ])
    expect(groups.map((group) => [group.kind, group.status])).toEqual([
      ["context", "completed"],
      ["context", "error"],
      ["destructive", "completed"],
    ])
    expect(sessionActivityKind(call("test", "bash", "completed", { command: "bun test" }).part)).toBe("verify")
    expect(sessionActivityKind(call("fetch", "bash", "completed", { command: "curl https://example.com" }).part)).toBe(
      "network",
    )
  })

  test("collects changed paths from writes and patches", () => {
    const groups = groupSessionActivity([
      call("c1", "write", "completed", { path: "src/a.ts" }),
      call("c2", "apply_patch", "completed", { patchText: "*** Update File: src/b.ts\n" }),
    ])
    expect(groups[0]?.paths).toEqual(["src/a.ts", "src/b.ts"])
  })

  test("keeps groups within one user turn and includes verification counts", () => {
    const secondMessage = { ...message, parentID: "other" } as Message
    const second = { ...call("c2", "read"), message: secondMessage }
    expect(groupSessionActivity([call("c1", "read"), second])).toHaveLength(2)

    const verification = call("c3", "bash", "completed", { command: "bun test" })
    if (verification.part.state.status === "completed") verification.part.state.output = "42 pass\n0 fail"
    expect(groupSessionActivity([verification])[0]).toMatchObject({
      title: "Verification passed",
      detail: "bun test · 42 tests",
    })
  })
})
