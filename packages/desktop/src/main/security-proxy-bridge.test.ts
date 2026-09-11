import { expect, test } from "bun:test"
import { parseProxyReply, parseProxyRequest } from "./security-proxy-bridge"

test("the private proxy bridge accepts only schema-validated store commands", () => {
  expect(
    parseProxyRequest({
      type: "security-proxy",
      id: "one",
      command: { type: "list", owner: { directory: "/project" } },
    })?.command.type,
  ).toBe("list")
  expect(
    parseProxyRequest({ type: "security-proxy", id: "one", command: { type: "decide", pauseID: "one" } }),
  ).toBeUndefined()
  expect(parseProxyRequest({ type: "security-proxy", id: 5, command: {} })).toBeUndefined()
})

test("the private proxy bridge rejects malformed replies and bounds error text", () => {
  expect(parseProxyReply({ type: "security-proxy-result", id: "one", result: { cases: [] } })?.result).toEqual({
    cases: [],
  })
  expect(parseProxyReply({ type: "security-proxy-result", id: "one", result: { cases: [null] } })).toBeUndefined()
  expect(parseProxyReply({ type: "security-proxy-result", id: "one", error: "x".repeat(2000) })?.error?.length).toBe(
    1024,
  )
})
