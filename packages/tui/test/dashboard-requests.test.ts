import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { mountDashboard } from "../src/index"
import { cleanup, waitForFrame, leaveComposer, clickText, descendants, fixture } from "./dashboard-fixture"

test("pending permissions and questions send the selected session's explicit responses", async () => {
  const server = fixture()
  server.pending.permissions = [{ id: "per_test", sessionID: "ses_running", action: "shell", resources: ["npm test"] }]
  server.pending.questions = [
    {
      id: "que_test",
      sessionID: "ses_running",
      questions: [
        {
          header: "Scope",
          question: "Which files?",
          options: [
            { label: "Source", description: "Source files" },
            { label: "Tests", description: "Test files" },
          ],
          multiple: true,
          custom: false,
        },
      ],
    },
  ]
  const view = await createTestRenderer({ width: 110, height: 38, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("need input")
  expect(view.captureCharFrame()).not.toContain("QUESTION PENDING")
  expect(server.posts).toHaveLength(0)
  await waitForFrame(view, (frame) => frame.includes("Permission request"))
  expect(view.captureCharFrame()).toContain("npm test")
  view.mockInput.pressArrow("down")
  for (const enter of ["\r", "\n", "\x1b[57414u"]) {
    await view.mockInput.pressKeys([enter])
    await view.renderOnce()
    expect(server.posts).toHaveLength(0)
  }
  view.mockInput.pressEnter({ ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Allowed once."))
  expect(server.posts[0]).toMatchObject({
    path: "/api/session/ses_running/permission/per_test/reply",
    body: { reply: "once" },
  })
  view.mockInput.pressKey("o")
  await waitForFrame(view, (frame) => frame.includes("Question 1 of 1"))
  expect(view.captureCharFrame()).toContain("Which files?")
  expect(view.captureCharFrame()).toContain("Source files")
  for (const enter of ["\r", "\n", "\x1b[57414u"]) {
    await view.mockInput.pressKeys([enter])
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("Choose an answer")
    expect(server.posts).toHaveLength(1)
  }
  view.mockInput.pressKey(" ")
  view.mockInput.pressArrow("down")
  view.mockInput.pressKey(" ")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Review answers"))
  expect(server.posts).toHaveLength(1)
  view.mockInput.pressEnter({ ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Answers sent."))
  expect(server.posts[1]).toMatchObject({
    path: "/api/session/ses_running/question/que_test/reply",
    body: { answers: [["Source", "Tests"]] },
  })
})

test("new questions open automatically once and defer to an active reply draft", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 100, height: 32 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("Keep this draft")
  server.pending.questions = [
    {
      id: "que_auto",
      sessionID: "ses_running",
      questions: [
        {
          header: "Choice",
          question: "Which automatic choice?",
          custom: false,
          options: [{ label: "Keep", description: "No mutation before review" }],
        },
      ],
    },
  ]
  await app.refresh()
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Keep this draft")
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => frame.includes("Question 1 of 1"))
  expect(server.posts).toHaveLength(0)
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Question 1 of 1"))
  await app.refresh()
  await view.renderOnce()
  expect(view.captureCharFrame()).not.toContain("Question 1 of 1")
  server.pending.questions = [{ ...server.pending.questions[0]!, id: "que_next" }]
  await app.refresh()
  await waitForFrame(view, (frame) => frame.includes("Question 1 of 1"))
  server.pending.questions = []
  await app.refresh()
  await waitForFrame(view, (frame) => !frame.includes("Question 1 of 1"))
  view.mockInput.pressKey("f")
  await waitForFrame(view, (frame) => frame.includes("Typing"))
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Keep this draft")
  expect(server.posts).toHaveLength(0)
})

test.each([60])("question panel keeps transcript visible and Ctrl+K preserves answers at %s columns", async (width) => {
  const server = fixture({ text: "TRANSCRIPT REMAINS VISIBLE", postDelay: 200 })
  server.sessions.push({ ...server.sessions[0]!, id: "ses_other", title: "Another session" })
  server.pending.questions = [
    {
      id: "que_docked",
      sessionID: "ses_running",
      questions: [
        {
          header: "Choice",
          question: "Choose a response",
          multiple: true,
          custom: true,
          options: [
            { label: "First", description: "First choice" },
            { label: "Second", description: "Second choice" },
          ],
        },
      ],
    },
  ]
  const view = await createTestRenderer({ width, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  const frame = await waitForFrame(view, (frame) => frame.includes("Question 1 of 1"))
  expect(frame).toContain("TRANSCRIPT REMAINS VISIBLE")
  expect(frame).not.toContain("QUESTION PENDING")
  view.mockInput.pressKey(" ")
  view.mockInput.pressArrow("down")
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Your answer"))
  await view.mockInput.typeText("Alpha, beta")
  view.renderer.currentFocusedEditor!.cursorOffset = 5
  view.mockInput.pressKey("k", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Switch session"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => frame.includes("Your answer"))
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Alpha, beta")
  expect(view.renderer.currentFocusedEditor?.cursorOffset).toBe(5)
  view.mockInput.pressEnter()
  view.mockInput.pressArrow("right")
  await waitForFrame(view, (frame) => frame.includes("Review answers"))
  view.mockInput.pressKey("k", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Switch session"))
  await view.mockInput.typeText("Another")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => !frame.includes("Switch session") && frame.includes("Another session"))
  expect(view.captureCharFrame()).not.toContain("Review answers")
  // The other session opened with its reply editor; Ctrl+K works from there too, and from shortcut mode.
  await leaveComposer(view)
  view.mockInput.pressKey("k", { ctrl: true })
  await view.mockInput.typeText("Review the server")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Review answers"))
  expect(view.captureCharFrame()).toContain("Alpha, beta")
  expect(server.posts).toHaveLength(0)
  view.mockInput.pressKey("s", { ctrl: true })
  view.mockInput.pressKey("k", { ctrl: true })
  await view.renderOnce()
  expect(view.captureCharFrame()).not.toContain("Switch session")
  await waitForFrame(view, (frame) => frame.includes("Answers sent."))
  expect(server.posts).toEqual([
    { path: "/api/session/ses_running/question/que_docked/reply", body: { answers: [["First", "Alpha, beta"]] } },
  ])
})

test("shared working folders update the sidebar and explicit folder controls never launch a session", async () => {
  const options = { workingFolders: ["/srv/project", "/srv/empty"], folderRevision: 1 }
  const server = fixture(options)
  server.sessions.push({
    ...server.sessions[0]!,
    id: "ses_nested",
    title: "Nested project work",
    location: { directory: "/srv/project/package" },
  })
  const view = await createTestRenderer({ width: 140, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  await waitForFrame(view, (frame) => frame.includes("Nested project work") && frame.includes("/srv/empty"))
  options.workingFolders = ["/srv/empty"]
  options.folderRevision++
  await app.refresh()
  await waitForFrame(view, (frame) => !frame.includes("Nested project work") && frame.includes("(closed)"))
  await clickText(view, "Working folders")
  await waitForFrame(view, (frame) => frame.includes("Open another folder"))
  const input = () =>
    descendants(view.renderer.root).find((node) => node instanceof InputRenderable && node.focused) as InputRenderable
  input().value = "/srv/new"
  // Enter shows the chosen row, every open folder here, and never opens the typed one.
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => !frame.includes("Open another folder") && frame.includes("Showing every open"))
  expect(options.workingFolders).toEqual(["/srv/empty"])
  await clickText(view, "Working folders")
  await waitForFrame(view, (frame) => frame.includes("Open another folder"))
  input().value = "/srv/new"
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => !frame.includes("Open another folder") && frame.includes("Folder · new"))
  expect(options.workingFolders).toEqual(["/srv/empty", "/srv/new"])
  view.mockInput.pressKey("n", { ctrl: true })
  await waitForFrame(
    view,
    (frame) => frame.includes("What would you like to do?") && frame.includes("Directory: /srv/new"),
  )
  view.mockInput.pressKey("F4")
  await waitForFrame(view, (frame) => !frame.includes("What would you like to do?"))
  // Close mode acts on the folder on screen, which the cursor starts on, and closing it shows every folder again.
  await clickText(view, "Folder · new")
  await waitForFrame(view, (frame) => frame.includes("▶ /srv/new  · showing"))
  view.mockInput.pressKey("r", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Enter close it"))
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => !frame.includes("Open another folder") && frame.includes("Working folders · 1 open"))
  expect(options.workingFolders).toEqual(["/srv/empty"])
  expect(server.posts).toEqual([])
})

test("a permission with a saved rule offers Allow always, like the desktop", async () => {
  const server = fixture()
  server.pending.permissions = [
    { id: "per_test", sessionID: "ses_running", action: "shell", resources: ["npm test"], save: ["npm *"] },
  ]
  const view = await createTestRenderer({ width: 110, height: 38 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await waitForFrame(view, (frame) => frame.includes("Allow always"))
  expect(view.captureCharFrame()).toContain("saves 1 rule")
  view.mockInput.pressArrow("down")
  view.mockInput.pressArrow("down")
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Allowed always."))
  expect(server.posts[0]).toMatchObject({
    path: "/api/session/ses_running/permission/per_test/reply",
    body: { reply: "always" },
  })
})

test("long permission forms reveal the final resource and choice with keyboard scrolling", async () => {
  const server = fixture()
  server.pending.permissions = [
    {
      id: "per_long",
      sessionID: "ses_running",
      action: "shell",
      resources: Array.from({ length: 24 }, (_, index) => `Resource ${index + 1}`),
    },
  ]
  const view = await createTestRenderer({ width: 70, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("p")
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Review the server")
  view.mockInput.pressKey("\x1b[6~")
  view.mockInput.pressTab()
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Resource 24")
  expect(view.captureCharFrame()).toContain("Allow once")
  // Without a server-named rule there is nothing to save.
  expect(view.captureCharFrame()).not.toContain("Allow always")
  expect(server.posts).toHaveLength(0)
})

test("the primary action exposes the blocker before reply and still opens the correct request", async () => {
  const options = { authenticated: true }
  const server = fixture(options)
  server.pending.permissions = [{ id: "per_test", sessionID: "ses_running", action: "shell", resources: ["npm test"] }]
  server.pending.questions = [
    {
      id: "que_test",
      sessionID: "ses_running",
      questions: [
        {
          header: "Scope",
          question: "Which files?",
          options: [{ label: "Source", description: "Source files" }],
          custom: false,
        },
      ],
    },
  ]
  const view = await createTestRenderer({ width: 70, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  await waitForFrame(view, (frame) => frame.includes("Permission request"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Permission request") && frame.includes("need input"))
  // Closing the prompt leaves the reply editor open, saying the permission waits; Esc leaves it for shortcuts.
  await waitForFrame(view, (frame) => frame.includes("Enter reviews the permission"))
  await leaveComposer(view)
  expect(view.captureCharFrame()).not.toContain("Message…")
  const lines = view.captureCharFrame().split("\n")
  const y = lines.findIndex((line) => line.includes("p Review permission"))
  await view.mockMouse.click(lines[y]!.indexOf("p Review permission") + 1, y)
  await waitForFrame(view, (frame) => frame.includes("Permission request"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Permission request"))
  server.pending.permissions = []
  await app.refresh()
  await waitForFrame(view, (frame) => frame.includes("Question 1 of 1"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Question 1 of 1"))
  await leaveComposer(view)
  expect(view.captureCharFrame()).toContain("o Answer question")
  options.authenticated = false
  await app.refresh()
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("showing saved data")
  expect(view.captureCharFrame()).toContain("r Retry connection")
  expect(view.captureCharFrame()).not.toContain("Message…")
  options.authenticated = true
  const disconnected = view.captureCharFrame().split("\n")
  const retryRow = disconnected.findIndex((line) => line.includes("r Retry connection"))
  await view.mockMouse.click(disconnected[retryRow]!.indexOf("r Retry connection") + 1, retryRow)
  await waitForFrame(view, (frame) => frame.includes("o Answer question") && !frame.includes("Disconnected"))
  server.pending.questions = []
  await app.refresh()
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Message…")
  expect(server.posts).toHaveLength(0)
})

test("recovered session details remove their error and restore the pending action", async () => {
  const options = { messageStatus: undefined as number | undefined }
  const server = fixture(options)
  server.pending.permissions = [{ id: "per_test", sessionID: "ses_running", action: "shell", resources: ["npm test"] }]
  const view = await createTestRenderer({ width: 120, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  await waitForFrame(view, (frame) => frame.includes("Permission request"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Permission request"))
  options.messageStatus = 503
  await app.refresh()
  await waitForFrame(view, (frame) => frame.includes("Details unavailable"))
  expect(view.captureCharFrame()).toContain("r Retry details")
  expect(view.captureCharFrame()).not.toContain("p Review permission")
  options.messageStatus = undefined
  view.mockInput.pressKey("r")
  const frame = await waitForFrame(
    view,
    (frame) => frame.includes("Inspecting the server") && frame.includes("p Review permission"),
  )
  expect(frame).not.toContain("Details unavailable")
  expect(frame).not.toContain("Retry details")
  expect(server.posts).toHaveLength(0)
})
