import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@turenlabs/sdk/v2/client"
import { estimateSessionContextBreakdown } from "./session-context-breakdown"

const user = (id: string) => {
  return {
    id,
    role: "user",
    time: { created: 1 },
  } as unknown as Message
}

const assistant = (id: string) => {
  return {
    id,
    role: "assistant",
    time: { created: 1 },
  } as unknown as Message
}

describe("estimateSessionContextBreakdown", () => {
  test("estimates tokens and keeps remaining tokens as other", () => {
    const messages = [user("u1"), assistant("a1")]
    const parts = {
      u1: [{ type: "text", text: "hello world" }] as unknown as Part[],
      a1: [{ type: "text", text: "assistant response" }] as unknown as Part[],
    }

    const output = estimateSessionContextBreakdown({
      messages,
      parts,
      input: 20,
      systemPrompt: "system prompt",
    })

    const map = Object.fromEntries(output.map((segment) => [segment.key, segment.tokens]))
    expect(map.system).toBe(4)
    expect(map.user).toBe(3)
    expect(map.assistant).toBe(5)
    expect(map.other).toBe(8)
  })

  // A compaction replaces everything before it with a summary, so the pre-compaction
  // transcript is exactly what the model stopped being sent. Counting it kept the
  // breakdown pinned to the discarded history and starved "Other" — the bucket that
  // holds tool definitions and system overhead — down to nothing.
  test("counts only the transcript from the last compaction onward", () => {
    const messages = [user("u1"), assistant("a1"), user("u2"), assistant("a2")]
    const parts = {
      u1: [{ type: "text", text: "x".repeat(4000) }] as unknown as Part[],
      a1: [{ type: "text", text: "y".repeat(4000) }] as unknown as Part[],
      u2: [{ type: "compaction", auto: true }] as unknown as Part[],
      a2: [{ type: "text", text: "z".repeat(40) }] as unknown as Part[],
    }

    const output = estimateSessionContextBreakdown({ messages, parts, input: 100 })

    const map = Object.fromEntries(output.map((segment) => [segment.key, segment.tokens]))
    expect(map.user).toBeUndefined()
    expect(map.assistant).toBe(10)
    // The 2,000 pre-compaction tokens are gone, so the remainder is real headroom
    // rather than a scaled-away zero.
    expect(map.other).toBe(90)
  })

  test("scales segments when estimates exceed input", () => {
    const messages = [user("u1"), assistant("a1")]
    const parts = {
      u1: [{ type: "text", text: "x".repeat(400) }] as unknown as Part[],
      a1: [{ type: "text", text: "y".repeat(400) }] as unknown as Part[],
    }

    const output = estimateSessionContextBreakdown({
      messages,
      parts,
      input: 10,
      systemPrompt: "z".repeat(200),
    })

    const total = output.reduce((sum, segment) => sum + segment.tokens, 0)
    expect(total).toBeLessThanOrEqual(10)
    expect(output.every((segment) => segment.width <= 100)).toBeTrue()
  })
})
