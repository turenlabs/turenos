import { expect, test } from "bun:test"
import { SessionListRenderable } from "../src/session-list"
import { RGBA, SelectRenderable, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { mountDashboard } from "../src/index"
import { cleanup, waitForFrame, leaveComposer, descendants, fixture } from "./dashboard-fixture"

test("launch settings ignore plain Enter aliases while Ctrl+S still sends the task", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 100, height: 36, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("n")
  await view.mockInput.typeText("Send only from the task or an explicit control")
  const editor = view.renderer.currentFocusedEditor!
  for (const setting of ["directory", "agent", "model"]) {
    view.mockInput.pressTab()
    const field = view.renderer.currentFocusedRenderable!
    expect(field).not.toBe(editor)
    if (setting === "directory") expect(view.renderer.currentFocusedEditor?.plainText).toBe("/srv/project")
    if (setting === "agent") {
      expect(field).toBeInstanceOf(SelectRenderable)
      await waitForFrame(view, (frame) => frame.includes("Server default") && !frame.includes("Loading agents"))
      view.mockInput.pressArrow("down")
    }
    if (setting === "model") await view.mockInput.typeText("test/local")
    for (const enter of ["\r", "\n", "\x1b[57414u"]) {
      await view.mockInput.pressKeys([enter])
      await view.renderOnce()
      expect(view.renderer.currentFocusedRenderable).toBe(field)
      expect(editor.plainText).toBe("Send only from the task or an explicit control")
      expect(server.posts).toHaveLength(0)
    }
  }
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Task sent."))
  expect(server.posts).toHaveLength(2)
  expect(server.posts[0]?.body).toMatchObject({
    agent: "build",
    model: { providerID: "test", id: "local" },
    location: { directory: "/srv/project" },
  })
  expect(server.posts[1]?.body).toMatchObject({ prompt: { text: "Send only from the task or an explicit control" } })
})

test("Enter aliases focus list activity, accept inline search, and open exact IDs", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 120, height: 36, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  for (const enter of ["\r", "\n", "\x1b[57414u"]) {
    const list = view.renderer.currentFocusedRenderable
    expect(list).toBeInstanceOf(SessionListRenderable)
    await view.mockInput.pressKeys([enter])
    expect(view.renderer.currentFocusedRenderable).not.toBe(list)
    await leaveComposer(view)
    view.mockInput.pressTab({ shift: true })
    expect(view.renderer.currentFocusedRenderable === list).toBe(true)
    view.mockInput.pressKey("2")
    view.mockInput.pressKey("/")
    await view.mockInput.typeText("worker")
    await view.mockInput.pressKeys([enter])
    expect(view.renderer.currentFocusedEditor).toBeNull()
    view.mockInput.pressKey("k", { ctrl: true })
    view.mockInput.pressKey("o", { ctrl: true })
    await view.mockInput.typeText("ses_running")
    await view.mockInput.pressKeys([enter])
    await waitForFrame(view, (frame) => !frame.includes("Open session by ID"))
    await leaveComposer(view)
    view.mockInput.pressTab()
  }
  expect(server.posts).toHaveLength(0)
})

for (const [width, height] of [
  [60, 24],
  [120, 24],
  [180, 50],
] as const) {
  test(`Ctrl+N shows the wordmark and immediately focuses the task at ${width}×${height} without POST`, async () => {
    const server = fixture()
    const view = await createTestRenderer({ width, height, kittyKeyboard: true })
    cleanup.push(() => view.renderer.destroy())
    await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
    view.mockInput.pressKey("n", { ctrl: true })
    const frame = await waitForFrame(view, (frame) => frame.includes("What would you like to do?"))
    const logo = descendants(view.renderer.root).find((node) => node.id === "turen-logo") as TextRenderable
    expect(logo).toBeDefined()
    expect([logo.width, logo.height]).toEqual([41, 4])
    const spans = view
      .captureSpans()
      .lines.slice(logo.y, logo.y + logo.height)
      .flatMap((line) => line.spans)
    // The desktop's colors: "Turen" in cream, "OS" in blue.
    const colors = spans.flatMap((span) => [span.fg, span.bg])
    for (const hex of ["#fbf8f0", "#c8daf7"]) expect(colors).toContainEqual(RGBA.fromHex(hex))
    expect(frame).toContain("Directory: /srv/project")
    expect(frame).toContain("Tab: folder")
    expect(frame).toContain("[ Send (Enter) ]")
    const editor = view.renderer.currentFocusedEditor!
    expect(editor).toBeDefined()
    expect(editor.plainText).toBe("")
    expect(editor.height).toBeGreaterThanOrEqual(3)
    await view.mockInput.pasteBracketedText("Ready to work\nSecond visible row\nThird visible row")
    await view.renderOnce()
    expect(view.renderer.currentFocusedEditor).toBe(editor)
    expect(editor.plainText).toBe("Ready to work\nSecond visible row\nThird visible row")
    for (const [nextWidth, nextHeight] of [
      [60, 24],
      [180, 50],
      [width, height],
    ] as const) {
      view.resize(nextWidth, nextHeight)
      await view.renderOnce()
      const resized = view.captureCharFrame()
      expect(
        resized
          .split("\n")
          .slice(logo.y, logo.y + logo.height)
          .map((line) => line.slice(logo.x, logo.x + logo.width)),
      ).toEqual(logo.plainText.split("\n"))
      for (const row of editor.plainText.split("\n")) expect(resized).toContain(row)
      expect(resized).toContain("[ Send (Enter) ]")
      expect(editor.height).toBeGreaterThanOrEqual(3)
      expect(view.renderer.currentFocusedEditor).toBe(editor)
    }
    expect(server.posts).toHaveLength(0)
  })
}

for (const form of ["launch", "finder"] as const) {
  test(`${form} releases resize callbacks after closing and tolerates a stale callback`, async () => {
    const server = fixture()
    const view = await createTestRenderer({ width: 120, height: 36 })
    cleanup.push(() => view.renderer.destroy())
    await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
    const baseline = view.renderer.listeners("resize")
    for (let round = 0; round < 3; round++) {
      view.mockInput.pressKey(form === "launch" ? "n" : "k", { ctrl: true })
      await waitForFrame(view, (frame) =>
        frame.includes(form === "launch" ? "What would you like to do?" : "Switch session"),
      )
      const callbacks = view.renderer.listeners("resize").filter((listener) => !baseline.includes(listener))
      expect(callbacks).toHaveLength(1)
      view.mockInput.pressEscape()
      await waitForFrame(
        view,
        (frame) => !frame.includes(form === "launch" ? "What would you like to do?" : "Switch session"),
      )
      for (const callback of callbacks) expect(() => callback()).not.toThrow()
      expect(view.renderer.listeners("resize")).toEqual(baseline)
      view.resize(round % 2 ? 120 : 160, round % 2 ? 36 : 48)
      await view.renderOnce()
      expect(view.captureCharFrame()).not.toContain("TextBuffer is destroyed")
    }
    expect(server.posts).toEqual([])
  })
}

test("Ctrl+N deliberately opens New session from a reply or switcher while preserving drafts", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 100, height: 36, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("Saved reply")
  view.mockInput.pressKey("n", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("What would you like to do?"))
  await view.mockInput.typeText("Saved launch")
  view.mockInput.pressEscape()
  view.mockInput.pressKey("k", { ctrl: true })
  view.mockInput.pressKey("n", { ctrl: true })
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Saved launch")
  view.mockInput.pressEscape()
  view.mockInput.pressKey("f")
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Saved reply")
  expect(server.posts).toHaveLength(0)
})

test("CSI-u shifted punctuation uses delivered text, with essentials-first help and a fixed scroll hint", async () => {
  const server = fixture({ pages: true })
  const view = await createTestRenderer({ width: 60, height: 24, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await leaveComposer(view)
  view.mockInput.pressKey("h")
  await waitForFrame(view, (frame) => frame.includes("[ Older"))
  const cursors = server.messageCursors.length
  view.mockInput.pressKey("\x1b[91:123;2;123u")
  await view.renderOnce()
  expect(server.messageCursors).toHaveLength(cursors)
  view.mockInput.pressKey("\x1b[47:63;2;63u")
  const help = await waitForFrame(view, (frame) => frame.includes("Keyboard shortcuts"))
  expect(help).toContain("ESSENTIALS")
  expect(help).toMatch(/F4\s+discard local draft/)
  expect(help).toContain("PgUp/PgDn scroll · Esc close")
  view.mockInput.pressKey("\x1b[6~")
  const scrolled = await waitForFrame(view, (frame) => !frame.includes("ESSENTIALS"))
  expect(scrolled).toContain("PgUp/PgDn scroll · Esc close")
  view.mockInput.pressKey("\x1b[5~")
  await waitForFrame(view, (frame) => frame.includes("ESSENTIALS"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Keyboard shortcuts"))
})

test("b, Ctrl+B, and palette sidebar/quit actions work without stealing editor input", async () => {
  const server = fixture({ active: false })
  const view = await createTestRenderer({ width: 120, height: 36, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("b")
  await view.renderOnce()
  expect(view.captureCharFrame()).not.toContain("1 Ses")
  view.mockInput.pressKey("b", { ctrl: true })
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("1 Ses")
  view.mockInput.pressKey("p", { ctrl: true })
  await view.mockInput.typeText("sidebar")
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Toggle sidebar  · Show or hide the list (b or Ctrl+B)")
  view.mockInput.pressEnter()
  await view.renderOnce()
  expect(view.captureCharFrame()).not.toContain("1 Ses")
  // Hiding the sidebar hands focus to the transcript, whose reply editor opens by itself.
  await waitForFrame(view, (frame) => frame.includes("Esc shortcuts"))
  await view.mockInput.typeText("ab")
  view.mockInput.pressKey("b", { ctrl: true })
  expect(view.renderer.currentFocusedEditor?.cursorOffset).toBe(1)
  view.mockInput.pressEscape()
  view.mockInput.pressKey("p", { ctrl: true })
  await view.mockInput.typeText("quit")
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Quit dashboard  · Repeat if work is unsent (q or Ctrl+C)")
  view.mockInput.pressEnter()
  expect(view.renderer.isDestroyed).toBe(false)
  await waitForFrame(view, (frame) => frame.includes("Unsent drafts"))
  view.mockInput.pressKey("q")
  expect(view.renderer.isDestroyed).toBe(true)
  expect(server.posts).toHaveLength(0)
})

test("kill delegates the session and task-tree interruption to the server after typed confirmation", async () => {
  const server = fixture({
    tasks: {
      data: [],
      active: [
        {
          id: "tsk_child",
          rootSessionID: "ses_running",
          parentSessionID: "ses_running",
          childSessionID: "ses_child",
          agent: "explore",
          description: "Explore the repository",
          depth: 1,
          status: "running",
          revision: 3,
          time: { created: 1, updated: 1 },
        },
      ],
      cursor: {},
    },
  })
  const view = await createTestRenderer({ width: 120, height: 36, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("p", { ctrl: true })
  await view.mockInput.typeText("kill")
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Kill session")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Confirmation (type kill)"))
  expect(server.posts).toHaveLength(0)
  await view.mockInput.typeText("kill")
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Session killed."))
  expect(server.posts.map((post) => post.path)).toEqual(["/api/session/ses_running/interrupt"])
})

test.each([60, 120])("a running session shows x Stop in the action row at %i columns", async (width) => {
  const running = fixture()
  const view = await createTestRenderer({ width, height: 36, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, running.connection, running.server.url.href).ready
  // A narrow terminal starts typing, which hides the action row until Esc.
  if (width === 60) await leaveComposer(view)
  await waitForFrame(view, (frame) => frame.includes("x Stop"))
  const idle = fixture({ active: false })
  const quiet = await createTestRenderer({ width, height: 36, kittyKeyboard: true })
  cleanup.push(() => quiet.renderer.destroy())
  await mountDashboard(quiet.renderer, idle.connection, idle.server.url.href).ready
  await waitForFrame(quiet, (frame) => !frame.includes("Connecting to the server"))
  expect(quiet.captureCharFrame()).not.toContain("x Stop")
})

test("stopping a session is discoverable from help, the palette and the slash list", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 120, height: 36, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await waitForFrame(view, (frame) => frame.includes("x Stop"))
  view.mockInput.pressKey("?")
  const help = await waitForFrame(view, (frame) => frame.includes("Keyboard shortcuts"))
  expect(help).toMatch(/Esc Esc\s+stops the running turn/)
  expect(help).toMatch(/x · \/stop\s+stops it/)
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Keyboard shortcuts"))
  view.mockInput.pressKey("p", { ctrl: true })
  await view.mockInput.typeText("stop")
  const palette = await waitForFrame(view, (frame) => frame.includes("Stop session"))
  expect(palette).toContain("Stop all agents")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Session interrupted."))
  expect(server.posts.map((post) => post.path)).toEqual(["/api/session/ses_running/interrupt"])
  view.mockInput.pressKey("p", { ctrl: true })
  await view.mockInput.typeText("stop all")
  await waitForFrame(view, (frame) => frame.includes("Stop all agents"))
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Confirmation (type stop all)"))
  expect(server.posts).toHaveLength(1)
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Confirmation (type stop all)"))
  view.mockInput.pressKey("f")
  await waitForFrame(view, (frame) => frame.includes("Typing"))
  await view.mockInput.typeText("/stop")
  const stop = await waitForFrame(view, (frame) => frame.includes("/stop - "))
  expect(stop).toMatch(/\/stop - Stop this session/)
  for (let i = 0; i < 4; i++) view.mockInput.pressBackspace()
  await view.mockInput.typeText("kill")
  const kill = await waitForFrame(view, (frame) => frame.includes("/kill - "))
  expect(kill).toMatch(/\/kill - Stop this session/)
})

test("permission submission defaults to Reject and extra modifiers cannot confirm it", async () => {
  const server = fixture()
  server.pending.permissions = [{ id: "per_test", sessionID: "ses_running", action: "shell", resources: ["npm test"] }]
  const view = await createTestRenderer({ width: 100, height: 36, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("p")
  const choice = view.renderer.currentFocusedRenderable as SelectRenderable
  expect(choice.options[choice.getSelectedIndex()]?.name).toBe("1 Reject")
  for (const enter of ["\r", "\n", "\x1b[57414u"]) {
    await view.mockInput.pressKeys([enter])
    await view.renderOnce()
    expect(view.renderer.currentFocusedRenderable).toBe(choice)
    expect(view.captureCharFrame()).toContain("Ctrl+S confirms Reject")
    expect(server.posts).toHaveLength(0)
  }
  for (const modifier of ["shift", "meta", "super", "hyper"] as const) {
    view.mockInput.pressKey("s", { ctrl: true, [modifier]: true })
    view.mockInput.pressEnter({ ctrl: true, [modifier]: true })
  }
  expect(server.posts).toHaveLength(0)
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Permission rejected."))
  expect(server.posts[0]?.body).toEqual({ reply: "reject" })
})
