import { describe, expect, test } from "bun:test"
import { clampArgValue, MAX_ARG_VALUE_LENGTH, toolArgs, toolLabel } from "./basic-tool-args"

/*
 * This fixture preserves the shape and length that exposed the argument-chip
 * layout regression without retaining data from a real session.
 */
const AGENT_INPUT: Record<string, unknown> = {
  description: "Review DB migration and CVE storage",
  subagent_type: "general-purpose",
  run_in_background: false,
  prompt:
    "You are reviewing the storage and migration layer in the repository at /Users/example/project. Focus on data-loss and silent-failure defects.\n\nBackground: two branches each added a schema migration with the same version number.",
}

describe("toolLabel", () => {
  test("takes the description as the row subtitle", () => {
    expect(toolLabel(AGENT_INPUT)).toEqual({ key: "description", value: "Review DB migration and CVE storage" })
  })

  test("reports nothing when no summary key carries a string", () => {
    expect(toolLabel({ limit: 5 })).toBeUndefined()
    expect(toolLabel({ description: "" })).toBeUndefined()
    expect(toolLabel(undefined)).toBeUndefined()
  })
})

describe("toolArgs", () => {
  // The bug: `prompt` was rendered at full length, and because every chip is
  // `flex-shrink: 1` with no basis cap, flexbox handed it ~96% of the line.
  test("bounds every value so no argument can starve the rest of the row", () => {
    const { args } = toolArgs(AGENT_INPUT, "description")
    expect(args).toEqual([
      "subagent_type=general-purpose",
      "run_in_background=false",
      "prompt=You are reviewing the storage an…",
    ])
    for (const arg of args) expect(arg.length).toBeLessThanOrEqual("run_in_background".length + 1 + 33)
  })

  // Timing was never the variable — a running call and a completed call carry the
  // same settled input, so they must produce the same chips.
  test("renders the same chips whatever the call's status", () => {
    const running = toolArgs(AGENT_INPUT, "description")
    const completed = toolArgs({ ...AGENT_INPUT }, "description")
    expect(running).toEqual(completed)
  })

  test("keeps a summary key that did not become the subtitle", () => {
    const { args } = toolArgs({ description: "Fetch the changelog", url: "https://example.com/x" }, "description")
    expect(args).toEqual(["url=https://example.com/x"])
  })

  test("previews structured values instead of dropping them", () => {
    const { args, omitted } = toolArgs({ files: ["a.ts", "b.ts"], opts: { deep: true } })
    expect(args).toEqual(['files=["a.ts","b.ts"]', 'opts={"deep":true}'])
    expect(omitted).toBe(0)
  })

  test("counts arguments past the chip budget rather than hiding them", () => {
    const { args, omitted } = toolArgs({ a: 1, b: 2, c: 3, d: 4, e: 5 })
    expect(args).toEqual(["a=1", "b=2", "c=3"])
    expect(omitted).toBe(2)
  })

  test("counts a value it cannot preview", () => {
    const circular: Record<string, unknown> = { name: "loop" }
    circular.self = circular
    const { args, omitted } = toolArgs({ self: circular.self, ok: "yes" })
    expect(args).toEqual(["ok=yes"])
    expect(omitted).toBe(1)
  })

  // A call that took no arguments and a call whose arguments could not be read
  // must not render the same. `omitted` is what lets the row tell them apart.
  test("distinguishes no arguments from unreadable arguments", () => {
    expect(toolArgs({})).toEqual({ args: [], omitted: 0 })
    expect(toolArgs(undefined)).toEqual({ args: [], omitted: 0 })
    const unreadable: Record<string, unknown> = {}
    unreadable.loop = unreadable
    expect(toolArgs({ loop: unreadable.loop })).toEqual({ args: [], omitted: 1 })
  })
})

describe("clampArgValue", () => {
  test("folds newlines so the budget matches the rendered width", () => {
    expect(clampArgValue("first\n\nsecond")).toBe("first second")
  })

  test("marks a value it cut", () => {
    const long = "x".repeat(MAX_ARG_VALUE_LENGTH + 10)
    const clamped = clampArgValue(long)
    expect(clamped).toBe("x".repeat(MAX_ARG_VALUE_LENGTH) + "…")
    expect(clamped.endsWith("…")).toBe(true)
  })

  test("leaves a short value alone", () => {
    expect(clampArgValue("general-purpose")).toBe("general-purpose")
  })
})
