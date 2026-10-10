import { expect, test } from "bun:test"
import { ScrollBoxRenderable, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { mountDashboard } from "../src/index"
import { cleanup, waitForFrame, leaveComposer, descendants, fixture } from "./dashboard-fixture"

test("follow-up drafts retain recipient context and ambiguous message identities", async () => {
  const settings = { failPromptOnce: true, active: true }
  const server = fixture(settings)
  const view = await createTestRenderer({ width: 70, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  await waitForFrame(view, (frame) => frame.includes("Esc shortcuts"))
  await view.mockInput.typeText("Continue carefully")
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Review the server")
  expect(view.captureCharFrame()).toContain("/srv/project")
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Ctrl+S retry"))
  await view.mockInput.typeText(" accidental edit")
  view.mockInput.pressEscape()
  // The session runs, so Esc also arms the stop and that notice replaces the draft-kept one.
  await waitForFrame(
    view,
    (frame) => frame.includes("Press Esc again to stop this turn") && frame.includes("Draft kept"),
  )
  view.mockInput.pressKey("f")
  await waitForFrame(view, (frame) => frame.includes("Continue carefully"))
  expect(view.captureCharFrame()).not.toContain("accidental edit")
  server.historical.set(server.sessions[0]!.id, server.sessions[0]!)
  server.sessions.splice(0)
  settings.active = false
  await app.refresh()
  expect(view.captureCharFrame()).toContain("Review the server")
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Reply sent."))
  expect(server.posts[1]).toEqual(server.posts[0])
  expect(server.posts[0]?.path).toBe("/api/session/ses_running/prompt")
})

test("slash and Ctrl+K share session matching and cancellation without leaving a sidebar filter", async () => {
  const server = fixture()
  server.sessions.push({ ...server.sessions[0]!, id: "ses_second", title: "Second task" })
  const view = await createTestRenderer({ width: 120, height: 38 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("/")
  await view.mockInput.typeText("Second")
  await waitForFrame(view, (frame) => frame.includes("Switch session") && frame.includes("Second task"))
  expect(server.reads).not.toContain("/api/session/ses_second/message")
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Switch session") && frame.includes("* Review the server"))
  expect(view.captureCharFrame()).toContain("Review the server")
  view.mockInput.pressKey("k", { ctrl: true })
  await view.mockInput.typeText("Second build")
  view.mockInput.pressEnter()
  await waitForFrame(
    view,
    (frame) => !frame.includes("Switch session") && server.reads.includes("/api/session/ses_second/message"),
  )
  await leaveComposer(view)
  view.mockInput.pressKey("2")
  await waitForFrame(view, (frame) => frame.includes("PID 4242"))
  view.mockInput.pressKey("1")
  await waitForFrame(view, (frame) => frame.includes("Second task"))
  expect(view.captureCharFrame()).not.toContain("Find: Second")
})

test("commands filter by typing and Enter runs the matching action without a server mutation", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 100, height: 30 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("p", { ctrl: true })
  await view.mockInput.typeText("terminal")
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Terminal processes")
  expect(view.captureCharFrame()).not.toContain("Send follow-up")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Terminal ID:") && frame.includes("PID 4242"))
  expect(server.posts).toHaveLength(0)
})

test("empty search discloses when older sessions are outside the loaded inventory", async () => {
  const server = fixture({ more: true })
  const view = await createTestRenderer({ width: 70, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await leaveComposer(view)
  view.mockInput.pressKey("k", { ctrl: true })
  await view.mockInput.typeText("Older task")
  const frame = await waitForFrame(view, (frame) => frame.includes("No matching loaded sessions"))
  expect(frame).toContain("Ctrl+O Open older session by ID")
  expect(server.posts).toHaveLength(0)
})

for (const width of [60, 120]) {
  test(`finder keeps search focused and visible while paging, scrolling, and resizing at ${width} columns`, async () => {
    const server = fixture({ active: false })
    server.sessions.splice(
      0,
      1,
      ...Array.from({ length: 40 }, (_, index) => ({
        ...server.sessions[0]!,
        id: `ses_browse_${index}`,
        title: `Browse ${index}`,
        location: { directory: `/srv/project-${index}` },
      })),
    )
    const view = await createTestRenderer({ width, height: 32 })
    cleanup.push(() => view.renderer.destroy())
    await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
    if (width === 60) await leaveComposer(view)
    view.mockInput.pressKey("k", { ctrl: true })
    await waitForFrame(view, (frame) => frame.includes("▶ Browse 0"))
    const input = view.renderer.currentFocusedEditor!
    const y = input.y
    const list = descendants(view.renderer.root)
      .filter((node) => node instanceof ScrollBoxRenderable)
      .at(-1)!
    const slider = list.verticalScrollBar.slider
    await view.mockMouse.click(slider.x, slider.y + slider.height - 1)
    expect(list.scrollTop).toBeGreaterThan(6)
    await view.mockMouse.scroll(list.viewport.x + 2, list.viewport.y + 1, "down")
    await view.renderOnce()
    expect(view.captureCharFrame()).toMatch(/▶ Browse 3\b/)
    expect(list.scrollTop).toBe(7)
    for (let index = 0; index < 3; index++) view.mockInput.pressKey("\x1b[6~")
    await view.renderOnce()
    const selected = view.captureCharFrame().match(/▶ Browse (\d+)/)![1]
    expect(Number(selected)).toBeGreaterThan(0)
    expect(input.y).toBe(y)
    expect(input.focused).toBe(true)
    await view.mockInput.typeText("Browse")
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain(`▶ Browse ${selected}`)
    view.mockInput.pressKey("u", { ctrl: true })
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain(`▶ Browse ${selected}`)
    await view.mockMouse.click(slider.x, slider.y + Math.floor(slider.height / 2))
    expect(input.focused).toBe(true)
    await view.mockMouse.scroll(list.viewport.x + 2, list.viewport.y + 1, "up")
    await view.renderOnce()
    expect(view.captureCharFrame().match(/▶ Browse (\d+)/)![1]).not.toBe(selected)
    expect(input.focused).toBe(true)
    view.resize(60, 24)
    await view.renderOnce()
    expect(input.y).toBeLessThan(list.viewport.y)
    expect(view.captureCharFrame()).toContain("Search title")
    expect(view.captureCharFrame()).toContain("▶ Browse")
    view.resize(59, 23)
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("Resize the terminal")
    view.resize(60, 24)
    await view.renderOnce()
    await view.mockInput.typeText("project-39")
    await waitForFrame(view, (frame) => frame.includes("▶ Browse 39"))
    expect(input.plainText).toBe("project-39")
    expect(server.reads).not.toContain("/api/session/ses_browse_39/message")
    view.mockInput.pressEnter()
    await waitForFrame(
      view,
      (frame) =>
        !frame.includes("Switch session") &&
        frame.includes("Browse 39") &&
        server.reads.includes("/api/session/ses_browse_39/message"),
    )
    expect(server.reads).toContain("/api/session/ses_browse_39/message")
    expect(server.posts).toHaveLength(0)
  })
}

for (const line of [0]) {
  test(`clicking a scrolled finder result's ${line ? "description" : "title"} opens that row, not the keyboard selection`, async () => {
    const server = fixture({ active: false })
    server.sessions.splice(
      0,
      1,
      ...Array.from({ length: 35 }, (_, index) => ({
        ...server.sessions[0]!,
        id: `ses_browse_${index}`,
        title: `Browse ${index}`,
      })),
    )
    const view = await createTestRenderer({ width: 60, height: 24 })
    cleanup.push(() => view.renderer.destroy())
    await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
    await leaveComposer(view)
    view.mockInput.pressKey("k", { ctrl: true })
    await waitForFrame(view, (frame) => frame.includes("▶ Browse 0"))
    for (let index = 0; index < 3; index++) view.mockInput.pressKey("\x1b[6~")
    await view.renderOnce()
    const list = descendants(view.renderer.root)
      .filter((node) => node instanceof ScrollBoxRenderable)
      .at(-1)!
    const row = descendants(list).find(
      (node) =>
        node instanceof TextRenderable &&
        node.plainText.startsWith("  Browse ") &&
        node.y >= list.viewport.y &&
        node.y + 1 < list.viewport.y + list.viewport.height,
    ) as TextRenderable
    expect(row).toBeDefined()
    const number = row.plainText.match(/Browse (\d+)/)![1]
    expect(view.captureCharFrame()).not.toContain(`▶ Browse ${number}\n`)
    await view.mockMouse.click(row.x + 3, row.y + line, 2)
    expect(view.renderer.currentFocusedEditor?.focused).toBe(true)
    expect(server.reads).not.toContain(`/api/session/ses_browse_${number}/message`)
    await view.mockMouse.click(row.x + 3, row.y + line)
    await waitForFrame(view, (frame) => !frame.includes("Switch session") && frame.includes(`Browse ${number}`))
    expect(server.reads).toContain(`/api/session/ses_browse_${number}/message`)
    expect(server.posts).toHaveLength(0)
  })
}

test("finder shows main sessions by default without excluding children from search", async () => {
  const server = fixture({ active: false })
  server.sessions.unshift({
    ...server.sessions[0]!,
    id: "ses_child",
    parentID: "ses_running",
    title: "Delegate investigation",
  })
  const view = await createTestRenderer({ width: 70, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await leaveComposer(view)
  view.mockInput.pressKey("k", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("▶ Review the server"))
  expect(view.captureCharFrame()).not.toContain("Delegate investigation")
  await view.mockInput.typeText("Delegate")
  await waitForFrame(view, (frame) => frame.includes("▶ Delegate investigation"))
  expect(view.captureCharFrame()).toContain("[child]")
  expect(view.captureCharFrame()).toContain("1/1")
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Switch session"))
  expect(server.posts).toHaveLength(0)
})

test("Ctrl+K finds sessions across projects and Escape leaves the current session alone", async () => {
  const server = fixture()
  server.sessions.push({
    ...server.sessions[0]!,
    id: "ses_second",
    title: "Inspect API latency",
    agent: "plan",
    location: { directory: "/srv/backend" },
  })
  const view = await createTestRenderer({ width: 70, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await leaveComposer(view)
  expect(view.captureCharFrame()).toContain("Sessions Ctrl+K")
  expect(view.captureCharFrame()).not.toContain("+ New session")
  view.mockInput.pressKey("k", { ctrl: true })
  await view.mockInput.typeText("backend plan")
  await waitForFrame(view, (frame) => frame.includes("Inspect API latency"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Switch session"))
  expect(view.captureCharFrame()).toContain("Review the server")
  view.mockInput.pressKey("k", { ctrl: true })
  await view.mockInput.typeText("backend plan")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => !frame.includes("Switch session") && frame.includes("/srv/backend"))
  expect(view.captureCharFrame()).toContain("Inspect API latency")
  await leaveComposer(view)
  view.mockInput.pressKey("k", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("▶ * Review the server"))
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => !frame.includes("Switch session") && frame.includes("Review the server"))
  expect(server.posts).toHaveLength(0)
})

test("Escape then Alt arrows or Ctrl+K switches sessions with the saved reply's original recipient", async () => {
  const server = fixture()
  server.sessions.push({
    ...server.sessions[0]!,
    id: "ses_second",
    title: "Another session",
    location: { directory: "/srv/second" },
  })
  const view = await createTestRenderer({ width: 120, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressArrow("right", { meta: true })
  await waitForFrame(view, (frame) => frame.includes("/srv/second"))
  view.mockInput.pressArrow("left", { meta: true })
  await waitForFrame(view, (frame) => frame.includes("/srv/project"))
  // Hopping keeps the reply editor closed, so f opens it.
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("Keep this reply here")
  await leaveComposer(view)
  // The session is running, so Esc's notice arms the stop; the prompt line shows the draft was kept.
  await waitForFrame(view, (frame) => frame.includes("Draft kept"))
  view.mockInput.pressKey("k", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Switch session"))
  await view.mockInput.typeText("Another")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => !frame.includes("Switch session") && frame.includes("/srv/second"))
  // A session picked in Ctrl+K opens its reply editor, where Alt+Left moves by word; Esc first to hop.
  await leaveComposer(view)
  view.mockInput.pressArrow("left", { meta: true })
  await waitForFrame(view, (frame) => frame.includes("Draft kept"))
  view.mockInput.pressKey("f")
  await waitForFrame(view, (frame) => frame.includes("Keep this reply here"))
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Reply sent."))
  expect(server.posts).toHaveLength(1)
  expect(server.posts[0]).toMatchObject({
    path: "/api/session/ses_running/prompt",
    body: { prompt: { text: "Keep this reply here" } },
  })
})

test("narrowing the terminal transfers arrow navigation away from the hidden session list", async () => {
  const server = fixture()
  server.sessions.push({ ...server.sessions[0]!, id: "ses_second", title: "Another session" })
  const view = await createTestRenderer({ width: 120, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  view.resize(70, 24)
  view.mockInput.pressArrow("down")
  await app.refresh()
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Review the server")
  expect(view.captureCharFrame()).not.toContain("Another session")
  expect(server.reads).not.toContain("/api/session/ses_second/message")
  expect(server.posts).toHaveLength(0)
})

test("session shortcuts retain the departing terminal filter and hop first from another view", async () => {
  const server = fixture()
  server.sessions.push({ ...server.sessions[0]!, id: "ses_second", title: "Another session" })
  const view = await createTestRenderer({ width: 120, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("2")
  await waitForFrame(view, (frame) => frame.includes("PID 4242"))
  view.mockInput.pressKey("/")
  await view.mockInput.typeText("Build")
  view.mockInput.pressEnter()
  view.mockInput.pressArrow("right", { meta: true })
  await waitForFrame(view, (frame) => frame.includes("Inspecting the server"))
  view.mockInput.pressKey("i")
  await waitForFrame(view, (frame) => frame.includes("ses_running"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("ses_running"))
  view.mockInput.pressKey("2")
  await waitForFrame(view, (frame) => frame.includes("PID 4242") && frame.includes("Find: Build"))
  view.mockInput.pressKey("k", { ctrl: true })
  await view.mockInput.typeText("Another")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => !frame.includes("Switch session"))
  await leaveComposer(view)
  view.mockInput.pressKey("2")
  await waitForFrame(view, (frame) => frame.includes("PID 4242") && frame.includes("Find: Build"))
  expect(server.posts).toHaveLength(0)
})
