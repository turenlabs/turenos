import { expect, test } from "bun:test"
import { EGraph, NodeLimitError, createEGraph, mustRewrite } from "@turenlabs/core/yolk"

test("rebuild restores congruence after union", () => {
  const graph = createEGraph()
  const left = graph.add("left")
  const right = graph.add("right")
  const leftCall = graph.add("call", left)
  const rightCall = graph.add("call", right)

  expect(graph.equivalent(leftCall, rightCall)).toBe(false)
  graph.union(left, right)
  graph.rebuild()
  expect(graph.equivalent(leftCall, rightCall)).toBe(true)
})

test("rewrite runner saturates double negation", async () => {
  const graph = createEGraph()
  const value = graph.add("value")
  const doubleNegation = graph.add("not", graph.add("not", value))
  const report = await graph.run([mustRewrite("double-negation", "(not (not ?value))", "?value")])

  expect(report.stopReason).toBe("saturated")
  expect(graph.equivalent(value, doubleNegation)).toBe(true)
})

test("hard node limits stop allocation before the graph can grow past its budget", () => {
  const graph = new EGraph(1)
  graph.add("first")
  expect(() => graph.add("second")).toThrow(NodeLimitError)
  expect(graph.numNodes()).toBe(1)
})

test("rewrite saturation yields to cancellation", async () => {
  const graph = createEGraph()
  for (let index = 0; index < 1_000; index++) graph.add(`value:${index}`)
  const controller = new AbortController()
  setTimeout(() => controller.abort(new Error("cancelled")), 0)

  await expect(graph.run([mustRewrite("identity", "?value", "?value")], { signal: controller.signal })).rejects.toThrow(
    "cancelled",
  )
})
