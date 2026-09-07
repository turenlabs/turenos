import { describe, expect, test } from "bun:test"
import { chatTurns, type ChatSourceMessage } from "./run-chat"

const user = (text: string): ChatSourceMessage => ({ type: "user", text, time: { created: 1_000 } })

const assistant = (
  content: ReadonlyArray<{ type: string; text?: string; name?: string }>,
  extra?: { error?: string | { message?: string } },
): ChatSourceMessage => ({
  type: "assistant",
  agent: "explore",
  content,
  time: { created: 2_000 },
  ...extra,
})

describe("chatTurns", () => {
  test("projects user text and assistant text plus tool names", () => {
    const turns = chatTurns([
      user("Find the failing CI jobs"),
      assistant([
        { type: "text", text: "Found three failures." },
        { type: "tool", name: "exec" },
      ]),
    ])
    expect(turns).toEqual([
      { role: "user", text: "Find the failing CI jobs", at: 1_000 },
      { role: "assistant", agent: "explore", text: "Found three failures.", tools: ["exec"], at: 2_000 },
    ])
  })

  test("skips reasoning, system, and empty messages", () => {
    const turns = chatTurns([
      { type: "system", text: "session started" },
      user("  "),
      assistant([{ type: "reasoning", text: "thinking" }]),
      assistant([{ type: "text", text: "Done." }]),
    ])
    expect(turns.length).toBe(1)
    expect(turns[0]).toMatchObject({ role: "assistant", text: "Done.", tools: [] })
  })

  test("surfaces assistant errors", () => {
    const turns = chatTurns([assistant([], { error: { message: "overloaded_error" } })])
    expect(turns).toEqual([
      { role: "assistant", agent: "explore", text: "", tools: [], error: "overloaded_error", at: 2_000 },
    ])
  })
})
