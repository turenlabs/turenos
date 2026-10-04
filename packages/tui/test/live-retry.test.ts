import { expect, test } from "bun:test"
import { trackRetry } from "../src/live-session/retry"
import { createDashboardState } from "../src/state"

const event = (type: string, data: Record<string, unknown>) => ({ id: `evt_${type}`, type, data })

test("a retried event records the attempt, the wait and the provider's own message", () => {
  const state = createDashboardState()
  const before = Date.now()
  const changed = trackRetry(
    state,
    event("session.next.retried", {
      sessionID: "ses_a",
      attempt: 2,
      delay: 3900,
      error: {
        message:
          'Provider request failed with HTTP 503: {"error":{"message":"provider is \\"busy\\"","type":"server_error"}}',
        statusCode: 503,
        isRetryable: true,
      },
    }),
  )
  expect(changed).toBe(true)
  expect(state.retries.ses_a!.attempt).toBe(2)
  expect(state.retries.ses_a!.message).toBe('HTTP 503: provider is "busy"')
  expect(state.retries.ses_a!.at).toBeGreaterThanOrEqual(before + 3900)
})

test("progress on the turn clears its retry, and unrelated events leave it", () => {
  const state = createDashboardState()
  trackRetry(
    state,
    event("session.next.retried", { sessionID: "ses_a", attempt: 1, delay: 1000, error: { message: "boom" } }),
  )
  trackRetry(
    state,
    event("session.next.retried", { sessionID: "ses_b", attempt: 1, delay: 1000, error: { message: "boom" } }),
  )
  expect(trackRetry(state, event("session.next.title.updated", { sessionID: "ses_a" }))).toBe(false)
  expect(trackRetry(state, event("session.next.text.started", { sessionID: "ses_a" }))).toBe(true)
  expect(Object.keys(state.retries)).toEqual(["ses_b"])
  expect(state.retries.ses_b!.message).toBe("boom")
})

test("malformed retry fields fall back to safe values instead of rejecting the event", () => {
  const state = createDashboardState()
  trackRetry(state, event("session.next.retried", { sessionID: "ses_a", attempt: "x", delay: Infinity, error: 7 }))
  expect(state.retries.ses_a).toMatchObject({ attempt: 1, message: "" })
  expect(trackRetry(state, event("session.next.retried", { attempt: 1 }))).toBe(false)
})
