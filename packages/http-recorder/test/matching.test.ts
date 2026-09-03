import { expect, test } from "bun:test"
import { requestDiff } from "../src/matching.js"

test("requestDiff limits large JSON array diagnostics to the first eight differences", () => {
  const values = Array.from({ length: 20 }, (_, index) => index)
  const diffs = requestDiff(
    { method: "POST", url: "https://example.test", headers: {}, body: JSON.stringify(values) },
    {
      method: "POST",
      url: "https://example.test",
      headers: {},
      body: JSON.stringify(values.map((value) => -value - 1)),
    },
  )

  expect(diffs).toHaveLength(9)
  expect(diffs[0]).toBe("body:")
  expect(diffs.slice(1)).toEqual(
    values.slice(0, 8).map((value, index) => `  $[${index}] expected ${value}, received ${-value - 1}`),
  )
})
