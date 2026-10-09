import { expect, test } from "bun:test"
import { message, waitForFrame, fixture } from "./conversation-scroll-fixture"

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
  // The transcript carries the limit notice; the status line does not say it a second time.
  expect(f.notices.filter((text) => text.includes("Live scrollback limit"))).toEqual([])
  expect(f.content().match(/Live scrollback limit reached/g)).toHaveLength(1)
  expect(f.ui.detail.scrollHeight).toBeLessThan(700)
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
