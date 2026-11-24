import { expect, test } from "bun:test"
import { CodingEvents } from "./events"

test("reads comparable provider usage and ignores a different TurenOS session", () => {
  const turen = CodingEvents.empty()
  const row = {
    type: "session.next.step.ended",
    data: {
      sessionID: "ours",
      assistantMessageID: "final",
      tokens: { input: 7, cache: { read: 11 } },
      billed: { input: 10, cache: { read: 20 }, output: 2, reasoning: 5 },
    },
  }
  expect(CodingEvents.turen(turen, row, "theirs", 10)).toBeUndefined()
  expect(turen.requestsWithUsage).toBe(0)
  expect(CodingEvents.turen(turen, row, "ours", 20)).toBe("final")
  expect(turen.usage).toEqual({ input: 30, cached: 20, output: 7, reasoning: 5 })
  const distance = CodingEvents.empty()
  CodingEvents.distance(distance, { type: "usage", input: 10, cache_read: 20, output: 7 }, 20)
  expect(distance.usage).toEqual({ input: 30, cached: 20, output: 7 })
})

test("settlement waits for the final assistant step if the waiter finishes first", async () => {
  const watcher = CodingEvents.settlements()
  const closed = Promise.withResolvers<void>()
  const deadline = Promise.withResolvers<void>()
  watcher.record("intermediate")
  const pending = watcher.wait("final", closed.promise, deadline.promise)
  watcher.record("final")
  expect(await pending).toBe(true)
  const missing = CodingEvents.settlements().wait("final", closed.promise, deadline.promise)
  closed.resolve()
  expect(await missing).toBe(false)
})
