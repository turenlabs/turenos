import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { QuestionsListOutput } from "@turenlabs/client"
import { createConversation } from "../src/conversation"
import { createDialogs } from "../src/dialogs"
import { createLayout } from "../src/layout"
import { connect, type Session } from "../src/server"
import { createDashboardState } from "../src/state"
import { message, waitForFrame, fixture, cleanup } from "./conversation-scroll-fixture"

test.each(["stream", "poll"])(
  "docked Reply paging retains the first of six messages during %s updates",
  async (update) => {
    const latest = Array.from({ length: 6 }, (_, i) =>
      message(
        `msg_reply_${5 - i}`,
        Array.from({ length: 45 }, (_, row) => `Reply context ${5 - i} row ${row}`).join("\n"),
      ),
    )
    const f = await fixture(latest)
    f.conversation.cancelPosition()
    const dialogs = createDialogs(f.view.renderer, f.state, f.ui, {
      rememberPosition: f.conversation.rememberPosition,
      cancelPosition: f.conversation.cancelPosition,
      changed: () => f.ui.resize(),
      submitted: async () => {},
      say() {},
    })
    f.view.renderer.keyInput.on("keypress", dialogs.keypress)
    const dialog = dialogs.open("Reply", false, 24, true)!
    const editor = dialogs.prompt(dialog, "Message", "Keep this draft")
    f.ui.resize()
    editor.focus()
    await f.view.renderOnce()
    f.ui.detail.scrollTo(30 + Math.max(1, f.ui.detail.viewport.height - 1))
    await f.view.renderOnce()
    f.view.mockInput.pressKey("\u001b[5~") // Page Up
    const before = await waitForFrame(f.view, (frame) => frame.includes("Reply context 0 row 30"))
    const row = before.split("\n").findIndex((line) => line.includes("Reply context 0 row 30"))
    const anchored = f.ui.detail.scrollTop
    const seventh = message("msg_reply_seventh", "Seventh reply message")
    if (update === "stream") f.conversation.updateLive([...f.state.detail!.messages, seventh])
    else {
      f.data.latest = [seventh, ...latest]
      await f.conversation.render()
    }
    expect(f.content()).toContain("Reply context 0 row 0")
    await waitForFrame(f.view, (frame) => frame.includes("Reply context 0 row 30"))
    expect(f.ui.detail.scrollTop).toBe(anchored)
    expect(f.view.captureCharFrame().split("\n")[row]).toContain("Reply context 0 row 30")
    expect(editor.plainText).toBe("Keep this draft")
    expect(editor.focused).toBe(true)
    expect(f.cursors.filter(Boolean)).toEqual([])
  },
)

test("an older response cannot hide a question introduced by a poll", async () => {
  const f = await fixture()
  f.top()
  let release!: () => void
  f.data.gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const pending = f.conversation.scrollEarlier()
  f.data.questions = [
    {
      id: "que_first",
      sessionID: "ses_first",
      questions: [
        { header: "Choice", question: "Which region?", options: [{ label: "West", description: "Nearest region" }] },
      ],
    },
  ]
  await f.conversation.render()
  await waitForFrame(f.view, (frame) => frame.includes("Which region?"))
  release()
  await pending
  await waitForFrame(f.view, (frame) => frame.includes("Which region?"))
  expect(f.ui.detail.scrollTop).toBe(0)
  expect(f.content()).not.toContain("Earlier prompt")
  f.data.questions = []
  await f.conversation.render()
  f.top()
  await f.conversation.scrollEarlier()
  expect(f.cursors.filter(Boolean)).toEqual(["older", "older"])
  expect(f.content()).toContain("Earlier prompt")
})

test("initial session load paints the tail on the very first frame without flashing top messages", async () => {
  const lines = Array.from({ length: 45 }, (_, i) => `Fresh line ${i}`)
  const latest = [message("msg_flash_test", lines.join("\n"))]
  const data = { latest, older: [], questions: [] as QuestionsListOutput }
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith("/message")) return Response.json({ data: data.latest, cursor: {} })
      if (url.pathname.endsWith("/task")) return Response.json({ data: [], active: [], cursor: {} })
      if (url.pathname.includes("/question")) return Response.json({ data: data.questions })
      return Response.json({ data: [] })
    },
  })
  cleanup.push(() => server.stop(true))
  const connection = connect({ url: server.url.href })
  cleanup.push(connection.close)
  const state = createDashboardState()
  const session: Session = {
    id: "ses_fresh",
    title: "Fresh session",
    projectID: "project",
    agent: "build",
    location: { directory: "/fixture" },
    time: { created: 1, updated: 1 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  state.selected = session.id
  state.snapshot = {
    location: { directory: "/fixture", project: { id: "project", directory: "/fixture" } },
    sessions: [session],
    active: {},
    terminals: [],
    terminalsAvailable: true,
    loops: [],
    inventoryErrors: { terminals: "", automations: "" },
    terminalFolderErrors: [],
    updated: 1,
    more: false,
  }
  const view = await createTestRenderer({ width: 80, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  const ui = createLayout(view.renderer, state)
  const conversation = createConversation(state, connection, ui, {
    actions() {},
    clearNotice() {},
    say() {},
  })
  cleanup.push(conversation.dispose)
  ui.resize()
  conversation.loadPosition()
  await conversation.render()

  // Verify that on the VERY FIRST frame rendered, the tail is visible and top is not visible
  await view.renderOnce()
  const firstFrame = view.captureCharFrame()
  expect(firstFrame).toContain("Fresh line 44")
  expect(firstFrame).not.toContain("Fresh line 0")
  expect(ui.detail.scrollTop).toBeGreaterThan(0)
  expect(ui.detail.scrollTop + ui.detail.viewport.height).toBeGreaterThanOrEqual(ui.detail.scrollHeight - 1)
})

test("switching between cached sessions renders immediately at saved scroll without flashing Loading or top lines", async () => {
  const f = await fixture()
  // First session is ses_first with 45 lines ("Live line 0" to "Live line 44").
  // Scroll to middle of session 1:
  f.conversation.cancelPosition()
  f.ui.detail.scrollTo(15)
  await f.view.renderOnce()
  expect(f.view.captureCharFrame()).toContain("Live line 15")

  // Remember position for ses_first
  f.conversation.rememberPosition()

  // Add a second session:
  const session2: Session = {
    id: "ses_second",
    title: "Second session",
    projectID: "project",
    agent: "build",
    location: { directory: "/fixture" },
    time: { created: 2, updated: 2 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  f.state.snapshot!.sessions.push(session2)

  // Switch to session 2
  f.state.selected = session2.id
  f.data.latest = [message("msg_second", Array.from({ length: 45 }, (_, i) => `Second line ${i}`).join("\n"))]
  f.conversation.loadPosition()
  await f.conversation.render()
  await f.view.renderOnce()
  expect(f.view.captureCharFrame()).toContain("Second line 44")
  expect(f.conversation.hasLive(session2.id)).toBe(true)
  expect(f.conversation.hasLive("ses_first")).toBe(true)

  // Now switch back to session 1:
  f.conversation.rememberPosition()
  f.state.selected = "ses_first"
  // loadPosition() will load saved position and draw cached live immediately
  f.conversation.loadPosition()

  // Check state immediately before any renderOnce:
  // Should already have Live line 15 and should NOT be at 0!
  expect(f.ui.detail.scrollTop).toBe(15)

  // Render the very first frame after switching back
  await f.view.renderOnce()
  const switchedFrame = f.view.captureCharFrame()
  expect(switchedFrame).not.toContain("Loading")
  expect(switchedFrame).toContain("Live line 15")
  expect(switchedFrame).not.toContain("Second line")
})

test("expanding six messages to full history preserves reading anchor on the very first rendered frame", async () => {
  const tenMessages = Array.from({ length: 10 }, (_, i) =>
    message(`msg_${9 - i}`, Array.from({ length: 5 }, (_, j) => `Msg ${9 - i} Line ${j}`).join("\n")),
  )
  const f = await fixture(tenMessages)
  // Initially only 6 messages are visible (msg_4 to msg_9)
  // msg_9 is at the tail. Scroll up so msg_7 is in the middle of the viewport:
  f.conversation.cancelPosition()
  f.ui.detail.scrollBy(-5)
  await f.view.renderOnce()
  const beforeFrame = f.view.captureCharFrame()
  const readingLine = "Msg 7 Line 2"
  expect(beforeFrame).toContain(readingLine)
  const beforeRow = beforeFrame.split("\n").findIndex((l) => l.includes(readingLine))

  // Trigger expansion
  await f.conversation.scrollEarlier()

  // On the VERY FIRST frame after scrollEarlier resolves:
  await f.view.renderOnce()
  const afterFrame = f.view.captureCharFrame()
  const afterRow = afterFrame.split("\n").findIndex((l) => l.includes(readingLine))
  expect(afterRow).toBe(beforeRow)
  // Verify prepended messages did not flash at the top
  expect(afterFrame).not.toContain("Msg 0 Line 0")
})

test("prepending older server messages preserves reading anchor on the very first rendered frame", async () => {
  const f = await fixture()
  // Scroll to middle of session 1:
  f.conversation.cancelPosition()
  f.ui.detail.scrollTo(10)
  await f.view.renderOnce()
  const readingLine = "Live line 10"
  const beforeFrame = f.view.captureCharFrame()
  expect(beforeFrame).toContain(readingLine)
  const beforeRow = beforeFrame.split("\n").findIndex((l) => l.includes(readingLine))

  // Supply older messages
  f.data.older = Array.from({ length: 20 }, (_, i) => message(`msg_older_${i}`, `Older line ${i}`))
  await f.conversation.scrollEarlier()

  // On the VERY FIRST frame rendered after scrollEarlier resolves:
  await f.view.renderOnce()
  const afterFrame = f.view.captureCharFrame()
  const afterRow = afterFrame.split("\n").findIndex((l) => l.includes(readingLine))
  expect(afterRow).toBe(beforeRow)
  // Verify older messages are not visible at the top of the viewport (no flash of top prepended lines)
  expect(afterFrame).not.toContain("Older line 0")
})
