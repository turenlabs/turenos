import { describe, expect, test } from "bun:test"
import type { Message } from "@turenlabs/sdk/v2/client"
import { getSessionContext } from "./session-context-metrics"

const assistant = (
  id: string,
  tokens: { input: number; output: number; reasoning: number; read: number; write: number },
  cost: number,
  providerID = "openai",
  modelID = "gpt-4.1",
) => {
  return {
    id,
    role: "assistant",
    providerID,
    modelID,
    cost,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cache: {
        read: tokens.read,
        write: tokens.write,
      },
    },
    time: { created: 1 },
  } as unknown as Message
}

const user = (id: string) => {
  return {
    id,
    role: "user",
    cost: 0,
    time: { created: 1 },
  } as unknown as Message
}

describe("getSessionContext", () => {
  test("computes token totals and usage from latest assistant with tokens", () => {
    const messages = [
      user("u1"),
      assistant("a1", { input: 600, output: 200, reasoning: 100, read: 50, write: 50 }, 0.5),
      assistant("a2", { input: 300, output: 100, reasoning: 50, read: 25, write: 25 }, 1.25),
    ]
    const providers = [
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-4.1": {
            name: "GPT-4.1",
            limit: { context: 1000 },
          },
        },
      },
    ]

    const ctx = getSessionContext(messages, providers)

    expect(ctx?.message.id).toBe("a2")
    expect(ctx?.total).toBe(500)
    expect(ctx?.prompt).toBe(350)
    expect(ctx?.input).toBe(300)
    expect(ctx?.usage).toBe(50)
    expect(ctx?.providerLabel).toBe("OpenAI")
    expect(ctx?.modelLabel).toBe("GPT-4.1")
  })

  // Cached prompt tokens still occupy the window; they are only billed differently.
  // Reading occupancy off `tokens.input` alone reports 2 tokens for a Claude Code turn
  // whose prompt is 24,364.
  test("counts cache read and write as part of the prompt", () => {
    const messages = [assistant("a1", { input: 2, output: 7, reasoning: 0, read: 24081, write: 281 }, 0)]
    const providers = [{ id: "openai", models: { "gpt-4.1": { limit: { context: 200_000 } } } }]

    const ctx = getSessionContext(messages, providers)

    expect(ctx?.prompt).toBe(24364)
    expect(ctx?.total).toBe(24371)
    expect(ctx?.usage).toBe(12)
  })

  // The defect this replaced summed every request in the session, so cache reads —
  // re-counted on every tool round trip — drove a real session to 1,644,876 tokens and
  // "822%" of a 200,000 limit. A running total can only grow, so compaction, the one
  // thing that genuinely frees the window, could never show up. Occupancy is a property
  // of the newest request, so it falls the moment a compacted turn reports in.
  test("falls after a compaction shrinks the next request", () => {
    const before = [assistant("a1", { input: 310, output: 12861, reasoning: 0, read: 180000, write: 5000 }, 0)]
    const providers = [{ id: "openai", models: { "gpt-4.1": { limit: { context: 200_000 } } } }]
    const compacted = [...before, assistant("a2", { input: 40, output: 300, reasoning: 0, read: 21000, write: 900 }, 0)]

    const full = getSessionContext(before, providers)
    const after = getSessionContext(compacted, providers)

    expect(full?.usage).toBe(99)
    expect(after?.usage).toBe(11)
    expect(after!.total).toBeLessThan(full!.total)
  })

  test("preserves fallback labels and null usage when model metadata is missing", () => {
    const messages = [assistant("a1", { input: 40, output: 10, reasoning: 0, read: 0, write: 0 }, 0.1, "p-1", "m-1")]
    const providers = [{ id: "p-1", models: {} }]

    const ctx = getSessionContext(messages, providers)

    expect(ctx?.providerLabel).toBe("p-1")
    expect(ctx?.modelLabel).toBe("m-1")
    expect(ctx?.limit).toBeUndefined()
    expect(ctx?.usage).toBeNull()
  })

  test("recomputes when message array is mutated in place", () => {
    const messages = [assistant("a1", { input: 10, output: 10, reasoning: 10, read: 10, write: 10 }, 0.25)]
    const providers = [{ id: "openai", models: {} }]

    const one = getSessionContext(messages, providers)
    messages.push(assistant("a2", { input: 100, output: 20, reasoning: 0, read: 0, write: 0 }, 0.75))
    const two = getSessionContext(messages, providers)

    expect(one?.message.id).toBe("a1")
    expect(two?.message.id).toBe("a2")
  })

  test("returns undefined when inputs are undefined", () => {
    const ctx = getSessionContext(undefined, undefined)

    expect(ctx).toBeUndefined()
  })
})
