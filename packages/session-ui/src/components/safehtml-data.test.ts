import { describe, expect, test } from "bun:test"
import { safeHtmlSpec } from "./safehtml-data"

const spec = { version: 1 as const, title: "Example", html: "<h1>Hello</h1>" }

describe("safeHtmlSpec", () => {
  test("reads only validated structured metadata", () => {
    expect(safeHtmlSpec({ structured: spec })).toEqual(spec)
    for (const value of [null, undefined, [], spec, { output: spec }, { structured: JSON.stringify(spec) }]) {
      expect(safeHtmlSpec(value)).toBeUndefined()
    }
  })

  test("rejects invalid fields and oversized UTF-8 JSON", () => {
    for (const value of [
      { ...spec, version: 2 },
      { ...spec, title: 1 },
      { ...spec, title: "a".repeat(161) },
      { ...spec, description: "a".repeat(1001) },
      { ...spec, description: 1 },
      { ...spec, html: "" },
      { ...spec, html: 1 },
      { ...spec, html: "a".repeat(512 * 1024) },
      { ...spec, html: "\u00e9".repeat(256 * 1024) },
      { ...spec, html: '"'.repeat(256 * 1024) },
    ]) {
      expect(safeHtmlSpec({ structured: value })).toBeUndefined()
    }
  })

  test("accepts bounded HTML and preserves text without executing it", () => {
    const value = {
      ...spec,
      title: "<script>alert(1)</script>",
      description: "https://example.invalid",
      html: '<script>alert(1)</script><img src="https://example.invalid/image">',
    }
    expect(safeHtmlSpec({ structured: value })).toEqual(value)
    expect(safeHtmlSpec({ structured: { ...spec, html: "a".repeat(500 * 1024) } })).toBeDefined()
  })
})
