import { describe, expect, test } from "bun:test"
import { loadSessionV2MessageWindow, SESSION_V2_MESSAGE_PAGE_LIMIT } from "../goal/session-v2-message-window"
import { generateSessionMessages, smallProfile } from "./session-load-fixture"

/**
 * The regression guard for session tab-switch cost.
 *
 * It asserts *invariants*, never milliseconds: this repo does not gate on machine-dependent
 * performance thresholds, and a wall-clock budget here
 * would fail on a loaded CI box while a genuine reintroduction of the full drain — the actual
 * regression — could still slip through under it. What cannot regress silently is the shape of the
 * work: how many requests a cold open makes, how many messages it materialises, and how many bytes
 * it moves. Those are the same on every machine.
 *
 * The stage-by-stage timings live in `session-load-benchmark.ts`, which is run by hand.
 */
describe("session tab-switch load", () => {
  const messages = generateSessionMessages(smallProfile)

  const pageServer = (limit: number, source = messages) => {
    const newestFirst = [...source].reverse()
    let requests = 0
    let served = 0
    return {
      get requests() {
        return requests
      },
      get messagesServed() {
        return served
      },
      load: async (cursor?: string) => {
        requests += 1
        const start = cursor === undefined ? 0 : Number(cursor)
        const data = newestFirst.slice(start, start + limit)
        served += data.length
        return { data, cursor: { next: data.length > 0 ? String(start + limit) : undefined } }
      },
    }
  }

  test("a cold open reads one page, not the whole transcript", async () => {
    const limit = 20
    const server = pageServer(limit)
    const window = await loadSessionV2MessageWindow({ load: server.load, minimum: limit })

    expect(server.requests).toBe(1)
    expect(window.messages).toHaveLength(limit)
    expect(window.messages.length).toBeLessThan(messages.length)
    expect(window.complete).toBe(false)
    expect(window.older).toBeDefined()
  })

  test("the window is the newest messages, in ascending order", async () => {
    const limit = 20
    const window = await loadSessionV2MessageWindow({ load: pageServer(limit).load, minimum: limit })

    const ids = window.messages.map((message) => message.id)
    expect(ids).toEqual([...ids].sort())
    expect(ids.at(-1)).toBe(messages.at(-1)!.id)
    // …and it really is the tail of the transcript, not an arbitrary slice of it.
    expect(ids).toEqual(messages.slice(-limit).map((message) => message.id))
  })

  test("the window carries a fraction of the transcript's bytes", async () => {
    const limit = 20
    const window = await loadSessionV2MessageWindow({ load: pageServer(limit).load, minimum: limit })

    const bytes = (list: readonly unknown[]) => list.reduce<number>((t, m) => t + JSON.stringify(m).length, 0)
    expect(bytes(window.messages)).toBeLessThan(bytes(messages) / 2)
  })

  test("widening reaches further back without dropping what was already loaded", async () => {
    const limit = 20
    const first = await loadSessionV2MessageWindow({ load: pageServer(limit).load, minimum: limit })
    const wider = await loadSessionV2MessageWindow({
      load: pageServer(limit).load,
      minimum: first.messages.length + limit,
      until: first.messages[0]!.id,
    })

    expect(wider.messages.length).toBeGreaterThan(first.messages.length)
    // Every message on screen before the widening is still on screen after it.
    const widerIDs = new Set(wider.messages.map((message) => message.id))
    first.messages.forEach((message) => expect(widerIDs.has(message.id)).toBe(true))
  })

  test("explicit widening can grow beyond the cold-open safety cap", async () => {
    const large = Array.from({ length: 500 }, (_, index) => messages[index % messages.length]!)
    const server = pageServer(SESSION_V2_MESSAGE_PAGE_LIMIT, large)
    const minimum = SESSION_V2_MESSAGE_PAGE_LIMIT * (8 + 1)
    const window = await loadSessionV2MessageWindow({ load: server.load, minimum })

    expect(window.messages.length).toBeGreaterThanOrEqual(minimum)
    expect(server.requests).toBeGreaterThan(8)
  })

  test("a session shorter than one page is fully loaded and reports no older history", async () => {
    const short = messages.slice(0, SESSION_V2_MESSAGE_PAGE_LIMIT - 1)
    const window = await loadSessionV2MessageWindow({
      load: async (cursor) => {
        const start = cursor === undefined ? 0 : Number(cursor)
        const data = [...short].reverse().slice(start, start + SESSION_V2_MESSAGE_PAGE_LIMIT)
        return {
          data,
          cursor: { next: start + data.length < short.length ? String(start + data.length) : undefined },
        }
      },
      minimum: SESSION_V2_MESSAGE_PAGE_LIMIT,
    })

    expect(window.messages).toHaveLength(short.length)
    expect(window.complete).toBe(true)
    expect(window.older).toBeUndefined()
  })

  test("every window opens on a turn, so nothing is projected without a parent", async () => {
    // `presentSessionV2Messages` drops assistant messages with no preceding user message. A window
    // that contained no turn boundary at all would therefore render blank.
    for (const limit of [8, 20, 40]) {
      const window = await loadSessionV2MessageWindow({ load: pageServer(limit).load, minimum: limit })
      expect(
        window.messages.some(
          (message) => message.type === "user" || message.type === "shell" || message.type === "compaction",
        ),
      ).toBe(true)
    }
  })
})

describe("session load fixture", () => {
  // The fixture is the harness's only claim to relevance, so its shape is asserted rather than
  // assumed. These proportions mirror the measured "Revamp V2" session: a long tail of small
  // messages and a handful of very large ones.
  test("reproduces a skewed size distribution deterministically", () => {
    const first = generateSessionMessages(smallProfile)
    const again = generateSessionMessages(smallProfile)
    expect(first.map((message) => message.id)).toEqual(again.map((message) => message.id))

    const sizes = first.map((message) => JSON.stringify(message).length).sort((a, b) => b - a)
    const total = sizes.reduce((sum, size) => sum + size, 0)
    const topDecile = sizes.slice(0, Math.ceil(sizes.length / 10)).reduce((sum, size) => sum + size, 0)
    expect(topDecile / total).toBeGreaterThan(0.5)
  })

  test("opens on a turn and contains the message types the presenter branches on", () => {
    const messages = generateSessionMessages(smallProfile)
    expect(messages[0]!.type).toBe("user")
    const types = new Set(messages.map((message) => message.type))
    expect(types.has("user")).toBe(true)
    expect(types.has("assistant")).toBe(true)
    expect(types.has("compaction")).toBe(true)
  })
})
