import { describe, expect, test } from "bun:test"
import { createLiveProjection } from "../src/live-projection"
import { type Assistant, session, event, assistant, parts, text, start } from "./live-projection-fixture"

describe("selected-session live projection", () => {
  test("a settled persisted overlay leaves when more than a page arrives between snapshots", () => {
    const projection = createLiveProjection(session)
    projection.snapshot([assistant("Old answer")])
    projection.apply(event("step.ended", { finish: "stop", cost: 0, tokens: session.tokens }))
    const page = Array.from({ length: 30 }, (_, i) => ({
      id: `msg_new_${i}`,
      type: "user" as const,
      text: "Newer request",
      time: { created: 0 },
    }))
    expect(projection.snapshot(page)).toEqual(page)
    expect(projection.messages().at(-1)?.id).toBe("msg_new_29")
  })

  test("a settled overlay leaves when an overlapping snapshot advances past it", () => {
    const projection = createLiveProjection(session)
    const anchor = { id: "msg_anchor", type: "user" as const, text: "Next request", time: { created: 0 } }
    // Ordering is the page's order, not its timestamps or lexical IDs.
    projection.snapshot([assistant("Old answer"), anchor])
    projection.apply(event("step.ended", { finish: "stop", cost: 0, tokens: session.tokens }))
    const page = [anchor, ...Array.from({ length: 29 }, (_, i) => ({ ...anchor, id: `msg_new_${i}` }))]
    expect(projection.snapshot(page)).toEqual(page)
    expect(projection.messages().at(-1)?.id).toBe("msg_new_28")
  })

  test("rollover retains a new settled overlay not yet observed in a snapshot", () => {
    const projection = createLiveProjection(session)
    const anchor = { id: "msg_anchor", type: "user" as const, text: "Request", time: { created: 1 } }
    projection.snapshot([anchor])
    start(projection)
    projection.apply(event("text.ended", { textID: "part", text: "Fresh answer" }))
    projection.apply(event("step.ended", { finish: "stop", cost: 0, tokens: session.tokens }))
    expect(projection.snapshot([{ ...anchor, id: "msg_newer" }]).at(-1)).toMatchObject({
      id: "msg_assistant",
      finish: "stop",
    })
  })

  test("empty and older overlapping snapshots retain a settled overlay", () => {
    const projection = createLiveProjection(session)
    const anchor = { id: "msg_anchor", type: "user" as const, text: "Request", time: { created: 1 } }
    projection.snapshot([anchor, assistant("Fresh answer")])
    projection.apply(event("step.ended", { finish: "stop", cost: 0, tokens: session.tokens }))
    expect(projection.snapshot([anchor]).at(-1)?.id).toBe("msg_assistant")
    expect(projection.snapshot([]).at(-1)?.id).toBe("msg_assistant")
  })

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
})
