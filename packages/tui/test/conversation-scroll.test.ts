import { afterEach, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { MessagesListOutput, QuestionsListOutput } from "@turenlabs/client"
import { createConversation } from "../src/conversation"
import { createDialogs } from "../src/dialogs"
import { createLayout } from "../src/layout"
import { connect, type Session } from "../src/server"
import { createDashboardState } from "../src/state"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose()
})

function message(id: string, text: string): MessagesListOutput["data"][number] {
  return { id, type: "user", text, time: { created: 1 } }
}

async function waitForFrame(
  view: Awaited<ReturnType<typeof createTestRenderer>>,
  predicate: (frame: string) => boolean,
) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    await view.renderOnce()
    const frame = view.captureCharFrame()
    if (predicate(frame)) return frame
    await Bun.sleep(10)
  }
  throw new Error(`Expected frame did not appear:\n${view.captureCharFrame()}`)
}

async function fixture(latest?: MessagesListOutput["data"]) {
  const data = {
    latest: latest ?? [message("msg_latest", Array.from({ length: 45 }, (_, i) => `Live line ${i}`).join("\n"))],
    older: [message("msg_old", "Earlier prompt\nEarlier reply")],
    next: undefined as string | undefined,
    gate: undefined as Promise<void> | undefined,
    fail: false,
    questions: [] as QuestionsListOutput,
  }
  const cursors: (string | null)[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/message")) {
        const cursor = url.searchParams.get("cursor")
        cursors.push(cursor)
        if (cursor) {
          await data.gate
          if (data.fail) return new Response("Unavailable", { status: 503 })
          return Response.json({ data: data.older, cursor: { next: data.next } })
        }
        return Response.json({ data: data.latest, cursor: { next: "older" } })
      }
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
    id: "ses_first",
    title: "Scroll fixture",
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
    updated: 1,
    more: false,
  }
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  const ui = createLayout(view.renderer, state)
  let rendered = ""
  const renderContent = ui.renderContent
  ui.renderContent = (value, rich) => {
    rendered = value
    renderContent(value, rich)
  }
  const notices: string[] = []
  const conversation = createConversation(state, connection, ui, {
    actions() {},
    clearNotice() {},
    say(text) {
      notices.push(text)
    },
  })
  cleanup.push(conversation.dispose)
  ui.resize()
  conversation.loadPosition()
  await conversation.render()
  const newest = data.latest[0]!
  const tail = "text" in newest ? newest.text.split("\n").at(-1)! : ""
  await waitForFrame(view, (frame) => !!tail && frame.includes(tail))
  const top = () => {
    conversation.cancelPosition()
    ui.detail.scrollTo(0)
  }
  return { data, state, ui, view, conversation, cursors, notices, top, content: () => rendered }
}

test("live prepend keeps the reading anchor, deduplicates, and survives polling without changing latest detail", async () => {
  const f = await fixture()
  f.top()
  const before = await waitForFrame(f.view, (frame) => frame.includes("Live line 0"))
  const height = f.ui.detail.scrollHeight
  f.data.older = [message("msg_latest", "Stale duplicate"), ...f.data.older]
  await f.conversation.scrollEarlier()
  await waitForFrame(f.view, (frame) => frame.includes("Live line 0") && f.ui.detail.scrollHeight > height)
  expect(f.ui.detail.scrollTop).toBe(f.ui.detail.scrollHeight - height)
  expect(
    f.view
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => line.includes("Live line 0")),
  ).toBe(before.split("\n").findIndex((line) => line.includes("Live line 0")))
  expect(f.state.detail?.messages.map((item) => item.id)).toEqual(["msg_latest"])
  const anchored = f.ui.detail.scrollTop
  f.data.latest = [message("msg_append", "Appended while reading"), ...f.data.latest]
  await f.conversation.render()
  await waitForFrame(f.view, (frame) => frame.includes("Live line 0"))
  expect(f.ui.detail.scrollTop).toBe(anchored)
  expect(f.view.captureCharFrame()).toContain("Live line 0")
  f.top()
  await waitForFrame(f.view, (frame) => frame.includes("Earlier prompt"))
  expect(f.view.captureCharFrame()).toContain("Earlier prompt")
  expect(f.view.captureCharFrame()).not.toContain("Stale duplicate")
  await f.conversation.render()
  await f.conversation.scrollEarlier()
  await waitForFrame(f.view, (frame) => frame.includes("Earlier prompt"))
  expect(f.view.captureCharFrame()).toContain("Earlier prompt")
  expect(f.cursors.filter(Boolean)).toEqual(["older"])
  f.conversation.cancelPosition()
  f.ui.detail.scrollTo(Number.MAX_SAFE_INTEGER)
  f.data.latest = [message("msg_new", "Newest tail"), ...f.data.latest]
  await f.conversation.render()
  await waitForFrame(f.view, (frame) => frame.includes("Newest tail"))
  expect(f.view.captureCharFrame()).toContain("Newest tail")
})

test.each(["session", "tab", "history"])(
  "ignores an older response after a %s change and prevents overlapping loads",
  async (change) => {
    const f = await fixture()
    f.top()
    let release!: () => void
    f.data.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = f.conversation.scrollEarlier()
    await f.conversation.scrollEarlier()
    if (change === "session") {
      f.state.selected = "ses_other"
      f.conversation.loadPosition()
    }
    if (change === "tab") f.state.tab = "terminals"
    if (change === "history") f.state.history = true
    release()
    await pending
    expect(f.cursors.filter(Boolean)).toEqual(["older"])
    f.state.selected = "ses_first"
    f.state.tab = "sessions"
    f.state.history = false
    f.conversation.loadPosition()
    await f.conversation.render()
    f.top()
    await waitForFrame(f.view, (frame) => frame.includes("Live line 0"))
    expect(f.view.captureCharFrame()).not.toContain("Earlier prompt")
  },
)

test("streamed tail growth does not count as another history prepend", async () => {
  const f = await fixture()
  f.top()
  await waitForFrame(f.view, (frame) => frame.includes("Live line 0"))
  const height = f.ui.detail.scrollHeight
  await f.conversation.scrollEarlier()
  const before = await waitForFrame(
    f.view,
    (frame) => frame.includes("Live line 0") && f.ui.detail.scrollHeight > height,
  )
  const anchored = f.ui.detail.scrollTop
  const row = before.split("\n").findIndex((line) => line.includes("Live line 0"))
  const prependedHeight = f.ui.detail.scrollHeight
  f.conversation.updateLive([
    ...f.state.detail!.messages,
    message("msg_stream", Array.from({ length: 20 }, (_, i) => `Streamed tail ${i}`).join("\n")),
  ])
  await waitForFrame(f.view, () => f.ui.detail.scrollHeight > prependedHeight)
  expect(f.ui.detail.scrollTop).toBe(anchored)
  expect(f.view.captureCharFrame().split("\n")[row]).toContain("Live line 0")
})

test.each([false, true])("End during an older request keeps following (empty page: %s)", async (empty) => {
  const f = await fixture()
  f.top()
  if (empty) f.data.older = []
  let release!: () => void
  f.data.gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const pending = f.conversation.scrollEarlier()
  // Same ordering as the dashboard's End handler and native scroll box input.
  f.conversation.cancelPosition()
  f.ui.detail.scrollTo(Number.MAX_SAFE_INTEGER)
  await waitForFrame(f.view, (frame) => frame.includes("Live line 44"))
  release()
  await pending
  await waitForFrame(f.view, (frame) => frame.includes("Live line 44"))
  f.conversation.updateLive([
    ...f.state.detail!.messages,
    message("msg_after_end", Array.from({ length: 35 }, (_, i) => `After End ${i}`).join("\n")),
  ])
  await waitForFrame(f.view, (frame) => frame.includes("After End 34"))
  expect(f.ui.detail.scrollTop + f.ui.detail.viewport.height).toBeGreaterThanOrEqual(f.ui.detail.scrollHeight - 1)
})

test.each([false, true])("width reflow retains visible wrapped text (raw: %s)", async (raw) => {
  const text =
    Array.from(
      { length: 70 },
      (_, i) => `MARKER_${String(i).padStart(3, "0")} ${"wrapped reading text ".repeat(9)}`,
    ).join("\n") + "\nFinal tail"
  const f = await fixture([message("msg_wrapped", text)])
  f.state.rawResponses = raw
  f.view.resize(120, 36)
  f.ui.resize()
  await f.conversation.render()
  await waitForFrame(f.view, (frame) => frame.includes("Final tail"))
  f.conversation.cancelPosition()
  f.ui.detail.scrollTo(100)
  const before = await waitForFrame(f.view, (frame) => /MARKER_\d+/.test(frame))
  const marker = before.match(/MARKER_\d+/)![0]
  f.view.resize(60, 36)
  f.ui.resize()
  await waitForFrame(f.view, (frame) => frame.includes(marker))
  expect(f.view.captureCharFrame()).toContain(marker)
  const narrowed = f.ui.detail.scrollTop
  expect(narrowed).not.toBe(100)
  // Polling must keep the reflowed position, rather than restore the old offset.
  await f.conversation.render()
  await waitForFrame(f.view, (frame) => frame.includes(marker))
  expect(f.ui.detail.scrollTop).toBe(narrowed)
  f.view.resize(120, 36)
  f.ui.resize()
  await waitForFrame(f.view, (frame) => frame.includes(marker))
})

test("empty boundaries are fetched once and errors can be retried without losing live output", async () => {
  const f = await fixture()
  f.top()
  f.data.fail = true
  await f.conversation.scrollEarlier()
  expect(f.notices.at(-1)).toContain("Scroll up to retry")
  expect(f.state.detail?.messages[0]?.id).toBe("msg_latest")
  f.data.fail = false
  f.data.older = []
  await f.conversation.scrollEarlier()
  await f.conversation.scrollEarlier()
  expect(f.cursors.filter(Boolean)).toEqual(["older", "older"])
  expect(f.notices.at(-1)).toBe("Start of history reached.")
})

test("scrollback is bounded and points to explicit History at the cap", async () => {
  const f = await fixture()
  for (let page = 0; page < 5; page++) {
    f.top()
    f.data.older = Array.from({ length: 30 }, (_, i) => message(`msg_${page}_${i}`, `Page ${page} item ${i}`))
    f.data.next = `older-${page}`
    await f.conversation.scrollEarlier()
    await f.view.renderOnce()
  }
  f.top()
  await waitForFrame(f.view, (frame) => frame.includes("Live scrollback limit reached"))
  expect(f.view.captureCharFrame()).toContain("Live scrollback limit reached")
  const count = f.cursors.length
  await f.conversation.scrollEarlier()
  expect(f.cursors.length).toBe(count)
  expect(f.notices.at(-1)).toContain("Press h, then [")
  expect(f.ui.detail.scrollHeight).toBeLessThan(600)
})

test("starts with six messages and reveals the fetched local prefix before requesting older history", async () => {
  const latest = Array.from({ length: 10 }, (_, i) => message(`msg_recent_${9 - i}`, `Recent marker ${9 - i}`))
  const f = await fixture(latest)
  f.top()
  await waitForFrame(f.view, (frame) => frame.includes("Recent marker 4"))
  expect(f.view.captureCharFrame()).toContain("Recent marker 4")
  expect(f.view.captureCharFrame()).not.toContain("Recent marker 3")
  expect(f.content()).not.toContain("Recent marker 3")
  expect(f.content().match(/Recent marker/g)).toHaveLength(6)
  f.conversation.toggleHistory()
  await waitForFrame(f.view, () => f.state.history && f.content().match(/Recent marker/g)?.length === 10)
  expect(f.content().match(/Recent marker/g)).toHaveLength(10)
  f.conversation.toggleHistory()
  await waitForFrame(f.view, () => !f.state.history && f.content().match(/Recent marker/g)?.length === 6)
  expect(f.content().match(/Recent marker/g)).toHaveLength(6)
  await f.conversation.render()
  await waitForFrame(f.view, (frame) => frame.includes("Recent marker 4"))
  expect(f.view.captureCharFrame()).not.toContain("Recent marker 3")
  expect(f.content().match(/Recent marker/g)).toHaveLength(6)
  await f.view.mockMouse.scroll(f.ui.detail.viewport.x + 2, f.ui.detail.viewport.y + 1, "up")
  await waitForFrame(f.view, () => f.content().includes("Recent marker 0"))
  expect(f.cursors.filter(Boolean)).toEqual([])
  expect(f.content()).toContain("Recent marker 0")
  f.top()
  await waitForFrame(f.view, (frame) => frame.includes("Recent marker 0"))
  expect(f.view.captureCharFrame()).toContain("Recent marker 0")
  await f.conversation.render()
  await waitForFrame(f.view, (frame) => frame.includes("Recent marker 0"))
  expect(f.view.captureCharFrame()).toContain("Recent marker 0")
  await f.conversation.scrollEarlier()
  await f.view.renderOnce()
  expect(f.cursors.filter(Boolean)).toEqual(["older"])
})

test("scrolling away from the top preserves the six-message reading context when a seventh arrives", async () => {
  const latest = Array.from({ length: 6 }, (_, i) =>
    message(`msg_long_${5 - i}`, Array.from({ length: 45 }, (_, row) => `Context ${5 - i} row ${row}`).join("\n")),
  )
  const f = await fixture(latest)
  f.conversation.cancelPosition()
  f.ui.detail.scrollTo(30)
  const before = await waitForFrame(f.view, (frame) => frame.includes("Context 0 row 30"))
  expect(f.ui.detail.scrollTop).toBeGreaterThan(f.ui.detail.viewport.height)
  await f.conversation.scrollEarlier()
  expect(f.cursors.filter(Boolean)).toEqual([])
  f.data.latest = [message("msg_seventh", "Seventh message"), ...f.data.latest]
  await f.conversation.render()
  await waitForFrame(f.view, (frame) => frame.includes("Context 0 row 30"))
  expect(f.content()).toContain("Context 0 row 0")
  expect(
    f.view
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => line.includes("Context 0 row 30")),
  ).toBe(before.split("\n").findIndex((line) => line.includes("Context 0 row 30")))
})

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
