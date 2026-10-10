import { expect, test } from "bun:test"
import { mergeLive } from "../src/conversation/live-cache"
import { assistant } from "./support"

const user = (id: string, text: string) => ({ id: `msg_${id}`, type: "user", text, time: { created: 1 } })
const step = (id: string, text: string, completed?: number) =>
  assistant(id, text, { time: { created: 10, ...(completed ? { completed } : {}) }, finish: completed && "tool-calls" })

function conversation() {
  return {
    state: { selected: "ses_a", expandToolOutput: false, snapshot: { sessions: [{ id: "ses_a" }] } },
    live: new Map(),
    positions: new Map(),
    hooks: { say: () => {} },
    generation: 0,
  }
}

const paint = (c: ReturnType<typeof conversation>, messages: unknown[]) => [
  ...mergeLive(c as never, messages as never).messages,
]
const texts = (entries: { formatted: string; raw: string }[]) => entries.map((item) => [item.formatted, item.raw])

test("a live paint reuses the text of messages that did not change and matches a full rebuild", () => {
  const earlier = [user("u0", "first question"), step("a0", "first answer", 20), user("u1", "second question")]
  const first = step("a1", "reading files", 30)
  const c = conversation()
  const before = paint(c, [...earlier, first, step("a2", "partial")])
  const after = paint(c, [...earlier, first, step("a2", "partial and more")])
  // The earlier messages are untouched; the running step and the header of its turn are rebuilt.
  expect(after.slice(0, 3)).toEqual(before.slice(0, 3))
  after.slice(0, 3).forEach((item, index) => expect(item).toBe(before[index]!))
  expect(after[3]).not.toBe(before[3])
  expect(after[4]!.formatted).toContain("partial and more")
  // When the running step completes, the turn's header shows the whole turn's time, as a fresh build does.
  const done = [...earlier, first, step("a2", "partial and more", 50)]
  expect(texts(paint(c, done))).toEqual(texts(paint(conversation(), done)))
})
