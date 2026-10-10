import { expect, spyOn, test } from "bun:test"
import { SessionListRenderable } from "../src/session-list"
import { SelectRenderable, TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { mountDashboard } from "../src/index"
import { cleanup, waitForFrame, leaveComposer, clickText, descendants, fixture } from "./dashboard-fixture"

test("startup prefers the main thread and Ctrl+X browses subagents without sending", async () => {
  const task = {
    id: "tsk_child",
    rootSessionID: "ses_root",
    parentSessionID: "ses_root",
    childSessionID: "ses_running",
    agent: "explore",
    description: "Inspect the child task",
    depth: 1,
    status: "running" as const,
    revision: 1,
    time: { created: 1, updated: 2 },
  }
  const server = fixture({ tasks: { data: [task], active: [task], cursor: {} } })
  server.sessions[0] = { ...server.sessions[0]!, parentID: "ses_root" }
  server.sessions.push({ ...server.sessions[0]!, id: "ses_root", title: "Main thread", parentID: undefined })
  const view = await createTestRenderer({ width: 120, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  const dashboard = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await dashboard.ready
  expect(server.reads).toContain("/api/session/ses_root/message")
  expect(server.reads).not.toContain("/api/session/ses_running/message")
  view.mockInput.pressKey("x", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Search task description") && frame.includes(task.description))
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => !frame.includes("Search task description"))
  expect(server.reads).toContain("/api/session/ses_running/message")
  await dashboard.refresh()
  expect(view.captureCharFrame()).not.toContain("Search task description")
  expect(server.posts).toHaveLength(0)
})

test("startup loads a main session outside a child-only recent page", async () => {
  const server = fixture({ more: true })
  server.sessions[0] = { ...server.sessions[0]!, parentID: "ses_root" }
  server.historical.set("ses_root", {
    ...server.sessions[0]!,
    id: "ses_root",
    parentID: undefined,
    title: "Older main thread",
  })
  const view = await createTestRenderer({ width: 120, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  expect(server.reads).toContain("/api/session/ses_root/message")
  expect(server.reads).not.toContain("/api/session/ses_running/message")
  view.mockInput.pressKey("f")
  await waitForFrame(view, (frame) => frame.includes("Typing"))
  await view.mockInput.typeText("Reply to the main thread")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Reply sent."))
  expect(server.posts[0]?.path).toBe("/api/session/ses_root/prompt")
})

test("passive refresh preserves sidebar browsing scroll", async () => {
  const server = fixture({ active: false })
  const template = server.sessions[0]!
  server.sessions.splice(0, 1, ...Array.from({ length: 40 }, (_, i) => ({ ...template, id: `ses_browse_${i}` })))
  const view = await createTestRenderer({ width: 120, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  const dashboard = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await dashboard.ready
  await view.renderOnce()
  const list = descendants(view.renderer.root).find(
    (node) => node instanceof SessionListRenderable,
  ) as SessionListRenderable
  list.scrollTo(20)
  await view.renderOnce()
  const position = list.scrollTop
  expect(position).toBeGreaterThan(0)
  const reveal = spyOn(list, "scrollChildIntoView")
  cleanup.push(() => reveal.mockRestore())
  await dashboard.refresh()
  await view.renderOnce()
  expect(list.scrollTop).toBe(position)
  expect(reveal).not.toHaveBeenCalled()
})

test("slash help opens the existing help UI without submitting a prompt", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("/help")
  await waitForFrame(view, (frame) => frame.includes("Keyboard help"))
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Keyboard shortcuts"))
  expect(server.posts).toHaveLength(0)
})

test("server slash commands preserve argument text and retry routing after inventory changes", async () => {
  const options = {
    commands: [{ name: "review", description: "Review changes", template: "Review $ARGUMENTS" }],
    failCommandOnce: true,
  }
  const server = fixture(options)
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("f")
  await view.mockInput.typeText('/review  "two words"')
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("HTTP 502"))
  expect(server.posts).toHaveLength(1)
  expect(server.posts[0]).toMatchObject({
    path: "/api/session/ses_running/command",
    body: { command: "review", arguments: ' "two words"', resume: true },
  })
  expect(server.posts[0]?.body).not.toHaveProperty("delivery")
  options.commands = []
  const reads = server.reads.filter((path) => path === "/api/command").length
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Reply sent."))
  expect(server.posts).toHaveLength(2)
  expect(server.posts[1]).toEqual(server.posts[0])
  expect(server.reads.filter((path) => path === "/api/command")).toHaveLength(reads)
})

test("queue mode does not silently steer a slash command", async () => {
  const server = fixture({ commands: [{ name: "review", template: "Review $ARGUMENTS" }] })
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("/review changes")
  view.mockInput.pressKey("t", { ctrl: true })
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("do not support Queue"))
  expect(server.posts).toHaveLength(0)
  view.mockInput.pressKey("t", { ctrl: true })
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Reply sent."))
  expect(server.posts[0]?.path).toBe("/api/session/ses_running/command")
})

test.each([60, 120])("known task-owned child replies offer main-session navigation at %s columns", async (width) => {
  const task = {
    id: "tsk_owner",
    rootSessionID: "ses_root",
    parentSessionID: "ses_parent",
    childSessionID: "ses_running",
    agent: "build",
    description: "Child task",
    depth: 2,
    status: "running" as const,
    revision: 1,
    time: { created: 1, updated: 1 },
  }
  const server = fixture({ tasks: { data: [task], active: [task], cursor: {} } })
  server.sessions[0] = { ...server.sessions[0]!, parentID: "ses_parent" }
  server.sessions.push({ ...server.sessions[0]!, id: "ses_root", title: "Main conversation", parentID: undefined })
  const view = await createTestRenderer({ width, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  // Ctrl+K stays the editor's delete-to-line-end, which a narrow terminal's reply editor would receive.
  if (width === 60) await leaveComposer(view)
  view.mockInput.pressKey("k", { ctrl: true })
  await view.mockInput.typeText("Review the server")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("read-only"))
  const readsBeforeReply = server.reads.length
  view.mockInput.pressKey("/")
  await waitForFrame(view, (frame) => frame.includes("Find a command"))
  await view.mockInput.typeText("help")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Keyboard shortcuts"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Keyboard shortcuts"))
  view.mockInput.pressKey("f")
  const blocked = await waitForFrame(view, (frame) => frame.includes("Task-owned subagent"))
  expect(blocked).toContain("Main conversation")
  expect(blocked).not.toContain("Your message")
  expect(server.posts).toHaveLength(0)
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Task-owned subagent"))
  expect(server.reads.slice(readsBeforeReply)).not.toContain("/api/session/ses_root")
  view.mockInput.pressKey("f")
  if (width === 60) await clickText(view, "Open main session and reply")
  else view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Typing"))
  expect(server.reads).toContain("/api/session/ses_root")
  expect(server.posts).toHaveLength(0)
  await view.mockInput.typeText("Instructions for the main agent")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Reply sent."))
  expect(server.posts).toHaveLength(1)
  expect(server.posts[0]?.path).toBe("/api/session/ses_root/prompt")
})

test.each([60])("wrapped reply text retains space and visible controls at %s columns", async (width) => {
  const server = fixture()
  const view = await createTestRenderer({ width, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await waitForFrame(view, (frame) => frame.includes("Esc shortcuts"))
  const editor = view.renderer.currentFocusedRenderable as TextareaRenderable
  const text = "Wrapped words with spaces. ".repeat(35) + "\nDRAFTEND"
  editor.setText(text)
  editor.cursorOffset = text.length
  await waitForFrame(view, (frame) => frame.includes("DRAFTEND"))
  await waitForFrame(view, (frame) => frame.includes("DRAFTEND") && editor.height === 6)
  expect(editor.height).toBe(6)
  for (const columns of [60, 120, width]) {
    view.resize(columns, 24)
    const frame = await waitForFrame(view, (frame) => frame.includes("DRAFTEND") && frame.includes("F4 discard"))
    expect(frame).toContain("Enter send")
    expect(editor.plainText).toBe(text)
    expect(editor.y + editor.height).toBeLessThanOrEqual(24)
    expect(view.renderer.currentFocusedRenderable?.id).toBe(editor.id)
  }
  expect(server.posts).toHaveLength(0)
})

test("an unowned session with a parent can still receive direct replies", async () => {
  const server = fixture()
  server.sessions[0] = { ...server.sessions[0]!, parentID: "ses_parent" }
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("Direct fork reply")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Reply sent."))
  expect(server.posts[0]?.path).toBe("/api/session/ses_running/prompt")
})

test("late ownership rejection preserves the draft, blocks repeat POSTs, and never silently redirects", async () => {
  const server = fixture({ ownedError: true })
  server.sessions[0] = { ...server.sessions[0]!, parentID: "ses_root" }
  server.sessions.push({ ...server.sessions[0]!, id: "ses_root", parentID: undefined, title: "Main conversation" })
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("k", { ctrl: true })
  await view.mockInput.typeText("Review the server")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => !frame.includes("Switch session"))
  await waitForFrame(view, (frame) => frame.includes("Esc shortcuts"))
  await view.mockInput.typeText("Keep this rejected child draft")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Draft kept. Press Esc"))
  view.mockInput.pressKey("s", { ctrl: true })
  await Bun.sleep(30)
  expect(server.posts).toHaveLength(1)
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Keep this rejected child draft")
  await leaveComposer(view)
  view.mockInput.pressKey("f")
  const blocked = await waitForFrame(view, (frame) => frame.includes("Saved child draft"))
  expect(blocked).toContain("Keep this rejected child draft")
  expect(server.posts).toHaveLength(1)
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Main conversation") && !frame.includes("Task-owned subagent"))
  await waitForFrame(view, (frame) => frame.includes("Typing"))
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("")
  expect(server.posts).toHaveLength(1)
  expect(server.posts[0]?.path).toBe("/api/session/ses_running/prompt")
})

test("empty session welcome is branded and does not block New session", async () => {
  const options = { active: false, authenticated: true }
  const server = fixture(options)
  server.sessions.splice(0)
  const view = await createTestRenderer({ width: 60, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  const frame = await waitForFrame(view, (frame) => frame.includes("No session selected"))
  expect(frame).toContain("Connected")
  expect(frame).toContain("Ctrl+K sessions")
  options.authenticated = false
  await app.refresh()
  await waitForFrame(view, (frame) => frame.includes("Disconnected · No session selected."))
  options.authenticated = true
  await app.refresh()
  await waitForFrame(view, (frame) => frame.includes("Connected · No session selected."))
  view.mockInput.pressKey("n")
  await waitForFrame(view, (frame) => frame.includes("What would you like to do?"))
  expect(server.posts).toHaveLength(0)
})

test("an initial pending question opens automatically without requiring o", async () => {
  const server = fixture()
  server.pending.questions = [
    {
      id: "que_initial",
      sessionID: "ses_running",
      questions: [
        {
          header: "Ready",
          question: "Open automatically?",
          custom: false,
          options: [{ label: "Yes", description: "Only selected by the user" }],
        },
      ],
    },
  ]
  const view = await createTestRenderer({ width: 60, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await waitForFrame(view, (frame) => frame.includes("Question 1 of 1"))
  expect(view.renderer.currentFocusedRenderable).toBeInstanceOf(SelectRenderable)
  expect(server.posts).toHaveLength(0)
})

test("an older server keeps sessions and launch available without claiming an empty terminal inventory", async () => {
  const server = fixture({ ptyStatus: 404 })
  const view = await createTestRenderer({ width: 120, height: 38 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  await view.renderOnce()
  expect(view.captureCharFrame()).not.toContain("terminals unavailable")
  expect(view.captureCharFrame()).not.toContain("Disconnected")
  view.mockInput.pressKey("2")
  await waitForFrame(view, (frame) => frame.includes("Global terminal inventory is unavailable"))
  view.mockInput.pressKey("n")
  await waitForFrame(view, (frame) => frame.includes("What would you like to do?"))
  expect(view.captureCharFrame()).toContain("New session")
})

test("initial authentication failure gives recovery instructions and keyboard help", async () => {
  const server = fixture({ authenticated: false })
  const view = await createTestRenderer({ width: 100, height: 30 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("FORGE_SERVER_PASSWORD")
  expect(view.captureCharFrame()).not.toContain("Connecting to the server")
  view.mockInput.pressKey("?")
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Keyboard shortcuts")
  view.mockInput.pressTab()
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Keyboard shortcuts"))
  expect(view.captureCharFrame()).toContain("Disconnected")
})

test("rapid selection coalesces detail reads and ignores the previous session's pending actions", async () => {
  const server = fixture({ messageDelay: 80 })
  server.sessions.push(
    ...Array.from({ length: 15 }, (_, index) => ({
      ...server.sessions[0]!,
      id: `ses_other${index}`,
      title: `Session ${index}`,
    })),
  )
  const view = await createTestRenderer({ width: 120, height: 38 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  server.reads.length = 0
  for (let index = 0; index < 12; index++) view.mockInput.pressArrow("down")
  await Bun.sleep(220)
  await view.renderOnce()
  expect(server.reads.filter((path) => path.endsWith("/message")).length).toBeLessThanOrEqual(2)
  expect(view.captureCharFrame()).toContain("Session 11")
})
