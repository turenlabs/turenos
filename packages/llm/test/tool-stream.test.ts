import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLMError } from "../src/schema"
import { ToolStream } from "../src/protocols/utils/tool-stream"
import { it } from "./lib/effect"

const ADAPTER = "test-route"

describe("ToolStream", () => {
  it.effect("starts from OpenAI-style deltas and finalizes parsed input", () =>
    Effect.gen(function* () {
      const first = ToolStream.appendOrStart(
        ADAPTER,
        ToolStream.empty<number>(),
        0,
        { id: "call_1", name: "lookup", text: '{"query"' },
        "missing tool",
      )
      if (ToolStream.isError(first)) return yield* first
      const second = ToolStream.appendOrStart(ADAPTER, first.tools, 0, { text: ':"weather"}' }, "missing tool")
      if (ToolStream.isError(second)) return yield* second
      const finished = yield* ToolStream.finish(ADAPTER, second.tools, 0)

      expect(first.events).toEqual([
        { type: "tool-input-start", id: "call_1", name: "lookup" },
        { type: "tool-input-delta", id: "call_1", name: "lookup", text: '{"query"' },
      ])
      expect(second.events).toEqual([{ type: "tool-input-delta", id: "call_1", name: "lookup", text: ':"weather"}' }])
      expect(finished).toEqual({
        tools: {},
        events: [
          { type: "tool-input-end", id: "call_1", name: "lookup" },
          { type: "tool-call", id: "call_1", name: "lookup", input: { query: "weather" } },
        ],
      })
    }),
  )

  it.effect("fails appendExisting when the provider skipped the tool start", () =>
    Effect.gen(function* () {
      const error = ToolStream.appendExisting(ADAPTER, ToolStream.empty<number>(), 0, "{}", "missing tool")

      expect(error).toBeInstanceOf(LLMError)
      if (ToolStream.isError(error)) expect(error.reason.message).toBe("missing tool")
    }),
  )

  it.effect("uses final input override without losing accumulated deltas", () =>
    Effect.gen(function* () {
      const tools = ToolStream.start(ToolStream.empty<string>(), "item_1", {
        id: "call_1",
        name: "lookup",
        input: '{"query":"partial"}',
      })
      const finished = yield* ToolStream.finishWithInput(ADAPTER, tools, "item_1", '{"query":"final"}')

      expect(finished).toEqual({
        tools: {},
        events: [
          { type: "tool-input-end", id: "call_1", name: "lookup" },
          { type: "tool-call", id: "call_1", name: "lookup", input: { query: "final" } },
        ],
      })
    }),
  )

  it.effect("turns malformed model JSON into a recoverable tool error", () =>
    Effect.gen(function* () {
      const appended = ToolStream.appendOrStart(
        ADAPTER,
        ToolStream.empty<number>(),
        0,
        { id: "call_bad", name: "apply_patch", text: '{"patchText":"unterminated' },
        "missing tool",
      )
      if (ToolStream.isError(appended)) return yield* appended
      const finished = yield* ToolStream.finish(ADAPTER, appended.tools, 0)

      expect(finished).toEqual({
        tools: {},
        events: [
          { type: "tool-input-end", id: "call_bad", name: "apply_patch" },
          {
            type: "tool-error",
            id: "call_bad",
            name: "apply_patch",
            message:
              "Invalid JSON input for test-route tool call apply_patch. Regenerate this tool call with valid JSON.",
            recoverable: true,
            providerMetadata: undefined,
          },
        ],
      })
    }),
  )

  it.effect("preserves providerExecuted and clears all tools", () =>
    Effect.gen(function* () {
      const first: ToolStream.State<number> = ToolStream.start(ToolStream.empty<number>(), 0, {
        id: "call_1",
        name: "lookup",
        input: "{}",
      })
      const tools = ToolStream.start(first, 1, {
        id: "call_2",
        name: "web_search",
        input: '{"query":"docs"}',
        providerExecuted: true,
      })
      const finished = yield* ToolStream.finishAll(ADAPTER, tools)

      expect(finished).toEqual({
        tools: {},
        events: [
          { type: "tool-input-end", id: "call_1", name: "lookup" },
          { type: "tool-call", id: "call_1", name: "lookup", input: {} },
          { type: "tool-input-end", id: "call_2", name: "web_search" },
          {
            type: "tool-call",
            id: "call_2",
            name: "web_search",
            input: { query: "docs" },
            providerExecuted: true,
          },
        ],
      })
    }),
  )
})
