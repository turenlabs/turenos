import { expect, test } from "bun:test"
import type { MessagesListOutput } from "@turenlabs/client"
import { createDialogs } from "../src/dialogs"
import { message, waitForFrame, fixture } from "./conversation-scroll-fixture"

const arrived = (id: string): MessagesListOutput["data"][number] => ({
  id,
  type: "user",
  text: "Sent just now",
  time: { created: 2 },
})

test("sending a message while scrolled up jumps to the tail", async () => {
  const f = await fixture()
  f.top()
  await waitForFrame(f.view, (frame) => frame.includes("Live line 0"))
  f.state.sentMessages.add("msg_sent")
  f.data.latest = [arrived("msg_sent"), ...f.data.latest]
  await f.conversation.render()
  await waitForFrame(f.view, (frame) => frame.includes("Sent just now"))
})

test("a user message from another client leaves a scrolled-up reader in place", async () => {
  const f = await fixture()
  f.top()
  await waitForFrame(f.view, (frame) => frame.includes("Live line 0"))
  const scrolled = f.ui.detail.scrollTop
  f.data.latest = [arrived("msg_elsewhere"), ...f.data.latest]
  await f.conversation.render()
  await f.view.renderOnce()
  expect(f.ui.detail.scrollTop).toBe(scrolled)
  expect(f.view.captureCharFrame()).toContain("Live line 0")
  expect(f.view.captureCharFrame()).not.toContain("Sent just now")
})

test("new output below a scrolled-up reader is announced until they return to the tail", async () => {
  const f = await fixture()
  f.top()
  await waitForFrame(f.view, (frame) => frame.includes("Live line 0"))
  expect(f.view.captureCharFrame()).not.toContain("new output below")
  f.data.latest = [message("msg_more", "More output"), ...f.data.latest]
  await f.conversation.render()
  await waitForFrame(f.view, (frame) => frame.includes("↓ new output below · End"))
  f.conversation.cancelPosition()
  f.ui.detail.scrollTo(Number.MAX_SAFE_INTEGER)
  await waitForFrame(f.view, (frame) => frame.includes("More output") && !frame.includes("new output below"))
})

test("a reader above the latest output sees a calm cue until they return to the tail", async () => {
  const f = await fixture()
  f.top()
  await waitForFrame(
    f.view,
    (frame) => frame.includes("Live line 0") && frame.includes("↑ scrolled up · End for latest"),
  )
  expect(f.view.captureCharFrame()).not.toContain("new output below")
  f.conversation.cancelPosition()
  f.ui.detail.scrollTo(Number.MAX_SAFE_INTEGER)
  await waitForFrame(f.view, (frame) => frame.includes("Live line 44") && !frame.includes("scrolled up"))
})

test("one message past the rich budget degrades alone: the short one stays rich and no role chip shows backticks", async () => {
  const long = Array.from({ length: 400 }, (_, i) => `Long line ${i} of a very long reply`).join("\n")
  const f = await fixture([message("msg_short", "**Bold head**\nShort marker"), message("msg_long", long)])
  const frame = f.view.captureCharFrame()
  expect(frame).toContain("Bold head")
  expect(frame).not.toContain("**Bold head**")
  expect(frame).not.toContain("`")
  expect(f.content()).toContain("`USER`\n**Bold head**")
  expect(f.content()).toContain("```text\nUSER\nLong line 0")
})

function readTurn(): MessagesListOutput["data"] {
  const model = { providerID: "sandbox", id: "scripted" }
  const rows = Array.from({ length: 30 }, (_, index) => `file row ${index + 1}`).join("\n")
  const read = {
    type: "tool",
    id: "call_read",
    name: "read",
    time: { created: 1 },
    state: { status: "completed", input: { path: "big.txt" }, structured: {}, content: [{ type: "text", text: rows }] },
  }
  return [
    message("msg_prompt", "Read the file"),
    { id: "msg_step1", type: "assistant", agent: "build", model, time: { created: 1, completed: 2 }, content: [read] },
    {
      id: "msg_step2",
      type: "assistant",
      agent: "build",
      model,
      time: { created: 2, completed: 3 },
      content: [{ type: "text", id: "part_done", text: "All read." }],
    },
  ] as MessagesListOutput["data"]
}

test("Ctrl+O's toggle folds and unfolds tool output in the live transcript, including for earlier pages", async () => {
  // The server lists newest first.
  const f = await fixture(readTurn().slice(1).reverse())
  f.data.older = [readTurn()[0]!]
  expect(f.content()).toContain("+26 lines")
  expect(f.content()).not.toContain("file row 30")
  f.conversation.toggleToolOutput()
  await waitForFrame(f.view, () => f.content().includes("file row 30"))
  expect(f.content()).not.toContain("+26 lines")
  f.conversation.toggleToolOutput()
  await waitForFrame(f.view, () => f.content().includes("+26 lines"))
  expect(f.state.expandToolOutput).toBe(false)
  f.top()
  await f.conversation.scrollEarlier()
  expect(f.content()).toContain("Read the file")
  expect(f.content()).toContain("+26 lines")
})

test("steps of one turn keep a single header when earlier history joins them", async () => {
  const [prompt, first, second] = readTurn()
  const f = await fixture([second!])
  f.data.older = [first!, prompt!]
  expect(f.content().match(/sandbox\/scripted/g)?.length).toBe(1)
  f.top()
  await f.conversation.scrollEarlier()
  await waitForFrame(f.view, () => f.content().includes("Read the file"))
  expect(f.content().match(/sandbox\/scripted/g)?.length).toBe(1)
  expect(f.content()).toContain("All read.")
})

test.each([
  ["the docked reply editor", true, ["older"]],
  ["a real dialog", false, []],
])("paging up at the top with %s open (fetches: %p)", async (_, composer, expected) => {
  const f = await fixture()
  f.conversation.cancelPosition()
  const dialogs = createDialogs(f.view.renderer, f.state, f.ui, {
    rememberPosition: f.conversation.rememberPosition,
    cancelPosition: f.conversation.cancelPosition,
    changed: () => f.ui.resize(),
    submitted: async () => {},
    say() {},
  })
  const dialog = dialogs.open("Reply", false, 24, true)!
  dialog.composer = composer
  dialogs.prompt(dialog, "Message", "")
  f.ui.resize()
  f.ui.detail.scrollTo(0)
  const before = await waitForFrame(f.view, (frame) => frame.includes("Live line 0"))
  const row = before.split("\n").findIndex((line) => line.includes("Live line 0"))
  const height = f.ui.detail.scrollHeight
  await f.conversation.scrollEarlier()
  await f.view.renderOnce()
  expect(f.cursors.filter(Boolean)).toEqual(expected)
  if (!composer) return
  await waitForFrame(f.view, (frame) => frame.includes("Live line 0") && f.ui.detail.scrollHeight > height)
  expect(f.ui.detail.scrollTop).toBe(f.ui.detail.scrollHeight - height)
  expect(f.view.captureCharFrame().split("\n")[row]).toContain("Live line 0")
})
