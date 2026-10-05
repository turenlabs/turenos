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
  repeaterTab,
  duplicateRepeaterTab,
  harEntry,
  caseExport,
} from "./security-proxy-model"
import type { SecurityProxy } from "@turenlabs/schema/security-proxy"

const captured: SecurityProxy.Flow = {
  id: "captured",
  caseID: "case",
  source: "browser",
  state: "complete",
  createdAt: 123,
  durationMs: 12,
  note: "case note",
  status: 200,
  request: {
    url: "https://example.test/api?tag=a&tag=b",
    method: "POST",
    headers: [
      { name: "Content-Type", value: "application/json" },
      { name: "Authorization", value: "Bearer secret" },
    ],
    body: { data: '{"id":1}', encoding: "utf8", state: "complete", size: 8 },
  },
  responseHeaders: [{ name: "Content-Type", value: "application/json" }],
  responseBody: { data: '{"role":"user"}', encoding: "utf8", state: "complete", size: 15 },
}

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
    expect(proxyOwner({ directory: "/other", session: { directory: "/repo" }, sessionID: "ses_1" })).toEqual({
      directory: "/repo",
      sessionID: "ses_1",
    })
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
  test("Repeater tabs have independent drafts, auth, and send histories", () => {
    const first = repeaterTab(captured)
    const second = repeaterTab({
      ...captured,
      id: "another",
      request: { ...captured.request, url: "https://example.test/admin" },
    })
    expect(first.id).not.toBe(second.id)
    expect(first.name).toBe("POST /api")
    expect(first.flowID).toBe(captured.id)
    expect(first.draft.headers).toContain("Bearer secret")
    first.draft.body = '{"id":2}'
    first.auth = "live"
    first.results.push({ ...captured, id: "send_1", source: "replay", parentID: captured.id })
    first.resultID = "send_1"
    expect(second.draft.body).toBe(captured.request.body.data)
    expect(second.auth).toBe("captured")
    expect(second.results).toEqual([])
    const copy = duplicateRepeaterTab(first)
    expect(copy.id).not.toBe(first.id)
    expect(copy.flowID).toBe(first.flowID)
    expect(copy.auth).toBe("live")
    expect(copy.draft).toEqual(first.draft)
    copy.draft.body = "changed"
    expect(first.draft.body).toBe('{"id":2}')
    expect(copy.results).toEqual([])
    expect(copy.resultID).toBe("")
  })

  test("diffs identify text, word, header, status, and binary changes", () => {
    const changed = { ...captured, id: "changed", responseBody: editedBody('{"role":"admin"}', "utf8") }
    const diff = compareFlows(captured, changed, false, true)
    expect(diff.equal).toBe(false)
    expect(diff.limited).toBe(false)
    expect(
      diff.changes
        .filter((part) => part.removed)
        .map((part) => part.value)
        .join(""),
    ).toContain("user")
    expect(
      diff.changes
        .filter((part) => part.added)
        .map((part) => part.value)
        .join(""),
    ).toContain("admin")
    expect(
      compareFlows(captured, { ...captured, id: "other" }, false).changes.every((part) => !part.added && !part.removed),
    ).toBe(true)
    expect(
      compareFlows(captured, { ...captured, status: 403 }, false).changes.some(
        (part) => part.added && part.value.includes("403"),
      ),
    ).toBe(true)
    expect(compareFlows(captured, { ...captured, responseHeaders: [] }, false).equal).toBe(false)
    const binary = { ...captured, responseBody: editedBody("/w==", "base64") }
    const otherBinary = { ...captured, responseBody: editedBody("/g==", "base64") }
    expect(compareFlows(binary, otherBinary, false).equal).toBe(false)
    expect(
      compareFlows(binary, otherBinary, true).changes.some((part) => part.added && part.value.includes("fe")),
    ).toBe(true)
    const oversized = { ...captured, responseBody: editedBody("a".repeat(65537), "utf8") }
    expect(compareFlows(oversized, oversized, false).equal).toBe(false)
    expect(compareFlows(oversized, oversized, false).limited).toBe(true)
    expect(compareFlows(captured, { ...captured, state: "unknown" }, false).equal).toBe(false)
  })

  test("HAR preserves query duplicates, payloads, encodings, and capture states without inventing a protocol", () => {
    const entry = harEntry(captured)
    expect(entry.request.queryString).toEqual([
      { name: "tag", value: "a" },
      { name: "tag", value: "b" },
    ])
    expect(entry.request.postData?.text).toBe(captured.request.body.data)
    expect(entry.response.content.text).toBe(captured.responseBody.data)
    expect(entry.request.httpVersion).toBe("")
    expect(entry.time).toBe(12)
    expect(entry._flowID).toBe("captured")
    const binary = harEntry({ ...captured, responseBody: { ...editedBody("AAH/", "base64"), state: "truncated" } })
    expect(binary.response.content.encoding).toBe("base64")
    expect(binary.response.content._bodyState).toBe("truncated")
    expect(binary.response.content.text).toBe("AAH/")
    expect(
      harEntry({
        ...captured,
        request: { ...captured.request, body: { ...captured.request.body, state: "unavailable", data: "" } },
      }).request.postData,
    ).toBeUndefined()
  })

  test("case exports serialize every appended page, including empty pages, as JSON and HAR", async () => {
    for (const format of ["json", "har"] as const) {
      const exported = caseExport({
        format,
        visibility: "revealed",
        case: { id: "case", name: 'Quoted "case"', createdAt: 0 },
        filter: { method: "POST" },
      })
      exported.append(Array.from({ length: 200 }, (_, index) => ({ ...captured, id: `flow_${index}` })))
      exported.append([])
      exported.append(Array.from({ length: 5 }, (_, index) => ({ ...captured, id: `older_${index}` })))
      expect(exported.count).toBe(205)
      const value = JSON.parse(await exported.finish().text())
      const rows = format === "har" ? value.log.entries : value.flows
      const metadata = format === "har" ? value.log._turen : value
      expect(rows).toHaveLength(205)
      expect(metadata.visibility).toBe("revealed")
      expect(metadata.case.name).toBe('Quoted "case"')
      expect(metadata.filter).toEqual({ method: "POST" })
      expect(JSON.stringify(value)).toContain("Bearer secret")
      const empty = caseExport({ format, visibility: "masked", case: { id: "empty", name: "Empty", createdAt: 0 } })
      const emptyValue = JSON.parse(await empty.finish().text())
      expect(format === "har" ? emptyValue.log.entries : emptyValue.flows).toEqual([])
    }
  })

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
