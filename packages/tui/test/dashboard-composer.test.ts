import { expect, test } from "bun:test"
import { SessionListRenderable } from "../src/session-list"
import { ScrollBoxRenderable, SelectRenderable, TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { mountDashboard } from "../src/index"
import { cleanup, waitForFrame, leaveComposer, clickText, descendants, fixture } from "./dashboard-fixture"

for (const [schedule, text] of [
  [{ type: "interval", seconds: 3600, timezone: "UTC" }, "Every 1h"],
  [
    { type: "cron", seconds: 3600, expression: "0 2 * * *", timezone: "America/New_York" },
    "Cron 0 2 * * * (America/New_York)",
  ],
] as const) {
  test(`${schedule.type} automation shows its schedule in sidebar and details after loading run history`, async () => {
    const server = fixture({ schedule })
    const view = await createTestRenderer({ width: 110, height: 38 })
    cleanup.push(() => view.renderer.destroy())
    const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
    await app.ready
    view.mockInput.pressKey("3")
    const frame = await waitForFrame(view, (frame) => frame.includes("RECENT RUNS"))
    expect(frame).toContain(text)
    expect(frame).not.toContain(schedule.type === "cron" ? "Every 1h" : "Cron")
    const list = descendants(view.renderer.root).find((node) => node instanceof SessionListRenderable)
    expect(list?.options[0]?.description).toBe(`${text} · /srv/project`)
    expect(frame).toContain("Review overnight changes")
    expect(frame).toMatch(/succeeded · \d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
    expect(frame).toContain("failed · run_partial")
    expect(frame).not.toContain("[object Object]")
  })
}

test("small terminals focus the task immediately and support portable Ctrl+S submission", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 70, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  await leaveComposer(view)
  view.mockInput.pressKey("n")
  await waitForFrame(view, (frame) => frame.includes("What would you like to do?"))
  await view.mockInput.typeText("Inspect active workers")
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Inspect active workers")
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Task sent."))
  expect(server.posts[1]?.body).toMatchObject({ prompt: { text: "Inspect active workers" } })
})

test("a narrow terminal starts a reply, empty Up recalls the user prompt, and Ctrl+C keeps the draft before quitting", async () => {
  const server = fixture({ history: true, active: false })
  const view = await createTestRenderer({ width: 70, height: 24, exitOnCtrlC: false })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await waitForFrame(view, (frame) => frame.includes("Typing"))
  view.mockInput.pressArrow("up")
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Earlier task that belongs in history.")
  view.mockInput.pressKey("c", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Draft kept. Ctrl+C again quits and discards unsent drafts."))
  expect(view.renderer.isDestroyed).toBe(false)
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Earlier task that belongs in history.")
  await leaveComposer(view)
  view.mockInput.pressKey("f")
  await waitForFrame(view, (frame) => frame.includes("Esc shortcuts"))
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Earlier task that belongs in history.")
  view.mockInput.pressKey("c", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Draft kept. Ctrl+C again quits"))
  expect(view.renderer.isDestroyed).toBe(false)
  view.mockInput.pressKey("c", { ctrl: true })
  expect(view.renderer.isDestroyed).toBe(true)
  expect(server.posts).toHaveLength(0)
})

test("Up does not replace nonempty editor text and page keys scroll by the viewport", async () => {
  const server = fixture({ history: true, text: Array.from({ length: 80 }, (_, i) => `Line ${i}`).join("\n\n") })
  const view = await createTestRenderer({ width: 70, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await waitForFrame(view, (frame) => frame.includes("Line 79"))
  const detail = descendants(view.renderer.root).find(
    (node) => node instanceof ScrollBoxRenderable && !(node instanceof SessionListRenderable),
  ) as ScrollBoxRenderable
  const before = detail.scrollTop
  view.mockInput.pressKey("\x1b[5~")
  await view.renderOnce()
  expect(detail.scrollTop).toBe(Math.max(0, before - detail.viewport.height + 1))
  await waitForFrame(view, (frame) => frame.includes("Esc shortcuts"))
  await view.mockInput.typeText("Keep what I typed")
  view.mockInput.pressArrow("up")
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Keep what I typed")
})

test("right-clicking navigation controls does not activate them", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 120, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  const frame = await waitForFrame(view, (frame) => frame.includes("Models m"))
  const lines = frame.split("\n")
  const row = lines.findIndex((line) => line.includes("Models m"))
  await view.mockMouse.click(lines[row]!.indexOf("Models m") + 1, row, 2)
  await view.renderOnce()
  expect(view.captureCharFrame()).not.toContain("Choose model")
  expect(server.posts).toHaveLength(0)

  view.mockInput.pressKey("k", { ctrl: true })
  const switcher = await waitForFrame(view, (frame) => frame.includes("Switch session"))
  const switcherLines = switcher.split("\n")
  const allRow = switcherLines.findIndex((line) => line.includes("Recent") && line.includes("All sessions"))
  await view.mockMouse.click(switcherLines[allRow]!.indexOf("All sessions") + 1, allRow, 2)
  const newRow = switcherLines.findIndex((line) => line.includes("+ New session"))
  await view.mockMouse.click(switcherLines[newRow]!.indexOf("New session") + 1, newRow, 2)
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Switch session")

  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Switch session"))
  view.mockInput.pressKey("n")
  const launch = await waitForFrame(view, (frame) => frame.includes("What would you like to do?"))
  const launchLines = launch.split("\n")
  const contextRow = launchLines.findIndex((line) => line.includes("Directory:"))
  await view.mockMouse.click(launchLines[contextRow]!.indexOf("Directory:") + 1, contextRow, 2)
  await view.renderOnce()
  expect(view.captureCharFrame()).not.toContain("Agent ·")

  view.mockInput.pressKey("l", { ctrl: true })
  const models = await waitForFrame(view, (frame) => frame.includes("+ Connect a provider"))
  const modelLines = models.split("\n")
  const setupRow = modelLines.findIndex((line) => line.includes("+ Connect a provider"))
  await view.mockMouse.click(modelLines[setupRow]!.indexOf("Connect a provider") + 1, setupRow, 2)
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Choose model")
})

test.each([false, true])(
  "undo/redo updates visible history and preserves ordinary drafts (existing=%s)",
  async (existing) => {
    const server = fixture({ history: true, active: false })
    const view = await createTestRenderer({ width: 100, height: 36 })
    cleanup.push(() => view.renderer.destroy())
    await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
    if (existing) {
      view.mockInput.pressKey("f")
      await view.mockInput.typeText("Existing draft")
      await leaveComposer(view)
    }
    view.mockInput.pressKey("p", { ctrl: true })
    await view.mockInput.typeText("Undo conversation turn")
    view.mockInput.pressEnter()
    await waitForFrame(view, (frame) => frame.includes("type undo"))
    await view.mockInput.typeText("undo")
    view.mockInput.pressKey("s", { ctrl: true })
    await waitForFrame(view, (frame) => frame.includes("UNDO STAGED") && !frame.includes("Undo conversation?"))
    expect(view.captureCharFrame()).not.toContain("Inspecting the server")
    expect(server.posts.map((post) => post.path)).toEqual([
      "/api/session/ses_running/interrupt",
      "/api/session/ses_running/revert/stage",
    ])
    expect(server.posts[1]?.body).toEqual({ messageID: "msg_earlier", files: false })
    view.mockInput.pressKey("f")
    await waitForFrame(view, (frame) => frame.includes("Typing"))
    expect(view.renderer.currentFocusedEditor?.plainText).toBe(
      existing ? "Existing draft" : "Earlier task that belongs in history.",
    )
    expect(view.captureCharFrame()).toContain("commit undo")
    await leaveComposer(view)
    view.mockInput.pressKey("p", { ctrl: true })
    await view.mockInput.typeText("Redo conversation turn")
    view.mockInput.pressEnter()
    await waitForFrame(view, (frame) => frame.includes("type redo"))
    await view.mockInput.typeText("redo")
    view.mockInput.pressKey("s", { ctrl: true })
    await waitForFrame(
      view,
      (frame) => frame.includes("Inspecting the server") && !frame.includes("Redo conversation?"),
    )
    expect(view.captureCharFrame()).not.toContain("UNDO STAGED")
    view.mockInput.pressKey("f")
    await waitForFrame(view, (frame) => frame.includes("Typing"))
    expect(view.renderer.currentFocusedEditor?.plainText).toBe(existing ? "Existing draft" : "")
    expect(server.posts.some((post) => post.path.endsWith("/prompt"))).toBe(false)
  },
)

test("a newly staged undo cannot silently change the meaning of an already open reply", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("Keep this draft")
  server.sessions[0] = { ...server.sessions[0]!, revert: { messageID: "msg_boundary" } }
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("undo position changed"))
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Keep this draft")
  expect(server.posts).toHaveLength(0)
})

test("a shell command runs on the server, and a staged undo blocks it instead of silently skipping the commit", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("!git status")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Shell command sent"))
  expect(server.posts).toHaveLength(1)
  expect(server.posts[0]?.path).toBe("/api/session/ses_running/shell")
  expect(server.posts[0]?.body).toMatchObject({ command: "git status" })

  // With an undo already staged the editor promises "Send + commit undo", which
  // /shell cannot carry, so the command must be refused rather than run.
  const staged = fixture()
  staged.sessions[0] = { ...staged.sessions[0]!, revert: { messageID: "msg_boundary" } }
  const second = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => second.renderer.destroy())
  await mountDashboard(second.renderer, staged.connection, staged.server.url.href).ready
  second.mockInput.pressKey("f")
  await second.mockInput.typeText("!git status")
  second.mockInput.pressEnter()
  await waitForFrame(second, (frame) => frame.includes("Commit or clear the staged undo"))
  expect(second.renderer.currentFocusedEditor?.plainText).toBe("!git status")
  expect(staged.posts).toHaveLength(0)
})

test("goal slash opens a read-only status panel without starting or stopping work", async () => {
  const server = fixture({
    goal: {
      id: "goal_fixture",
      sessionID: "ses_running",
      revision: 1,
      objective: "Finish the fixture",
      status: "active",
      tokensUsed: 12,
      timeUsedSeconds: 3,
      time: { created: 1, updated: 1, statusChanged: 1 },
    },
  })
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("/goal")
  await waitForFrame(view, (frame) => frame.includes("Inspect and control"))
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Finish the fixture"))
  expect(view.captureCharFrame()).toContain("Status: active")
  expect(view.captureCharFrame()).toContain("Tokens: 12")
  expect(server.posts).toHaveLength(0)
})

test("agent slash in a new draft opens draft settings rather than mutating the existing session", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("n")
  await view.mockInput.typeText("/agent")
  await waitForFrame(view, (frame) => frame.includes("Choose session agent"))
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Agent ·"))
  expect(view.renderer.currentFocusedRenderable).toBeInstanceOf(SelectRenderable)
  expect(server.posts).toHaveLength(0)
})

for (const width of [60, 120]) {
  test(`conversation slash opens commands and preserves saved drafts at ${width} columns`, async () => {
    const server = fixture()
    const view = await createTestRenderer({ width, height: 24 })
    cleanup.push(() => view.renderer.destroy())
    await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
    if (view.renderer.currentFocusedRenderable instanceof SessionListRenderable) view.mockInput.pressEnter()
    view.mockInput.pressKey("/")
    await waitForFrame(view, (frame) => frame.includes("/help"))
    const editor = view.renderer.currentFocusedRenderable as TextareaRenderable
    expect(editor).toBeInstanceOf(TextareaRenderable)
    expect(editor.plainText).toBe("/")
    await view.mockInput.typeText("help")
    view.mockInput.pressEnter()
    await waitForFrame(view, (frame) => frame.includes("Keyboard shortcuts"))
    view.mockInput.pressEscape()
    await waitForFrame(view, (frame) => !frame.includes("Keyboard shortcuts"))
    await leaveComposer(view)
    view.mockInput.pressKey("f")
    await view.mockInput.typeText("Keep my unfinished reply")
    await leaveComposer(view)
    view.mockInput.pressKey("/")
    await waitForFrame(view, (frame) => frame.includes("Esc shortcuts"))
    expect((view.renderer.currentFocusedRenderable as TextareaRenderable).plainText).toBe("Keep my unfinished reply")
    expect(server.posts).toHaveLength(0)
  })
}

for (const composer of ["f", "n"]) {
  // The reply editor has no Send button, so plain Enter stands in for the click there.
  for (const submit of composer === "n" ? ["ctrl-s", "ctrl-enter", "click"] : ["ctrl-s", "ctrl-enter", "enter"]) {
    test(`local slash actions use ${submit} without sending from ${composer}`, async () => {
      const server = fixture()
      const view = await createTestRenderer({ width: 100, height: 36 })
      cleanup.push(() => view.renderer.destroy())
      await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
      view.mockInput.pressKey(composer)
      await view.mockInput.typeText("/help")
      await waitForFrame(view, (frame) => frame.includes("Keyboard help"))
      if (submit === "click") await clickText(view, "Send (Enter)")
      else if (submit === "enter") view.mockInput.pressEnter()
      else view.mockInput.pressKey(submit === "ctrl-s" ? "s" : "RETURN", { ctrl: true })
      await waitForFrame(view, (frame) => frame.includes("Keyboard shortcuts") || server.posts.length > 0)
      expect(server.posts).toHaveLength(0)
      expect(view.captureCharFrame()).toContain("Keyboard shortcuts")
    })
  }
}

test("clicking the selected sidebar session keeps reply editor focus", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 120, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("Draft")
  const editor = view.renderer.currentFocusedRenderable as TextareaRenderable
  await clickText(view, "> * Review the server")
  expect(view.renderer.currentFocusedRenderable?.id).toBe(editor.id)
  await view.mockInput.typeText(" kept")
  expect(editor.plainText).toBe("Draft kept")
  expect(server.posts).toHaveLength(0)
})
