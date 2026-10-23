import { expect, test } from "bun:test"
import { BoundedJson } from "@turenlabs/core/util/bounded-json"

test("bounds expanded data before JSON serialization, including depth, cycles and shared graphs", () => {
  const shared = { leaf: "evidence" }
  expect(BoundedJson.encode({ a: shared, b: shared }, 1024)).toBe(JSON.stringify({ a: shared, b: shared }))
  const deep: Record<string, unknown> = {}
  let child = deep
  for (let index = 0; index < 20_000; index++) {
    const next = {}
    child.next = next
    child = next
  }
  expect(BoundedJson.encode(deep, 8 * 1024 * 1024)).toBeUndefined()
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  expect(BoundedJson.encode(cycle, 1024)).toBeUndefined()
  let graph: Record<string, unknown> = shared
  for (let index = 0; index < 40; index++) graph = { left: graph, right: graph }
  expect(BoundedJson.encode(graph, 8 * 1024 * 1024, 1000)).toBeUndefined()
  expect(BoundedJson.encode(Array(1_000_000), 1024)).toBeUndefined()
})

test("handles JSON byte expansion and rejects executable serialization hooks", () => {
  for (const value of ['🙂雪\u0000\n"\\\ud800', { field: "é", absent: undefined }, [undefined, null, true]])
    expect(BoundedJson.encode(value, 1024)).toBe(JSON.stringify(value))
  expect(BoundedJson.encode("\u0000".repeat(300), 1024)).toBeUndefined()
  expect(BoundedJson.encode(1n, 1024)).toBeUndefined()
  expect(BoundedJson.encode(Number.POSITIVE_INFINITY, 1024)).toBeUndefined()
  const accessed: string[] = []
  const value = Object.defineProperty({}, "field", {
    enumerable: true,
    get: () => {
      accessed.push("get")
      return 1
    },
  })
  expect(BoundedJson.encode(value, 1024)).toBeUndefined()
  const hook = Object.defineProperty([], "toJSON", {
    value: () => {
      accessed.push("hook")
      return "changed"
    },
  })
  expect(BoundedJson.encode(hook, 1024)).toBeUndefined()
  expect(accessed).toEqual([])
})
