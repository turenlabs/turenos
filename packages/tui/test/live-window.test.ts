import { expect, test } from "bun:test"
import { mergeLive } from "../src/conversation/live-cache"
import type { Conversation } from "../src/conversation/context"

const user = (id: string, text = "hello") => ({ id, type: "user", text, time: { created: 1 } })
const assistant = (id: string, text: string, parts = 1) => ({
  id,
  type: "assistant",
  agent: "build",
  model: { providerID: "test", id: "model" },
  time: { created: 2 },
  content: Array.from({ length: parts }, (_, index) => ({
    id: `${id}_${index}`,
    type: "text",
    text: `${text}${index}`,
  })),
})
// Each text part is shown up to 16,000 characters, so eight of them exceed the 80,000-character window alone.
const big = (id: string, tail = "") => assistant(id, "x".repeat(15000) + tail, 8)

function conversation() {
  const notices: string[] = []
  const c = {
    state: {
      selected: "ses_live",
      expandToolOutput: false,
      rawResponses: false,
      detail: { cursor: {}, questions: [] },
    },
    live: new Map(),
    positions: new Map(),
    generation: 0,
    hooks: { say: (message: string) => notices.push(message) },
  } as unknown as Conversation
  const ids = () => c.live.get("ses_live")!.messages.map((item) => item.id)
  const merge = (messages: unknown[], older = false) => mergeLive(c, messages as never, older)
  return { merge, ids, notices }
}

test("a running reply larger than the window stays through refetches of the same page", () => {
  const { merge, ids } = conversation()
  expect(merge([user("U"), big("A")]).capped).toBe(true)
  expect(ids()).toEqual(["A"])
  for (const tail of ["y", "yz", "yza"]) {
    const page = merge([user("U"), big("A", tail)])
    expect(ids()).toEqual(["A"])
    expect(page.messages[0]!.raw).toContain(`${tail}0`)
  }
})

test("a refetched page keeps server order instead of the cached order", () => {
  const { merge, ids } = conversation()
  merge([user("U1"), assistant("A1", "one"), user("U2"), assistant("A2", "two")])
  merge([user("U2"), assistant("A2", "two!"), user("U3"), assistant("A3", "three")])
  expect(ids()).toEqual(["U1", "A1", "U2", "A2", "U3", "A3"])
  merge([user("U2"), assistant("A2", "two!!"), user("U3"), assistant("A3", "three!")])
  expect(ids()).toEqual(["U1", "A1", "U2", "A2", "U3", "A3"])
})

test("an older page goes before the cached messages in chronological order", () => {
  const { merge, ids } = conversation()
  merge([user("U3"), assistant("A3", "three")])
  merge([user("U1"), assistant("A1", "one"), user("U2"), assistant("A2", "two")], true)
  expect(ids()).toEqual(["U1", "A1", "U2", "A2", "U3", "A3"])
})

test("the newest message survives trimming and only evicted history sets the notice", () => {
  const { merge, ids } = conversation()
  expect(merge([user("U"), assistant("A", "short")]).capped).toBe(false)
  expect(merge([assistant("A", "short"), big("L")]).capped).toBe(true)
  expect(ids()).toEqual(["L"])

  const lone = conversation()
  expect(lone.merge([big("L")]).capped).toBe(false)
  expect(lone.ids()).toEqual(["L"])

  const many = conversation()
  const page = Array.from({ length: 121 }, (_, index) => user(`U${String(index).padStart(3, "0")}`))
  expect(many.merge(page).capped).toBe(true)
  expect(many.ids()).toEqual(page.slice(1).map((item) => item.id))
})

test("an older page never replaces a message that is already cached", () => {
  const { merge, ids } = conversation()
  merge([user("U2"), assistant("A2", "latest")])
  const page = merge([user("U1"), assistant("A2", "stale")], true)
  expect(ids()).toEqual(["U1", "U2", "A2"])
  expect(page.messages.at(-1)!.raw).toContain("latest0")
})
