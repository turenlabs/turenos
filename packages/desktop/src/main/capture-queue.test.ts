import { expect, test } from "bun:test"
import { CAPTURE_BACKLOG_LIMIT, createCaptureQueue } from "./capture-queue"

function deferred() {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  return { gate, release }
}

function queue(overrides: { limit?: number; hold?: Promise<void> } = {}) {
  const ran: string[] = []
  const dropped: { method: string; count: number }[] = []
  const errors: unknown[] = []
  const q = createCaptureQueue({
    limit: overrides.limit,
    run: async (method) => {
      await overrides.hold
      ran.push(method)
    },
    drop: (method, _params, _sessionID, count) => dropped.push({ method, count }),
    error: (error) => errors.push(error),
  })
  return { q, ran, dropped, errors }
}

test("capture queue runs events in arrival order and drains through pending", async () => {
  const { q, ran } = queue()
  q.push("Network.requestWillBeSent", {}, undefined)
  q.push("Network.responseReceived", {}, undefined)
  q.push("Network.loadingFinished", {}, undefined)
  await q.pending
  expect(ran).toEqual(["Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFinished"])
})

test("capture queue drops events beyond the backlog instead of failing", async () => {
  const gate = deferred()
  const { q, ran, dropped } = queue({ limit: 4, hold: gate.gate })
  for (let index = 0; index < 10; index++) q.push(`event-${index}`, {}, undefined)
  expect(dropped).toEqual([
    { method: "event-4", count: 1 },
    { method: "event-5", count: 2 },
    { method: "event-6", count: 3 },
    { method: "event-7", count: 4 },
    { method: "event-8", count: 5 },
    { method: "event-9", count: 6 },
  ])
  gate.release()
  await q.pending
  expect(ran).toEqual(["event-0", "event-1", "event-2", "event-3"])
})

test("capture queue resumes admitting events once the backlog drains", async () => {
  const gate = deferred()
  const { q, ran, dropped } = queue({ limit: 2, hold: gate.gate })
  q.push("first", {}, undefined)
  q.push("second", {}, undefined)
  q.push("dropped", {}, undefined)
  gate.release()
  await q.pending
  q.push("third", {}, undefined)
  await q.pending
  expect(dropped).toEqual([{ method: "dropped", count: 1 }])
  expect(ran).toEqual(["first", "second", "third"])
})

test("capture queue reports run errors and keeps draining", async () => {
  const ran: string[] = []
  const errors: unknown[] = []
  const failure = new Error("flow capacity")
  const q2 = createCaptureQueue({
    run: async (method) => {
      if (method === "bad") throw failure
      ran.push(method)
    },
    drop: () => undefined,
    error: (error) => errors.push(error),
  })
  q2.push("bad", {}, undefined)
  q2.push("after", {}, undefined)
  await q2.pending
  expect(errors).toEqual([failure])
  expect(ran).toEqual(["after"])
})

test(`capture backlog defaults to ${CAPTURE_BACKLOG_LIMIT} queued events`, async () => {
  const gate = deferred()
  const { q, dropped } = queue({ hold: gate.gate })
  for (let index = 0; index < CAPTURE_BACKLOG_LIMIT + 5; index++) q.push("Network.responseReceived", {}, undefined)
  expect(dropped).toHaveLength(5)
  gate.release()
  await q.pending
})
