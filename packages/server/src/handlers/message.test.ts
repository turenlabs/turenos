import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import * as DateTime from "effect/DateTime"
import { ModelV2 } from "@turenlabs/core/model"
import { ProviderV2 } from "@turenlabs/core/provider"
import { SessionMessage } from "@turenlabs/core/session/message"
import { SessionMessagesQuery } from "@turenlabs/protocol/groups/message"
import { leanSessionMessage } from "./message"

const assistant = (content: SessionMessage.AssistantContent[]): SessionMessage.Assistant => ({
  type: "assistant",
  id: SessionMessage.ID.make("msg_1"),
  agent: "build",
  model: { providerID: ProviderV2.ID.make("provider"), id: ModelV2.ID.make("model") },
  content,
  time: { created: DateTime.makeUnsafe(1) },
})

const completedTool = (input: {
  text?: string
  structured?: Record<string, unknown>
  result?: unknown
  attachments?: SessionMessage.ToolStateCompleted["attachments"]
}): SessionMessage.AssistantTool => ({
  type: "tool",
  id: "prt_1",
  name: "read",
  state: {
    status: "completed",
    input: { path: "/tmp/a" },
    content: [{ type: "text", text: input.text ?? "small" }],
    structured: input.structured ?? {},
    outputPaths: ["/tmp/a"],
    ...(input.result === undefined ? {} : { result: input.result }),
    ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
  },
  time: { created: DateTime.makeUnsafe(1), ran: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
})

const large = "x".repeat(70 * 1024)

describe("leanSessionMessage", () => {
  test("leaves non-assistant messages untouched", () => {
    const user: SessionMessage.Message = {
      type: "user",
      id: SessionMessage.ID.make("msg_u"),
      text: "hi",
      time: { created: DateTime.makeUnsafe(1) },
    }
    expect(leanSessionMessage(user)).toBe(user)
  })

  test("leaves tools at or under the threshold untouched", () => {
    const message = assistant([completedTool({ text: "small", structured: { exit: 0 } })])
    expect(leanSessionMessage(message)).toBe(message)
  })

  test("replaces an oversized body with a truncated marker", () => {
    const message = assistant([completedTool({ text: large, result: { type: "text", value: large } })])
    const tool = (leanSessionMessage(message) as SessionMessage.Assistant).content[0]
    if (tool?.type !== "tool") throw new Error("expected tool")
    expect(tool.truncated?.bytes).toBeGreaterThan(70 * 1024)
    if (tool.state.status !== "completed") throw new Error("expected completed")
    expect(tool.state.content).toEqual([])
    expect(tool.state.structured).toEqual({})
    expect(tool.state.result).toBeUndefined()
    expect(tool.state.input).toEqual({ path: "/tmp/a" })
    expect(tool.state.outputPaths).toEqual(["/tmp/a"])
  })

  test("keeps a small structured record while eliding the oversized content", () => {
    const message = assistant([completedTool({ text: large, structured: { exit: 0, timeout: false } })])
    const tool = (leanSessionMessage(message) as SessionMessage.Assistant).content[0]
    if (tool?.type !== "tool" || tool.state.status !== "completed") throw new Error("expected completed tool")
    expect(tool.truncated).toBeDefined()
    expect(tool.state.content).toEqual([])
    expect(tool.state.structured).toEqual({ exit: 0, timeout: false })
  })

  test("leaves pending tools untouched", () => {
    const tool: SessionMessage.AssistantTool = {
      type: "tool",
      id: "prt_1",
      name: "read",
      state: { status: "pending", input: large },
      time: { created: DateTime.makeUnsafe(1) },
    }
    const message = assistant([tool])
    expect(leanSessionMessage(message)).toBe(message)
  })

  test("leaves running tools untouched: the streamed output is being rendered live", () => {
    const tool: SessionMessage.AssistantTool = {
      type: "tool",
      id: "prt_1",
      name: "bash",
      state: {
        status: "running",
        input: { command: "cat big.log" },
        structured: {},
        content: [{ type: "text", text: large }],
      },
      time: { created: DateTime.makeUnsafe(1), ran: DateTime.makeUnsafe(1) },
    }
    const message = assistant([tool])
    expect(leanSessionMessage(message)).toBe(message)
  })

  test("keeps the error message while eliding an oversized error body", () => {
    const tool: SessionMessage.AssistantTool = {
      type: "tool",
      id: "prt_1",
      name: "read",
      state: {
        status: "error",
        error: { type: "unknown", message: "boom" },
        input: {},
        content: [{ type: "text", text: large }],
        structured: {},
      },
      time: { created: DateTime.makeUnsafe(1), ran: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
    }
    const next = (leanSessionMessage(assistant([tool])) as SessionMessage.Assistant).content[0]
    if (next?.type !== "tool" || next.state.status !== "error") throw new Error("expected error tool")
    expect(next.truncated).toBeDefined()
    expect(next.state.error.message).toBe("boom")
    expect(next.state.content).toEqual([])
  })
})

describe("SessionMessagesQuery", () => {
  const decode = Schema.decodeUnknownSync(SessionMessagesQuery)

  test("omitted lean decodes to no flag", () => {
    expect(decode({ limit: "50" }).lean).toBeUndefined()
  })

  test("lean=true decodes to true", () => {
    expect(decode({ lean: "true" }).lean).toBe(true)
    expect(decode({ lean: "false" }).lean).toBe(false)
  })
})
