import { describe, expect, test } from "bun:test"
import { visualizationSpec } from "./visualization-data"

const spec = { version: 1 as const, title: "Example", kind: "bar" as const, items: [{ label: "One", value: 2 }] }

describe("visualizationSpec", () => {
  test("reads only validated structured metadata", () => {
    expect(visualizationSpec({ structured: spec })).toEqual(spec)
    for (const value of [null, undefined, [], spec, { output: spec }, { structured: JSON.stringify(spec) }]) {
      expect(visualizationSpec(value)).toBeUndefined()
    }
  })

  test("rejects malformed and unbounded data", () => {
    for (const value of [
      { ...spec, version: 2 },
      { ...spec, kind: "html" },
      { ...spec, title: "a".repeat(161) },
      { ...spec, items: [] },
      { ...spec, items: Array.from({ length: 501 }, () => ({ label: "x", value: 1 })) },
      ...[-1, NaN, Infinity, 1e12 + 1, "2"].map((value) => ({ ...spec, items: [{ label: "x", value }] })),
      { ...spec, items: Array.from({ length: 200 }, () => ({ label: "x", value: 1, detail: "a".repeat(1000) })) },
    ])
      expect(visualizationSpec({ structured: value })).toBeUndefined()
  })

  test("keeps HTML and URLs as plain text fields", () => {
    const value = {
      ...spec,
      items: [{ label: "<script>alert(1)</script>", value: 0, detail: "https://example.invalid" }],
    }
    expect(visualizationSpec({ structured: value })).toEqual(value)
  })
})
