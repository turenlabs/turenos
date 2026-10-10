import { expect, test } from "bun:test"
import { validateResponse } from "../src/response-validation"

const url = new URL("http://127.0.0.1/api/session/ses_test/revert/stage")
const request = { method: "POST", body: JSON.stringify({ messageID: "msg_boundary", files: false }) }

test("staged revert acknowledgement must match the exact requested boundary", () => {
  expect(() => validateResponse(url, request, { data: { messageID: "msg_boundary", files: [] } })).not.toThrow()
  expect(() => validateResponse(url, request, { data: { messageID: "msg_other" } })).toThrow("revert message identity")
})

test("file preview metadata is bounded and validated without interpreting paths or patches", () => {
  const file = { path: "src/file.ts", status: "modified", additions: 1, deletions: 2, patch: "@@ preview only" }
  const check = (value: unknown) =>
    validateResponse(url, request, { data: { messageID: "msg_boundary", files: value } })
  expect(() => check([file])).not.toThrow()
  expect(() => check([{ ...file, additions: -1 }])).toThrow()
  expect(() => check([{ ...file, status: "unknown" }])).toThrow()
  expect(() => check([{ ...file, path: 42 }])).toThrow()
  expect(() => check(Array.from({ length: 2049 }, () => file))).toThrow()
})

test("session snapshots cannot smuggle a malformed staged boundary", () => {
  const session = {
    id: "ses_test",
    title: "Session",
    location: { directory: "/project" },
    time: { created: 1, updated: 1 },
    revert: { messageID: "../wrong" },
  }
  expect(() =>
    validateResponse(new URL("http://127.0.0.1/api/session/ses_test"), undefined, { data: session }),
  ).toThrow()
})
