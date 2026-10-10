import { describe, expect, test } from "bun:test"
import { cleanPrediction, predictionConversation } from "../src/session/prediction"
import type { SessionMessage } from "../src/session/message"

describe("composer predictions", () => {
  test("cleans reasoning and quotes and rejects oversized drafts", () => {
    expect(cleanPrediction('<think>private reasoning</think>\n"run the tests"')).toBe("run the tests")
    expect(cleanPrediction("<think>unfinished")).toBe("")
    expect(cleanPrediction("a".repeat(501))).toBe("")
    expect(cleanPrediction("  ")).toBe("")
  })

  test("uses user style and assistant text, not tool output or synthetic inputs", () => {
    const messages = [
      { type: "user", text: "keep it short", source: "user" },
      { type: "user", text: "subagent result", source: "subagent_settle" },
      { type: "synthetic", text: "internal instructions" },
      {
        type: "assistant",
        content: [
          { type: "reasoning", text: "private reasoning" },
          { type: "tool", name: "read", state: { content: "sensitive file" } },
          { type: "text", text: "The change is ready." },
        ],
      },
    ] as unknown as SessionMessage.Message[]
    expect(predictionConversation(messages)).toEqual([
      { role: "user", text: "keep it short" },
      { role: "assistant", text: "The change is ready." },
    ])
  })

  test("bounds conversation and includes legacy user messages", () => {
    const messages = Array.from({ length: 20 }, () => ({
      type: "user",
      text: "a".repeat(3000),
    })) as SessionMessage.Message[]
    const result = predictionConversation(messages)
    expect(result).toHaveLength(12)
    expect(result.every((item) => item.text.length === 2000)).toBe(true)
  })
})
