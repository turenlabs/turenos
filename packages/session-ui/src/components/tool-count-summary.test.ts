import { expect, test } from "bun:test"
import { toolCountSummary } from "./tool-count-summary"

test("accessible summaries omit hidden zero counts and rolling digit animation", () => {
  expect(
    toolCountSummary([
      { key: "read", count: 0, one: "{{count}} read", other: "{{count}} reads" },
      { key: "search", count: 1, one: "{{ count }} search", other: "{{ count }} searches" },
      { key: "coordination", count: 24, one: "{{count}} context operation", other: "{{count}} context operations" },
    ]),
  ).toBe("1 search, 24 context operations")
  expect(toolCountSummary([], "Working")).toBe("Working")
})
