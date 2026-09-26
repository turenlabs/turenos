import { expect, test } from "bun:test"
import { canonicalizeJson, requestDiff } from "../src/matching.js"

test("canonicalizeJson sorts keys and preserves __proto__ as an own data property", () => {
  const value = JSON.parse('{"b":1,"__proto__":{"z":1,"a":2},"a":{"z":1,"a":2}}')
  const canonicalized = canonicalizeJson(value) as Record<string, unknown>

  expect(Object.getPrototypeOf(canonicalized)).toBe(Object.prototype)
  expect(JSON.stringify(canonicalized)).toBe('{"__proto__":{"a":2,"z":1},"a":{"a":2,"z":1},"b":1}')
  expect(Object.getOwnPropertyDescriptor(canonicalized, "__proto__")).toEqual({
    value: { a: 2, z: 1 },
    writable: true,
    enumerable: true,
    configurable: true,
  })
})

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
