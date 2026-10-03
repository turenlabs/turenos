import { describe, expect, test } from "bun:test"
import type { MessagesListOutput } from "@turenlabs/client"
import { createLiveProjection, type LiveEvent } from "../src/live-projection"
import type { Session } from "../src/server"

type Assistant = Extract<MessagesListOutput["data"][number], { type: "assistant" }>
const session: Session = {
  id: "ses_selected",
  projectID: "project",
  title: "Synthetic",
  location: { directory: "/synthetic" },
  time: { created: 1, updated: 1 },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}
let sequence = 0
function event(type: string, data: Record<string, unknown> = {}, eventID = `evt_${++sequence}`): LiveEvent {
  return {
    id: eventID,
    type: `session.next.${type}`,
    data: {
      sessionID: session.id,
      assistantMessageID: "msg_assistant",
      timestamp: 2,
      ...data,
    },
  }
}
function assistant(text = "", kind: "text" | "reasoning" = "text"): Assistant {
  return {
    id: "msg_assistant",
    type: "assistant",
    agent: "build",
    model: { id: "test", providerID: "test" },
    time: { created: 1 },
    content: [{ id: "part", type: kind, text }],
  }
}
function parts(projection: ReturnType<typeof createLiveProjection>) {
  const message = projection.messages().find((message) => message.type === "assistant")
  if (message?.type !== "assistant") throw new Error("Expected assistant")
  return message.content
}
function text(projection: ReturnType<typeof createLiveProjection>) {
  const part = parts(projection)[0]
  if (!part || part.type === "tool") throw new Error("Expected text or reasoning")
  return part.text
}
function start(projection: ReturnType<typeof createLiveProjection>, messageID = "msg_assistant") {
  return projection.apply(
    event("step.started", { assistantMessageID: messageID, agent: "build", model: { id: "test", providerID: "test" } }),
  )
}

describe("selected-session live projection", () => {
  test("completed snapshots release overlay capacity for later active turns", () => {
    const projection = createLiveProjection(session)
    for (let turn = 0; turn < 20; turn++) {
      const current: Assistant = {
        ...assistant(),
        id: `msg_turn_${turn}`,
        time: { created: turn * 2 },
        content: Array.from({ length: 12 }, (_, part) => ({ id: `part_${part}`, type: "text" as const, text: "" })),
      }
      projection.snapshot([current])
      expect(
        projection.apply(
          event("text.delta", { assistantMessageID: current.id, textID: "part_0", delta: "Still streaming" }),
        ),
      ).toBe(true)
      projection.snapshot([{ ...current, time: { created: turn * 2, completed: turn * 2 + 1 } }])
    }
  })

  for (const kind of ["text", "reasoning"] as const) {
    const identifier = kind === "text" ? "textID" : "reasoningID"
    test(`${kind}: snapshot -> delta -> lagging snapshot retains the live cursor`, () => {
      const projection = createLiveProjection(session)
      const original = [assistant("Hello", kind)]
      projection.snapshot(original)
      expect(projection.apply(event(`${kind}.delta`, { [identifier]: "part", delta: " world" }))).toBe(true)
      expect(text(projection)).toBe("Hello world")
      projection.snapshot([assistant("Hello", kind)])
      expect(text(projection)).toBe("Hello world")
      expect(original[0]!.content[0]).toEqual({ id: "part", type: kind, text: "Hello" })
      projection.apply(event(`${kind}.delta`, { [identifier]: "part", delta: "!" }))
      expect(text(projection)).toBe("Hello world!")
    })

    test(`${kind}: snapshots containing delivered or in-flight deltas do not duplicate`, () => {
      const projection = createLiveProjection(session)
      projection.snapshot([assistant("A", kind)])
      projection.apply(event(`${kind}.delta`, { [identifier]: "part", delta: "B" }))
      projection.snapshot([assistant("ABC", kind)])
      expect(text(projection)).toBe("ABC")
      projection.apply(event(`${kind}.delta`, { [identifier]: "part", delta: "C" }))
      expect(text(projection)).toBe("ABC")
      projection.snapshot([assistant("ABC", kind)])
      projection.apply(event(`${kind}.delta`, { [identifier]: "part", delta: "D" }))
      expect(text(projection)).toBe("ABCD")
      expect(parts(projection)).toHaveLength(1)
    })

    test(`${kind}: full ended text replaces longer text and survives stale snapshots`, () => {
      const projection = createLiveProjection(session)
      projection.snapshot([assistant("long draft", kind)])
      projection.apply(event(`${kind}.ended`, { [identifier]: "part", text: "final" }))
      projection.snapshot([assistant("long draft", kind)])
      expect(text(projection)).toBe("final")
      expect(projection.apply(event(`${kind}.delta`, { [identifier]: "part", delta: "late" }))).toBe(false)
      expect(text(projection)).toBe("final")
    })

    test(`${kind}: oversized completion falls back to a full snapshot without pinning a truncated value`, () => {
      const projection = createLiveProjection(session)
      projection.snapshot([assistant("", kind)])
      projection.apply(event(`${kind}.delta`, { [identifier]: "part", delta: "x".repeat(65_536) }))
      const full = "x".repeat(65_537)
      expect(projection.apply(event(`${kind}.ended`, { [identifier]: "part", text: full }))).toBe(false)
      projection.snapshot([{ ...assistant(full, kind), time: { created: 1, completed: 2 } }])
      expect(text(projection)).toBe(full)
    })
  }

  test("identical delta strings append; only equal event IDs deduplicate", () => {
    const projection = createLiveProjection(session)
    start(projection)
    projection.apply(event("text.started", { textID: "part" }))
    const delta = event("text.delta", { textID: "part", delta: "ha" })
    expect(projection.apply(delta)).toBe(true)
    expect(projection.apply(delta)).toBe(false)
    projection.apply(event("text.delta", { textID: "part", delta: "ha" }))
    expect(text(projection)).toBe("haha")
    expect(projection.apply(event("text.started", { textID: "part" }))).toBe(false)
    expect(parts(projection)).toHaveLength(1)
  })

  test("no-base fragments are dropped, not guessed or queued; snapshot or full ended recovers", () => {
    const projection = createLiveProjection(session)
    const delta = event("text.delta", { textID: "part", delta: "ambiguous" })
    expect(projection.apply(delta)).toBe(false)
    start(projection)
    expect(projection.apply(delta)).toBe(false)
    expect(parts(projection)).toHaveLength(0)
    projection.snapshot([assistant("authoritative")])
    expect(text(projection)).toBe("authoritative")
    projection.apply(event("text.delta", { textID: "part", delta: " next" }))
    expect(text(projection)).toBe("authoritative next")
    projection.apply(event("text.ended", { textID: "other", text: "recovered" }))
    expect(parts(projection)[1]).toEqual({ id: "other", type: "text", text: "recovered" })
  })

  test("non-prefix snapshot conflicts prefer snapshot until authoritative ended, not overlap guessing", () => {
    const projection = createLiveProjection(session)
    projection.snapshot([assistant("abc")])
    projection.apply(event("text.delta", { textID: "part", delta: "def" }))
    projection.snapshot([assistant("xyz")])
    expect(text(projection)).toBe("xyz")
    projection.apply(event("text.ended", { textID: "part", text: "settled" }))
    expect(text(projection)).toBe("settled")
  })

  test("ahead snapshot high-water text survives a later lagging snapshot", () => {
    const projection = createLiveProjection(session)
    projection.snapshot([assistant("A")])
    projection.apply(event("text.delta", { textID: "part", delta: "B" }))
    projection.snapshot([assistant("ABC")])
    projection.snapshot([assistant("A")])
    expect(text(projection)).toBe("ABC")
    projection.apply(event("text.delta", { textID: "part", delta: "C" }))
    expect(text(projection)).toBe("ABC")
  })

  test("event ID retention is bounded, not permanent text deduplication", () => {
    const projection = createLiveProjection(session)
    projection.snapshot([assistant("")])
    const first = event("text.delta", { textID: "part", delta: "a" })
    projection.apply(first)
    for (let index = 0; index < 4096; index++) projection.apply(event("text.delta", { textID: "part", delta: "b" }))
    expect(projection.apply(first)).toBe(true)
    expect(text(projection)).toHaveLength(4098)
  })

  test("snapshots advance untouched tools and replayed called cannot erase live progress", () => {
    const projection = createLiveProjection(session)
    const tool = (value: string): Assistant => ({
      ...assistant(),
      content: [
        {
          type: "tool",
          id: "call",
          name: "read",
          time: { created: 1, ran: 1 },
          state: { status: "running", input: {}, structured: {}, content: [{ type: "text", text: value }] },
        },
      ],
    })
    projection.snapshot([tool("first")])
    projection.snapshot([tool("second")])
    expect(parts(projection)[0]).toMatchObject({ state: { content: [{ type: "text", text: "second" }] } })
    projection.apply(
      event("tool.progress", { callID: "call", structured: {}, content: [{ type: "text", text: "live" }] }),
    )
    projection.snapshot([tool("first")])
    expect(parts(projection)[0]).toMatchObject({ state: { content: [{ type: "text", text: "live" }] } })
    expect(
      projection.apply(
        event("tool.called", { callID: "call", tool: "read", input: {}, provider: { executed: false } }),
      ),
    ).toBe(false)
    expect(parts(projection)[0]).toMatchObject({ state: { content: [{ type: "text", text: "live" }] } })
  })

  test("unknown, malformed and foreign-session events do not mutate or consume IDs", () => {
    const projection = createLiveProjection(session)
    projection.snapshot([assistant("safe")])
    const before = projection.messages()
    const invalid: LiveEvent[] = [
      event("text.delta", { textID: "part", delta: 1 }),
      event("text.delta", { textID: "part", delta: "bad", sessionID: "ses_foreign" }),
      event("text.delta", { textID: "part", delta: "bad", timestamp: NaN }),
      event("text.delta", { textID: "part", delta: "bad", assistantMessageID: [] }),
      event("text.progress", { textID: "part", delta: "bad" }),
      event("step.ended", { finish: "stop", cost: 0, tokens: {} }),
      { id: "null", type: "session.next.text.delta", data: null },
      { id: "array", type: "session.next.text.delta", data: [] },
      event("step.failed", { error: { type: "unknown", message: 10 } }),
    ]
    for (const item of invalid) {
      expect(projection.apply(item)).toBe(false)
      expect(projection.messages()).toEqual(before)
    }
    const bad = event("text.delta", { textID: "part", delta: null }, "retry-id")
    expect(projection.apply(bad)).toBe(false)
    expect(projection.apply(event("text.delta", { textID: "part", delta: "!" }, "retry-id"))).toBe(true)
    expect(text(projection)).toBe("safe!")
  })

  test("tool input streams, full input replaces, progress replaces before success", () => {
    const projection = createLiveProjection(session)
    start(projection)
    projection.apply(event("tool.input.started", { callID: "call", name: "read" }))
    projection.apply(event("tool.input.delta", { callID: "call", delta: "{draft" }))
    expect(parts(projection)[0]).toMatchObject({ state: { status: "pending", input: "{draft" } })
    projection.apply(event("tool.input.ended", { callID: "call", text: "{}" }))
    expect(parts(projection)[0]).toMatchObject({ state: { input: "{}" } })
    projection.apply(
      event("tool.called", {
        callID: "call",
        tool: "read",
        input: { path: "synthetic" },
        provider: { executed: false },
      }),
    )
    projection.apply(
      event("tool.progress", {
        callID: "call",
        structured: { phase: "one" },
        content: [{ type: "text", text: "working" }],
      }),
    )
    expect(parts(projection)[0]).toMatchObject({
      state: { status: "running", content: [{ type: "text", text: "working" }] },
    })
    projection.apply(
      event("tool.progress", {
        callID: "call",
        structured: { phase: "two" },
        content: [{ type: "text", text: "replaced" }],
      }),
    )
    expect(parts(projection)[0]).toMatchObject({
      state: { structured: { phase: "two" }, content: [{ type: "text", text: "replaced" }] },
    })
    const before = projection.messages()
    expect(
      projection.apply(
        event("tool.progress", { callID: "call", structured: {}, content: [{ type: "text", text: 5 }] }),
      ),
    ).toBe(false)
    expect(projection.messages()).toEqual(before)
    projection.apply(
      event("tool.success", {
        callID: "call",
        structured: {},
        content: [{ type: "text", text: "done" }],
        provider: { executed: true },
      }),
    )
    expect(parts(projection)[0]).toMatchObject({
      state: { status: "completed", content: [{ type: "text", text: "done" }] },
      time: { completed: 2 },
    })
  })

  test("tool failed and step failed settle the owned message", () => {
    const projection = createLiveProjection(session)
    start(projection)
    projection.apply(event("tool.input.started", { callID: "call", name: "read" }))
    const error = { type: "unknown", message: "synthetic failure" }
    projection.apply(event("tool.failed", { callID: "call", error, provider: { executed: false } }))
    expect(parts(projection)[0]).toMatchObject({ state: { status: "error", error } })
    projection.apply(event("step.failed", { error }))
    expect(projection.messages()[0]).toMatchObject({ finish: "error", error, time: { completed: 2 } })
  })

  test("step completion records authoritative usage and ignores later fragments", () => {
    const projection = createLiveProjection(session)
    projection.snapshot([assistant("answer")])
    projection.apply(event("step.ended", { finish: "stop", cost: 0.5, tokens: session.tokens }))
    expect(projection.messages()[0]).toMatchObject({
      finish: "stop",
      cost: 0.5,
      tokens: session.tokens,
      time: { completed: 2 },
    })
    expect(projection.apply(event("text.delta", { textID: "part", delta: "late" }))).toBe(false)
  })

  test("completed snapshot messages reject late delta fragments without a live step", () => {
    const projection = createLiveProjection(session)
    projection.snapshot([{ ...assistant("finished"), time: { created: 1, completed: 2 } }])
    expect(projection.apply(event("text.delta", { textID: "part", delta: "late" }))).toBe(false)
    expect(text(projection)).toBe("finished")
  })

  test("live message, part and text retention is bounded", () => {
    const projection = createLiveProjection(session)
    for (let index = 0; index < 40; index++) start(projection, `msg_${index}`)
    expect(projection.messages()).toHaveLength(30)
    const assistantMessageID = "msg_39"
    for (let index = 0; index < 140; index++)
      projection.apply(event("text.started", { assistantMessageID, textID: `part_${index}` }))
    const message = projection.messages().at(-1)
    expect(message?.type === "assistant" && message.content.length).toBe(128)
    projection.apply(event("text.delta", { assistantMessageID, textID: "part_0", delta: "x".repeat(65_536) }))
    projection.apply(event("text.delta", { assistantMessageID, textID: "part_0", delta: "y".repeat(65_536) }))
    const updated = projection.messages().at(-1)
    const part = updated?.type === "assistant" ? updated.content[0] : undefined
    expect(part?.type === "text" && part.text.length).toBe(65_536)
  })
})
