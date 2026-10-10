import { expect, test } from "bun:test"
import { ScrollBoxRenderable, type Renderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { mountDashboard } from "../src/index"
import { cleanup, waitForFrame, leaveComposer, clickText, fixture } from "./dashboard-fixture"

test("session visits restore reading position and history without undoing user scrolling", async () => {
  const options = {
    text: Array.from({ length: 80 }, (_, i) => `Paragraph ${i}: a useful update.`).join("\n\n"),
    history: true,
  }
  const server = fixture(options)
  server.sessions.push({ ...server.sessions[0]!, id: "ses_second", title: "Another session" })
  const view = await createTestRenderer({ width: 70, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  await waitForFrame(view, (frame) => frame.includes("Paragraph 79:"))
  // A narrow terminal opens on the reply editor, where Alt+Left/Right move by word; Esc first to hop.
  await leaveComposer(view)
  view.mockInput.pressKey("\x1b[5~")
  await view.renderOnce()
  view.mockInput.pressKey("\x1b[6~")
  const scrolled = await waitForFrame(view, (frame) => frame.includes("Paragraph ") && !frame.includes("Paragraph 0:"))
  const paragraph = scrolled.match(/Paragraph \d+:/)![0]
  view.mockInput.pressArrow("right", { meta: true })
  await waitForFrame(view, (frame) => frame.includes("Another session") && frame.includes("Paragraph 79:"))
  view.mockInput.pressArrow("left", { meta: true })
  await waitForFrame(
    view,
    (frame) => frame.includes("Review the server") && frame.match(/Paragraph \d+:/)?.[0] === paragraph,
  )
  view.mockInput.pressKey("\x1b[5~")
  const further = await waitForFrame(
    view,
    (frame) => frame.includes("Paragraph ") && frame.match(/Paragraph \d+:/)?.[0] !== paragraph,
  )
  const next = further.match(/Paragraph \d+:/)![0]
  options.text += "\n\nA new update arrived."
  await app.refresh()
  await waitForFrame(view, (frame) => frame.match(/Paragraph \d+:/)?.[0] === next)
  view.mockInput.pressKey("h")
  await waitForFrame(
    view,
    (frame) => frame.includes("History ·") && frame.includes("test/local") && frame.includes("Paragraph 0:"),
  )
  view.mockInput.pressKey("\x1b[6~")
  const history = await waitForFrame(view, (frame) => frame.includes("Paragraph ") && !frame.includes("Paragraph 0:"))
  const previous = history.match(/Paragraph \d+:/)![0]
  view.mockInput.pressArrow("right", { meta: true })
  await waitForFrame(view, (frame) => frame.includes("Another session"))
  view.mockInput.pressArrow("left", { meta: true })
  await waitForFrame(view, (frame) => frame.includes("History ·") && frame.match(/Paragraph \d+:/)?.[0] === previous)
  expect(server.posts).toHaveLength(0)
})

test("live transcript follows appended output, pauses while reading, and reveals a new question", async () => {
  const options = { text: Array.from({ length: 80 }, (_, i) => `Line ${i}`).join("\n\n") }
  const server = fixture(options)
  const view = await createTestRenderer({ width: 70, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  await waitForFrame(view, (frame) => frame.includes("Line 79"))
  options.text += "\n\nNewest live output"
  await app.refresh()
  await waitForFrame(view, (frame) => frame.includes("Newest live output"))
  view.mockInput.pressKey("\x1b[5~")
  await view.renderOnce()
  const first = view.captureCharFrame().match(/Line \d+/)?.[0]
  expect(first).toBeDefined()
  options.text += "\n\nLater output"
  await app.refresh()
  await view.renderOnce()
  expect(view.captureCharFrame().match(/Line \d+/)?.[0]).toBe(first)
  expect(view.captureCharFrame()).not.toContain("Later output")
  server.pending.questions = [
    {
      id: "que_visible",
      sessionID: "ses_running",
      questions: [
        {
          header: "Choice",
          question: "Continue with the change?",
          options: [{ label: "Yes", description: "Continue" }],
        },
      ],
    },
  ]
  await app.refresh()
  await waitForFrame(view, (frame) => frame.includes("Continue with the change?"))
  expect(view.captureCharFrame()).toContain("Question 1 of 1")
  server.pending.questions = []
  await app.refresh()
  await view.renderOnce()
  expect(view.captureCharFrame().match(/Line \d+/)?.[0]).toBe(first)
  expect(view.captureCharFrame()).not.toContain("Later output")
  // End moves the cursor in the reply editor, so jump to the latest output from navigation.
  await leaveComposer(view)
  view.mockInput.pressKey("END")
  await waitForFrame(view, (frame) => frame.includes("Later output"))
  server.pending.questions = [
    {
      id: "que_again",
      sessionID: "ses_running",
      questions: [
        {
          header: "Confirm",
          question: "Ready for more?",
          options: [{ label: "Yes", description: "Continue" }],
        },
      ],
    },
  ]
  await app.refresh()
  await waitForFrame(view, (frame) => frame.includes("Ready for more?"))
  server.pending.questions = []
  options.text += "\n\nResumed after answering"
  await app.refresh()
  await waitForFrame(view, (frame) => frame.includes("Resumed after answering"))
  expect(server.posts).toHaveLength(0)
})

test("reply stays beside fresh conversation output and retains its recipient during inventory changes", async () => {
  const options = { text: "Original message to answer.", active: false }
  const server = fixture(options)
  const original = server.sessions[0]!
  server.sessions.push({ ...original, id: "ses_second", title: "Another session" })
  const view = await createTestRenderer({ width: 70, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  await waitForFrame(view, (frame) => frame.includes("Typing"))
  await view.mockInput.typeText("Reply to the original session")
  await waitForFrame(
    view,
    (frame) =>
      frame.includes("Original message to answer.") && frame.includes("Typing") && frame.includes("Enter send"),
  )
  options.text = "A fresh update arrived while composing."
  server.historical.set(original.id, original)
  server.sessions.splice(0, 1)
  await app.refresh()
  await waitForFrame(
    view,
    (frame) => frame.includes("A fresh update arrived") && frame.includes("Reply to the original session"),
  )
  // The reply goes to the session in view, which the title already names, so the editor has no heading repeating it.
  expect(view.captureCharFrame()).not.toContain("Reply to Review the server")
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Reply sent."))
  expect(server.posts).toHaveLength(1)
  expect(server.posts[0]).toMatchObject({
    path: "/api/session/ses_running/prompt",
    body: { prompt: { text: "Reply to the original session" } },
  })
})

for (const input of ["j", "scrollbar"] as const) {
  test(`${input} scrolling cancels a pending reading-position restore before polling`, async () => {
    const server = fixture({
      text: Array.from({ length: 80 }, (_, i) => `Paragraph ${i}: a useful update.`).join("\n\n"),
    })
    const view = await createTestRenderer({ width: 70, height: 24 })
    cleanup.push(() => view.renderer.destroy())
    const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
    await app.ready
    await waitForFrame(view, (frame) => frame.includes("Paragraph 79:"))
    view.mockInput.pressKey("\x1b[5~")
    await view.renderOnce()
    if (input === "j") {
      await leaveComposer(view)
      view.mockInput.pressKey("j")
    }
    if (input === "scrollbar") {
      const find = (node: Renderable): ScrollBoxRenderable | undefined => {
        if (node instanceof ScrollBoxRenderable && node.scrollHeight > node.viewport.height) return node
        for (const child of node.getChildren()) {
          const found = find(child)
          if (found) return found
        }
      }
      const slider = find(view.renderer.root)!.verticalScrollBar.slider
      await view.mockMouse.click(slider.x, slider.y + Math.floor(slider.height * 0.6))
    }
    const moved = await waitForFrame(view, (frame) => frame.includes("Paragraph ") && !frame.includes("Paragraph 0:"))
    await app.refresh()
    await view.renderOnce()
    expect(view.captureCharFrame().match(/Paragraph \d+:/)?.[0]).toBe(moved.match(/Paragraph \d+:/)?.[0])
    expect(server.posts).toHaveLength(0)
  })
}

test("repeated Enter on a busy docked reply sends exactly one POST and blocks edits and navigation", async () => {
  const server = fixture({ postDelay: 300 })
  server.sessions.push({ ...server.sessions[0]!, id: "ses_second", title: "Another session" })
  const view = await createTestRenderer({ width: 120, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("Send this exact reply")
  view.mockInput.pressEnter()
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Submitting"))
  expect(view.captureCharFrame()).toContain("Sending message")
  await view.mockInput.pressKeys(["\r", "\n", "\x1b[57414u"])
  await view.mockInput.typeText("Do not append this either")
  view.mockInput.pressKey("k", { ctrl: true })
  view.mockInput.pressArrow("right", { meta: true })
  view.mockInput.pressKey("n", { ctrl: true })
  await clickText(view, "2 Ter")
  await clickText(view, "+ New session")
  const lines = view.captureCharFrame().split("\n")
  const y = lines.findIndex((line) => line.includes("Another session"))
  await view.mockMouse.click(lines[y]!.indexOf("Another session") + 1, y)
  await view.mockInput.pasteBracketedText("Do not append this")
  view.mockInput.pressEnter()
  view.mockInput.pressKey("s", { ctrl: true })
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Send this exact reply")
  await waitForFrame(view, (frame) => frame.includes("Reply sent."))
  expect(server.posts).toHaveLength(1)
  expect(server.posts[0]).toMatchObject({
    path: "/api/session/ses_running/prompt",
    body: { prompt: { text: "Send this exact reply" } },
  })
  expect(server.reads).not.toContain("/api/session/ses_second/message")
})

for (const form of ["permission", "question", "kill"] as const) {
  test(`${form} pins its recipient and blocks abandonment ${form === "question" ? "while submitting" : "while open"}`, async () => {
    const server = fixture({ active: false, postDelay: form === "question" ? 3000 : undefined })
    server.sessions.push({ ...server.sessions[0]!, id: "ses_second", title: "Another session" })
    server.pending.permissions = [
      { id: "per_test", sessionID: "ses_running", action: "shell", resources: ["npm test"] },
    ]
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
    const view = await createTestRenderer({ width: 120, height: 36 })
    cleanup.push(() => view.renderer.destroy())
    const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
    await app.ready
    await waitForFrame(view, (frame) => frame.includes("Permission request"))
    view.mockInput.pressEscape()
    await waitForFrame(view, (frame) => !frame.includes("Permission request"))
    const rows = view.captureCharFrame().split("\n")
    const targets = ["2 Ter", "+ New session", "Find a session", "Sessions Ctrl+K", "Another session"].map((label) => {
      const y = rows.findIndex((line) => line.includes(label))
      expect(y).toBeGreaterThanOrEqual(0)
      return [rows[y]!.indexOf(label) + 1, y] as const
    })
    if (form === "kill") {
      view.mockInput.pressKey("p", { ctrl: true })
      await view.mockInput.typeText("kill")
      view.mockInput.pressEnter()
    } else view.mockInput.pressKey(form === "permission" ? "p" : "o")
    const send = form === "permission" ? "Ctrl+S confirms Reject" : "Ctrl+S kill"
    await waitForFrame(view, (frame) => frame.includes(form === "question" ? "Question 1 of 1" : send))
    if (form === "question") {
      view.mockInput.pressEnter()
      await waitForFrame(view, (frame) => frame.includes("Review answers"))
      view.mockInput.pressKey("s", { ctrl: true })
    }
    const hint = form === "question" ? "Submitting…" : send
    await waitForFrame(view, (frame) => frame.includes(hint))
    view.mockInput.pressKey("k", { ctrl: true })
    view.mockInput.pressArrow("right", { meta: true })
    view.mockInput.pressKey("n", { ctrl: true })
    for (const [x, y] of targets) await view.mockMouse.click(x, y)
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain(hint)
    expect(view.captureCharFrame()).not.toContain("What would you like to do?")
    expect(view.captureCharFrame()).not.toContain("Switch session")
    expect(server.reads).not.toContain("/api/session/ses_second/message")

    server.sessions.shift()
    await app.refresh()
    view.resize(70, 24)
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("Review the server")
    expect(view.captureCharFrame()).not.toContain("Another session")
    expect(server.reads).not.toContain("/api/session/ses_second/message")
    if (form === "permission") view.mockInput.pressArrow("down")
    if (form === "kill") await view.mockInput.typeText("kill")
    view.mockInput.pressKey("s", { ctrl: true })
    await waitForFrame(view, (frame) =>
      frame.includes(
        form === "permission" ? "Allowed once." : form === "question" ? "Answers sent." : "Session killed.",
      ),
    )
    expect(server.posts).toHaveLength(1)
    expect(server.posts[0]).toMatchObject(
      form === "permission"
        ? { path: "/api/session/ses_running/permission/per_test/reply", body: { reply: "once" } }
        : form === "question"
          ? { path: "/api/session/ses_running/question/que_test/reply", body: { answers: [["Source"]] } }
          : { path: "/api/session/ses_running/interrupt" },
    )
  })
}

test("Escape explicitly abandons an unanswered request and permits navigation", async () => {
  const server = fixture()
  server.pending.permissions = [{ id: "per_test", sessionID: "ses_running", action: "shell", resources: ["npm test"] }]
  const view = await createTestRenderer({ width: 120, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("p")
  await waitForFrame(view, (frame) => frame.includes("Permission request"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Permission request"))
  await clickText(view, "2 Ter")
  await waitForFrame(view, (frame) => frame.includes("PID 4242"))
  expect(server.posts).toHaveLength(0)
})
