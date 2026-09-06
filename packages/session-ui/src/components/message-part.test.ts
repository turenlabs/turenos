import { describe, expect, test } from "bun:test"
import type { ToolPart } from "@turenlabs/sdk/v2"
import { partDefaultOpen } from "./part-default-open"
import { readPartText } from "./message-part-text"
import { taskThinkingState } from "./task-thinking-state"
import { toolResultCleared } from "./tool-cleared"
import { tokensPerSecond } from "./tokens-per-second"

describe("tokensPerSecond", () => {
  test("calculates output tokens over the response duration, excluding earlier task time", () => {
    expect(tokensPerSecond(120, { created: 56_000, completed: 60_000 })).toBe(30)
  })

  test("returns nothing when the duration cannot produce a rate", () => {
    expect(tokensPerSecond(120, { created: 0 })).toBeUndefined()
    expect(tokensPerSecond(120, { created: 0, completed: 0 })).toBeUndefined()
    expect(tokensPerSecond(120, { created: 1, completed: 0 })).toBeUndefined()
    expect(tokensPerSecond(120, { created: 0, completed: Number.POSITIVE_INFINITY })).toBeUndefined()
    expect(tokensPerSecond(120, { created: Number.NaN, completed: 4_000 })).toBeUndefined()
  })

  test("rejects invalid token counts and permits measured zero output", () => {
    const time = { created: 0, completed: 4_000 }
    expect(tokensPerSecond(-1, time)).toBeUndefined()
    expect(tokensPerSecond(Number.NaN, time)).toBeUndefined()
    expect(tokensPerSecond(Number.POSITIVE_INFINITY, time)).toBeUndefined()
    expect(tokensPerSecond(0, time)).toBe(0)
  })
})

describe("readPartText", () => {
  test("returns empty string when accum is undefined and part text is undefined", () => {
    expect(readPartText(undefined, { id: "part_1" })).toBe("")
  })

  test("returns trimmed part text when accum is undefined", () => {
    expect(readPartText(undefined, { id: "part_1", text: "  hello  " })).toBe("hello")
  })

  test("prefers accum value over part text when accum has a hit", () => {
    expect(readPartText({ part_1: "  from accum  " }, { id: "part_1", text: "from part" })).toBe("from accum")
  })

  test("falls back to part text when accum misses", () => {
    expect(readPartText({ other_part: "ignored" }, { id: "part_1", text: "  from part  " })).toBe("from part")
  })

  test("returns empty string for whitespace-only text", () => {
    expect(readPartText(undefined, { id: "part_1", text: "   \n\t  " })).toBe("")
  })

  test("trims leading and trailing whitespace", () => {
    expect(readPartText(undefined, { id: "part_1", text: "\n  body  \n" })).toBe("body")
  })
})

describe("toolResultCleared", () => {
  const completed = (time: Record<string, unknown>) => ({ type: "tool", state: { status: "completed", time } })

  test("reports the timestamp a completed result was cleared from context", () => {
    expect(toolResultCleared(completed({ start: 1, end: 2, compacted: 1700000000000 }))).toBe(1700000000000)
  })

  test("reports nothing for a result the model still has in full", () => {
    expect(toolResultCleared(completed({ start: 1, end: 2 }))).toBeUndefined()
  })

  // The mark only ever lands on a completed result, and a running tool has no `time.compacted`
  // at all — reading it off the wrong state shape would annotate live output as cleared.
  test("reports nothing for a tool that has not completed", () => {
    expect(toolResultCleared({ type: "tool", state: { status: "running", time: { start: 1 } } })).toBeUndefined()
    expect(toolResultCleared({ type: "tool", state: { status: "error", time: { start: 1, end: 2 } } })).toBeUndefined()
    expect(toolResultCleared(undefined)).toBeUndefined()
  })

  // A v1 transcript that was never pruned round-trips `compacted: 0` through adoption; that is
  // the absence of a mark, not a prune at the epoch.
  test("treats a zero or non-numeric mark as absent", () => {
    expect(toolResultCleared(completed({ start: 1, end: 2, compacted: 0 }))).toBeUndefined()
    expect(toolResultCleared(completed({ start: 1, end: 2, compacted: null }))).toBeUndefined()
    expect(toolResultCleared(completed({ start: 1, end: 2, compacted: "yes" }))).toBeUndefined()
  })
})

describe("taskThinkingState", () => {
  test("uses searching for investigative subagents", () => {
    expect(taskThinkingState("explore")).toBe("searching")
    expect(taskThinkingState("Review")).toBe("searching")
  })

  test("uses shaping for output-producing subagents", () => {
    expect(taskThinkingState("build")).toBe("shaping")
    expect(taskThinkingState("Writer")).toBe("shaping")
  })

  test("uses working for planning and unknown subagents", () => {
    expect(taskThinkingState("plan")).toBe("working")
    expect(taskThinkingState(undefined)).toBe("working")
  })
})

describe("partDefaultOpen", () => {
  test("opens failures while leaving successful routine work collapsed", () => {
    const part = (status: "completed" | "error") =>
      ({
        type: "tool",
        tool: "bash",
        state:
          status === "error"
            ? { status, input: {}, error: "failed", time: { start: 1, end: 2 } }
            : { status, input: {}, output: "ok", title: "", metadata: {}, time: { start: 1, end: 2 } },
      }) as ToolPart

    expect(partDefaultOpen(part("error"))).toBe(true)
    expect(partDefaultOpen(part("completed"))).toBe(false)
  })
})
