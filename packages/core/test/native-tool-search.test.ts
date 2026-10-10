import { describe, expect, test } from "bun:test"
import { NativeToolSearch } from "@turenlabs/core/tool/native-tool-search"

describe("NativeToolSearch.supported", () => {
  test.each([
    "gpt-5.4",
    "gpt-5.5",
    "gpt-5.6-sol",
    "gpt-5.6-luna",
    "gpt-6",
    "gpt-6-sol",
    "gpt-6.1-sol",
    "gpt-6-astra",
    "gpt-7-luna",
  ])("%s supports tool search", (modelID) => {
    expect(NativeToolSearch.supported(modelID)).toBe(true)
  })

  test.each([
    "gpt-5",
    "gpt-5-mini",
    "gpt-5.2",
    "gpt-5.3-codex-spark",
    "gpt-4.1",
    "gpt-4o",
    "gpt-daybreak-blue-latest",
    "claude-opus-5",
    "kimi-k2",
  ])("%s does not", (modelID) => {
    expect(NativeToolSearch.supported(modelID)).toBe(false)
  })
})

describe("NativeToolSearch.enabled", () => {
  const on = { flag: true, routeID: "openai-responses", modelID: "gpt-6-sol" }

  test("needs the flag, the Responses route and a supported model", () => {
    expect(NativeToolSearch.enabled(on)).toBe(true)
    expect(NativeToolSearch.enabled({ ...on, flag: false })).toBe(false)
    expect(NativeToolSearch.enabled({ ...on, routeID: "openai-chat" })).toBe(false)
    expect(NativeToolSearch.enabled({ ...on, routeID: "anthropic-messages" })).toBe(false)
    expect(NativeToolSearch.enabled({ ...on, modelID: "gpt-4.1" })).toBe(false)
  })
})

describe("NativeToolSearch.fit", () => {
  const definition = (name: string, size: number) => ({
    name,
    description: "d".repeat(size),
    inputSchema: { type: "object" },
  })

  test("keeps every candidate that fits, in ranking order", () => {
    const candidates = [definition("a", 100), definition("b", 100), definition("c", 100)]
    const { included, omitted } = NativeToolSearch.fit({ matches: [] }, candidates)
    expect(included.map((item) => item.name)).toEqual(["a", "b", "c"])
    expect(omitted).toEqual([])
  })

  test("stops at the first candidate that would pass the byte limit and never skips ahead", () => {
    const candidates = [definition("small", 1_000), definition("huge", 60_000), definition("tiny", 10)]
    const { included, omitted } = NativeToolSearch.fit({ matches: [] }, candidates)
    // `tiny` would fit, but a lower-ranked tool must not displace a higher-ranked one.
    expect(included.map((item) => item.name)).toEqual(["small"])
    expect(omitted.map((item) => item.name)).toEqual(["huge", "tiny"])
  })

  test("counts the rest of the result against the limit", () => {
    const rest = { matches: ["x".repeat(NativeToolSearch.MAX_RESULT_BYTES - 500)] }
    const { included } = NativeToolSearch.fit(rest, [definition("a", 2_000)])
    expect(included).toEqual([])
  })

  test("stays inside the line limit for deeply nested schemas", () => {
    const nested = {
      name: "nested",
      description: "",
      inputSchema: { type: "object", properties: Object.fromEntries(Array.from({ length: 800 }, (_, i) => [`p${i}`, { type: "string" }])) },
    }
    const { included, omitted } = NativeToolSearch.fit({}, [nested, nested])
    expect(included.length).toBeLessThan(2)
    expect(included.length + omitted.length).toBe(2)
  })

  test("returns nothing for no candidates", () => {
    expect(NativeToolSearch.fit({ matches: [] }, [])).toEqual({ included: [], omitted: [] })
  })

  test("the limits sit below the output store's own, so a result is never spilled to a file", () => {
    expect(NativeToolSearch.MAX_RESULT_BYTES).toBeLessThan(50 * 1024)
    expect(NativeToolSearch.MAX_RESULT_LINES).toBeLessThan(2_000)
  })
})
