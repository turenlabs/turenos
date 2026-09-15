import { describe, expect, test } from "bun:test"
import {
  canEditNote,
  codec,
  compareFlows,
  editedBody,
  editableHeaders,
  parseHeaders,
  parseRawRequest,
  previewRule,
  proxyOwner,
} from "./security-proxy-model"
import type { SecurityProxy } from "@turenlabs/schema/security-proxy"

describe("proxyOwner", () => {
  test("session-scoped owners use the session location, not the project path", () => {
    // The tool keys bindings and case storage by Location directory plus
    // workspaceID; a project path that differs in string form (WSL mounts,
    // symlinked roots) or omits workspaceID lands on an empty scope.
    expect(
      proxyOwner({
        directory: "C:\\work\\repo",
        session: { directory: "/mnt/c/work/repo", workspaceID: "wrk_1" },
        sessionID: "ses_1",
      }),
    ).toEqual({ directory: "/mnt/c/work/repo", workspaceID: "wrk_1", sessionID: "ses_1" })
  })
  test("omits workspaceID when the session location has none", () => {
    expect(
      proxyOwner({ directory: "/other", session: { directory: "/repo" }, sessionID: "ses_1" }),
    ).toEqual({ directory: "/repo", sessionID: "ses_1" })
  })
  test("falls back to the project directory outside a session", () => {
    expect(proxyOwner({ directory: "/repo" })).toEqual({ directory: "/repo" })
    expect(proxyOwner({ directory: "/repo", session: { directory: "" }, sessionID: "ses_1" })).toEqual({
      directory: "/repo",
      sessionID: "ses_1",
    })
  })
})

describe("security proxy editors", () => {
  test("existing notes require reveal; empty notes allow new input", () => {
    expect(canEditNote("[REDACTED]", false)).toBe(false)
    expect(canEditNote("protected existing note", false)).toBe(false)
    expect(canEditNote("", false)).toBe(true)
    expect(canEditNote("revealed original", true)).toBe(true)
  })
  test("UTF-8 codecs round trip without executing content", () => {
    for (const format of ["URL", "Base64", "Hex"] as const) {
      const text = "<script>✓ café</script>"
      expect(codec(codec(text, format, false), format, true)).toBe(text)
    }
    expect(() => codec("0", "Hex", true)).toThrow()
    expect(() => codec("zz", "Hex", true)).toThrow()
    expect(() => codec("%xy", "URL", true)).toThrow()
  })
  test("headers preserve duplicate values but reject framing and injection", () => {
    expect(parseHeaders('[{"name":"X-Test","value":"a"},{"name":"X-Test","value":"b"}]')).toHaveLength(2)
    expect(() => parseHeaders('{"Cookie":"secret"}')).toThrow()
    expect(() => parseHeaders('[{"name":"Content-Length","value":"1"}]')).toThrow()
    expect(() => parseHeaders('[{"name":"Cookie","value":"[REDACTED]"}]')).toThrow()
    expect(() => parseHeaders('[{"name":"X-Test","value":"a\\r\\nb"}]')).toThrow()
    expect(
      editableHeaders([
        { name: "Host", value: "example.test" },
        { name: ":authority", value: "example.test" },
        { name: ":method", value: "GET" },
        { name: ":path", value: "/" },
        { name: "Cookie", value: "a=b" },
      ]),
    ).toEqual([{ name: "Cookie", value: "a=b" }])
  })
  test("request editors preserve Content-Encoding", () => {
    const headers = [{ name: "Content-Encoding", value: "gzip" }]
    expect(editableHeaders(headers)).toEqual(headers)
    expect(parseHeaders(JSON.stringify(headers))).toEqual(headers)
  })
  test("body encoding tracks bytes and rejects oversized input", () => {
    expect(editedBody("✓", "utf8").size).toBe(3)
    expect(editedBody("AAH/", "base64").size).toBe(3)
    expect(() => editedBody("!", "base64")).toThrow()
    expect(() => editedBody("x".repeat(1_048_577), "utf8")).toThrow()
  })
  test("rule preview is literal, not regex or JavaScript", () => {
    const rule = {
      id: "r",
      enabled: true,
      stage: "request",
      path: "/",
      method: "",
      action: "replace",
      find: ".*",
      replace: "$&",
    } as const
    expect(previewRule("a.*b.*", rule)).toBe("a$&b$&")
    expect(previewRule("a.*", { ...rule, enabled: false })).toBe("a.*")
    expect(previewRule("abc", { ...rule, find: "" })).toBe("abc")
  })
  test("comparison renders inert text and hex, without claiming incomplete bodies match", () => {
    const body = editedBody("<b>✓</b>", "utf8")
    const flow: SecurityProxy.Flow = {
      id: "left",
      caseID: "case",
      source: "browser",
      createdAt: 0,
      note: "",
      state: "complete",
      status: 200,
      request: { url: "https://example.test", method: "GET", headers: [], body: editedBody("", "utf8") },
      responseHeaders: [],
      responseBody: body,
    }
    expect(compareFlows(flow, { ...flow, id: "right" }, false).equal).toBe(true)
    expect(compareFlows(flow, flow, false).left).toContain("<b>✓</b>")
    expect(compareFlows(flow, flow, true).left).toContain("3c 62 3e e2 9c 93")
    expect(compareFlows(flow, { ...flow, status: 500 }, false).equal).toBe(false)
    expect(compareFlows(flow, { ...flow, responseBody: { ...body, state: "truncated" } }, false).equal).toBe(false)
  })
  test("raw request parsing builds an origin-form or absolute URL and keeps the body verbatim", () => {
    expect(
      parseRawRequest('POST /api/x?a=1 HTTP/1.1\r\nHost: example.test\r\nX-A: b\r\n\r\n{"k":1}\n\ntrailer'),
    ).toEqual({
      url: "https://example.test/api/x?a=1",
      method: "POST",
      headers: [
        { name: "Host", value: "example.test" },
        { name: "X-A", value: "b" },
      ],
      body: '{"k":1}\n\ntrailer',
    })
    expect(parseRawRequest("GET https://example.test/abs HTTP/1.1\nX-A: b")?.url).toBe("https://example.test/abs")
    expect(parseRawRequest("get /lowercase HTTP/1.1\nHost: example.test")).toBeUndefined()
    expect(parseRawRequest("GET * HTTP/1.1")).toBeUndefined()
    expect(parseRawRequest("")).toBeUndefined()
  })
})
