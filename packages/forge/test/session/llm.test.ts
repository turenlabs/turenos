import { describe, expect, test } from "bun:test"
import { PermissionV1 } from "@turenlabs/core/v1/permission"
import type { ModelMessage } from "ai"
import { Effect } from "effect"
import { LLM } from "../../src/session/llm"
import { LLMAISDK } from "@/session/llm/ai-sdk"

describe("session.llm.hasToolCalls", () => {
  test("distinguishes text-only history from tool activity", () => {
    const text: ModelMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
    ]
    const toolCall = [
      ...text,
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-123", toolName: "bash", input: {} }],
      },
    ] as ModelMessage[]
    const toolResult = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-123",
            toolName: "bash",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ] as ModelMessage[]

    expect(LLM.hasToolCalls([])).toBe(false)
    expect(LLM.hasToolCalls(text)).toBe(false)
    expect(LLM.hasToolCalls(toolCall)).toBe(true)
    expect(LLM.hasToolCalls(toolResult)).toBe(true)
  })
})

describe("session.llm.ai-sdk adapter", () => {
  type AdapterEvent = Parameters<typeof LLMAISDK.toLLMEvents>[1]
  const unchecked = (input: unknown) => input as AdapterEvent

  test("creates stable block ids when the provider omits them", async () => {
    const state = LLMAISDK.adapterState()
    const events = (
      await Effect.runPromise(
        Effect.forEach(
          [
            unchecked({ type: "text-delta", text: "implicit text" }),
            unchecked({ type: "text-end" }),
            unchecked({ type: "reasoning-delta", text: "implicit reasoning" }),
            unchecked({ type: "reasoning-end" }),
          ],
          (event) => LLMAISDK.toLLMEvents(state, event),
        ),
      )
    ).flat()

    expect(events).toMatchObject([
      { type: "text-delta", id: "text-0", text: "implicit text" },
      { type: "text-end", id: "text-0" },
      { type: "reasoning-delta", id: "reasoning-0", text: "implicit reasoning" },
      { type: "reasoning-end", id: "reasoning-0" },
    ])
  })

  test("preserves typed tool failure causes", async () => {
    const error = new PermissionV1.RejectedError()
    const events = await Effect.runPromise(
      LLMAISDK.toLLMEvents(LLMAISDK.adapterState(), {
        type: "tool-error",
        toolCallId: "call-123",
        toolName: "bash",
        input: {},
        error,
      }),
    )

    expect(events).toEqual([
      expect.objectContaining({
        type: "tool-error",
        id: "call-123",
        name: "bash",
        message: error.message,
        error,
      }),
    ])
  })
})
