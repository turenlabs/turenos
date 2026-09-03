import { describe, expect, test } from "bun:test"
import type { SessionReplayEvent } from "@turenlabs/sdk/v2/client"
import {
  mergeReplayEvents,
  replayEventLabel,
  replayEventPreview,
  replayEventSequence,
  replayStats,
} from "./session-replay-model"

const event = (id: string, seq: number, type: string, data: Record<string, unknown> = {}) =>
  ({ id, type, durable: { aggregateID: "ses_test", seq, version: 1 }, data }) as SessionReplayEvent

describe("session replay model", () => {
  test("merges pages in durable sequence order without duplicates", () => {
    const one = event("evt_1", 1, "session.next.prompted")
    const two = event("evt_2", 2, "session.next.text.ended")
    expect(mergeReplayEvents([one], [two, one]).map(replayEventSequence)).toEqual([1, 2])
  })

  test("creates compact labels and meaningful previews", () => {
    expect(replayEventLabel(event("evt_1", 1, "session.next.tool.failed"))).toBe("tool / failed")
    expect(
      replayEventPreview(event("evt_1", 1, "session.next.tool.failed", { error: { message: "command failed" } })),
    ).toBe("command failed")
  })

  test("derives debugger counters only through the selected cursor", () => {
    const events = [
      event("evt_1", 1, "session.next.step.ended"),
      event("evt_2", 2, "session.next.tool.called"),
      event("evt_3", 3, "session.next.tool.failed", { error: { message: "nope" } }),
    ]
    expect(replayStats(events, 1)).toEqual({ events: 2, turns: 1, tools: 1, failures: 0 })
    expect(replayStats(events, 2).failures).toBe(1)
  })
})
