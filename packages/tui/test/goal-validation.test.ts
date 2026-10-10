import { expect, test } from "bun:test"
import { validateResponse } from "../src/response-validation"

const url = new URL("http://127.0.0.1/api/session/ses_test/goal")
const goal = {
  id: "goal_test",
  sessionID: "ses_test",
  revision: 2,
  objective: "Complete the fixture",
  status: "active",
  tokensUsed: 12,
  timeUsedSeconds: 3,
  time: { created: 1, updated: 2, statusChanged: 2 },
}

test("goal snapshots accept null or bounded same-session goal data", () => {
  expect(() => validateResponse(url, { method: "GET" }, { data: null })).not.toThrow()
  expect(() => validateResponse(url, { method: "GET" }, { data: goal })).not.toThrow()
  for (const bad of [
    { ...goal, sessionID: "ses_other" },
    { ...goal, revision: 0 },
    { ...goal, tokensUsed: -1 },
    { ...goal, status: "unknown" },
    { ...goal, objective: 12 },
  ])
    expect(() => validateResponse(url, { method: "GET" }, { data: bad })).toThrow()
})

test("goal write acknowledgements retain expected identity and revision", () => {
  const request = {
    method: "PATCH",
    body: JSON.stringify({ goalID: "goal_test", expectedRevision: 1, objective: "Updated" }),
  }
  expect(() => validateResponse(url, request, { data: goal })).not.toThrow()
  expect(() => validateResponse(url, request, { data: null })).toThrow()
  expect(() => validateResponse(url, request, { data: { ...goal, id: "goal_wrong" } })).toThrow("goal identity")
  expect(() =>
    validateResponse(
      url,
      { ...request, body: JSON.stringify({ goalID: "goal_test", expectedRevision: 3 }) },
      { data: goal },
    ),
  ).toThrow("goal revision regressed")
})
