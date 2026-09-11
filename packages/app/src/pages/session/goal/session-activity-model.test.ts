import { describe, expect, test } from "bun:test"
import type { Message, ToolPart } from "@turenlabs/sdk/v2"
import { groupSessionActivity, sessionActivityKind } from "./session-activity-model"

const message = { id: "assistant", parentID: "user", time: { created: 1 } } as Message
const call = (
  id: string,
  tool: string,
  status: ToolPart["state"]["status"] = "completed",
  input = {},
  error = "failed",
) => ({
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
        : { status: "error" as const, input, error, time: { start: 1, end: 2 } },
  } as ToolPart,
})

describe("session activity model", () => {
  test("groups consecutive low-risk reads while retaining immutable calls", () => {
    const groups = groupSessionActivity([call("c1", "grep"), call("c2", "read")])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ id: "c1", kind: "context", duration: 4, detail: "2 context calls" })
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

  test("collapses a run of identical rejections into one failure group", () => {
    const groups = groupSessionActivity([
      call("c1", "read"),
      ...Array.from({ length: 4 }, (_, index) =>
        call(`f${index}`, "bash", "error", {}, "Session active shell job limit reached"),
      ),
      call("c2", "bash", "error", {}, "disk full"),
    ])
    expect(groups).toHaveLength(3)
    expect(groups[1]?.calls.map((item) => item.part.callID)).toEqual(["f0", "f1", "f2", "f3"])
    expect(groups[1]?.detail).toBe("Session active shell job limit reached")
    expect(groups[2]?.calls).toHaveLength(1)
  })

  test("collects changed paths from writes and patches", () => {
    const groups = groupSessionActivity([
      call("c1", "write", "completed", { path: "src/a.ts" }),
      call("c2", "apply_patch", "completed", { patchText: "*** Update File: src/b.ts\n" }),
    ])
    expect(groups[0]?.paths).toEqual(["src/a.ts", "src/b.ts"])
  })

  test("keeps groups within one user turn and requires command outcome evidence", () => {
    const secondMessage = { ...message, parentID: "other" } as Message
    const second = { ...call("c2", "read"), message: secondMessage }
    expect(groupSessionActivity([call("c1", "read"), second])).toHaveLength(2)

    const verification = call("c3", "bash", "completed", { command: "bun test" })
    if (verification.part.state.status === "completed") {
      verification.part.state.output = "42 pass\n0 fail"
      verification.part.state.metadata = { structured: { exit: 0 } }
    }
    expect(groupSessionActivity([verification])[0]).toMatchObject({
      title: "Verification passed",
      detail: "bun test",
      outcome: "success",
    })
  })

  test.each([
    ["failed", { structured: { exit: 1 } }, "error", "failure", "Verification failed"],
    ["timed out", { structured: { exit: 0, timeout: true } }, "error", "failure", "Verification failed"],
    ["legacy failure", { exit: 2 }, "error", "failure", "Verification failed"],
    ["legacy success", { exit: 0 }, "completed", "success", "Verification passed"],
    ["unknown", {}, "completed", "unknown", "Verification finished"],
    ["invalid exit", { structured: { exit: "0" } }, "completed", "unknown", "Verification finished"],
  ])("presents a %s command using its outcome rather than stdout", (_, metadata, status, outcome, title) => {
    const verification = call("test", "bash", "completed", { command: "bun test" })
    if (verification.part.state.status !== "completed") throw new Error("Expected completed tool fixture")
    verification.part.state.metadata = metadata
    verification.part.state.output = "41 pass\n1 fail\nVerification passed"
    expect(groupSessionActivity([verification])[0]).toMatchObject({ status, outcome, title, detail: "bun test" })
  })

  test.each([
    ["cat test-results.txt", "other"],
    ["echo 'bun test'", "other"],
    ["rm test-results.txt", "destructive"],
    ["bun test; true", "other"],
    ["bun test || true", "other"],
    ["bun test | tee output.log", "other"],
    ["bun run test:unit", "verify"],
    ["bun test --test-name-pattern delete", "verify"],
    ["echo https://example.com", "other"],
    ["bun test $(echo --help)", "other"],
    ["CI=1 pnpm test --filter app", "verify"],
    ["cargo check", "verify"],
    ["pytest tests", "verify"],
  ] as const)("classifies the command %s conservatively", (command, kind) => {
    expect(sessionActivityKind(call("test", "bash", "completed", { command }).part)).toBe(kind)
  })

  test("surfaces failure for non-verification shell commands too", () => {
    const shell = call("shell", "bash", "completed", { command: "ls missing-directory" })
    if (shell.part.state.status !== "completed") throw new Error("Expected completed tool fixture")
    shell.part.state.metadata = { structured: { exit: 1 } }
    expect(groupSessionActivity([shell])[0]).toMatchObject({ kind: "other", status: "error", outcome: "failure" })
  })

  test("groups routine state tools without calling them read-only", () => {
    const groups = groupSessionActivity([call("reflection", "reflection_state"), call("read", "read")])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ title: "Updated context", detail: "2 context calls" })
    expect(groups[0]?.calls).toHaveLength(2)
  })
})
