import { describe, expect, test } from "bun:test"
import { nextSessionActivation } from "./session-lineage"

describe("nextSessionActivation", () => {
  test("survives promotion settlement but is consumed after leaving the promoted session", () => {
    const promoted = { sessionID: "ses_a", scope: "local", directory: "repo", startedAt: 1 }
    const captured = nextSessionActivation({
      current: undefined,
      pending: promoted,
      sessionID: "ses_a",
      scope: "local",
      now: 1,
    })
    expect(captured).toBe(promoted)
    expect(
      nextSessionActivation({ current: captured, pending: undefined, sessionID: "ses_a", scope: "local", now: 1 }),
    ).toBe(promoted)
    const consumed = nextSessionActivation({
      current: captured,
      pending: undefined,
      sessionID: "ses_b",
      scope: "local",
    })
    expect(consumed).toBeUndefined()
    expect(
      nextSessionActivation({ current: consumed, pending: undefined, sessionID: "ses_a", scope: "local", now: 1 }),
    ).toBeUndefined()
  })

  test("rejects handoffs from another server scope", () => {
    expect(
      nextSessionActivation({
        current: undefined,
        pending: { sessionID: "ses_a", scope: "remote", startedAt: 1 },
        sessionID: "ses_a",
        scope: "local",
      }),
    ).toBeUndefined()
  })

  test("does not capture an expired promotion handoff", () => {
    expect(
      nextSessionActivation({
        current: undefined,
        pending: { sessionID: "ses_a", scope: "local", startedAt: 1 },
        sessionID: "ses_a",
        scope: "local",
        now: 60_002,
      }),
    ).toBeUndefined()
  })

  test("expires an activation captured before lineage settled", () => {
    expect(
      nextSessionActivation({
        current: { sessionID: "ses_a", scope: "local", startedAt: 1 },
        pending: undefined,
        sessionID: "ses_a",
        scope: "local",
        now: 60_002,
      }),
    ).toBeUndefined()
  })
})
