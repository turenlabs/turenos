import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { mountDashboard } from "../src/index"
import { cleanup, waitForFrame, leaveComposer, clickText, fixture } from "./dashboard-fixture"

test("saved launch drafts remain readable and discardable while disconnected", async () => {
  const settings = { authenticated: true }
  const server = fixture(settings)
  const view = await createTestRenderer({ width: 100, height: 30 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  view.mockInput.pressKey("n")
  await view.mockInput.typeText("Keep offline")
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => frame.includes("Draft kept"))
  settings.authenticated = false
  await app.refresh()
  view.mockInput.pressKey("n")
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Keep offline")
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.replace(/\s+/g, " ").includes("Reconnect before sending"))
  view.mockInput.pressKey("F4")
  await waitForFrame(view, (frame) => frame.includes("Local draft discarded"))
  expect(server.posts).toHaveLength(0)
})

for (const submitted of [false, true]) {
  test(`directory changes during discovery ${submitted ? "retain the submitted retry identity" : "cannot carry the old agent into a saved draft"}`, async () => {
    const options = {
      agentDelay: 0,
      failPromptOnce: submitted,
      agents: { "/srv/project": ["build"], "/srv/other": ["review"] },
    }
    const server = fixture(options)
    const view = await createTestRenderer({ width: 120, height: 38 })
    cleanup.push(() => view.renderer.destroy())
    await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
    view.mockInput.pressKey("n")
    await view.mockInput.typeText("Keep the task identity")
    view.mockInput.pressTab()
    view.mockInput.pressTab()
    await waitForFrame(view, (frame) => frame.includes("Server default") && !frame.includes("Loading agents"))
    view.mockInput.pressArrow("down")
    view.mockInput.pressEscape()
    await waitForFrame(view, (frame) => frame.includes("Draft kept"))
    view.mockInput.pressKey("n")
    await waitForFrame(view, (frame) => frame.includes("▶ build"))
    if (submitted) {
      view.mockInput.pressKey("s", { ctrl: true })
      await waitForFrame(view, (frame) => frame.includes("Ctrl+O inspect"))
    }
    options.agentDelay = 200
    view.mockInput.pressTab()
    view.mockInput.pressKey("a", { ctrl: true })
    for (let index = 0; index < "/srv/project".length; index++) view.mockInput.pressKey("DELETE")
    await view.mockInput.typeText("/srv/other")
    view.mockInput.pressTab()
    await waitForFrame(view, (frame) => frame.includes("Loading agents"))
    view.mockInput.pressEscape()
    await waitForFrame(view, (frame) => frame.includes(submitted ? "Original submission kept" : "Draft kept"))
    view.mockInput.pressKey("n")
    await waitForFrame(view, (frame) => frame.includes("Keep the task identity"))
    view.mockInput.pressTab()
    view.mockInput.pressTab()
    await waitForFrame(view, (frame) => frame.includes("Server default") && !frame.includes("Loading agents"))
    const lines = view.captureCharFrame().split("\n")
    expect(lines[lines.findIndex((line) => line.includes("Directory on the server")) + 1]).toContain(
      submitted ? "/srv/project" : "/srv/other",
    )
    if (!submitted) expect(view.captureCharFrame()).not.toContain("▶ build")
    view.mockInput.pressKey("s", { ctrl: true })
    await waitForFrame(view, (frame) => frame.includes("Task sent."))
    expect(server.posts.filter((post) => post.path === "/api/session")).toHaveLength(1)
    if (submitted) expect(server.posts[2]).toEqual(server.posts[1])
    if (!submitted) {
      expect(server.posts[0]?.body).toMatchObject({ location: { directory: "/srv/other" } })
      expect(server.posts[0]?.body.agent).toBeUndefined()
    }
  })
}

for (const inspect of [false, true]) {
  test(`launch ${inspect ? "inspection" : "success"} preserves the departing tab's filter and selection`, async () => {
    const server = fixture({ failPromptOnce: inspect })
    const view = await createTestRenderer({ width: 120, height: 36 })
    cleanup.push(() => view.renderer.destroy())
    await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
    view.mockInput.pressKey("2")
    await waitForFrame(view, (frame) => frame.includes("PID 4242"))
    view.mockInput.pressKey("/")
    await view.mockInput.typeText("worker")
    view.mockInput.pressEnter()
    view.mockInput.pressKey("n")
    await view.mockInput.typeText("Launch from terminals")
    view.mockInput.pressKey("s", { ctrl: true })
    await waitForFrame(view, (frame) => frame.includes(inspect ? "Ctrl+O inspect" : "Task sent."))
    if (inspect) view.mockInput.pressKey("o", { ctrl: true })
    await waitForFrame(view, (frame) => frame.includes("New agent") && !frame.includes("What would you like to do?"))
    await leaveComposer(view)
    view.mockInput.pressKey("2")
    await waitForFrame(view, (frame) => frame.includes("PID 4242") && frame.includes("Find: worker"))
    expect(server.posts).toHaveLength(2)
  })
}

test("saved replies remain findable outside recent inventory and revalidate before sending", async () => {
  const server = fixture({ active: false })
  const original = server.sessions[0]!
  server.sessions.push({ ...original, id: "ses_other", title: "Other work" })
  const view = await createTestRenderer({ width: 60, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  await waitForFrame(view, (frame) => frame.includes("Esc shortcuts"))
  await view.mockInput.typeText("A recoverable saved reply")
  await leaveComposer(view)
  await waitForFrame(view, (frame) => frame.includes("Message draft kept"))
  server.sessions.shift()
  server.historical.set(original.id, original)
  await app.refresh()
  view.mockInput.pressArrow("left", { meta: true })
  await waitForFrame(view, (frame) => frame.includes("Other work"))
  view.mockInput.pressKey("k", { ctrl: true })
  await view.mockInput.typeText("Review")
  await waitForFrame(view, (frame) => frame.includes("draft"))
  view.mockInput.pressEnter()
  // Opening the saved session opens its reply editor by itself, with the draft.
  await waitForFrame(view, (frame) => frame.includes("A recoverable saved reply"))
  server.historical.clear()
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Session not found"))
  expect(server.posts).toHaveLength(0)
  server.historical.set(original.id, original)
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Reply sent."))
  expect(server.posts[0]).toMatchObject({
    path: `/api/session/${original.id}/prompt`,
    body: { prompt: { text: "A recoverable saved reply" } },
  })
})

test("older session lookup validates IDs and retains exact results across refresh", async () => {
  const server = fixture({ more: true })
  server.historical.set("ses_archive", { ...server.sessions[0]!, id: "ses_archive", title: "Archived investigation" })
  const view = await createTestRenderer({ width: 60, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  await leaveComposer(view)
  view.mockInput.pressKey("k", { ctrl: true })
  await view.mockInput.typeText("ses_archive")
  view.mockInput.pressKey("o", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Open session by ID"))
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Archived investigation") && !frame.includes("Open session by ID"))
  await app.refresh()
  expect(view.captureCharFrame()).toContain("Archived investigation")
  await leaveComposer(view)
  view.mockInput.pressKey("k", { ctrl: true })
  view.mockInput.pressKey("o", { ctrl: true })
  await view.mockInput.typeText("../../invalid")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("valid session ID"))
  expect(server.reads.some((path) => path.includes("invalid"))).toBe(false)
  expect(server.posts).toHaveLength(0)
})

test("history paging preserves pages at boundaries, on refresh, and on session switches", async () => {
  const server = fixture({ pages: true })
  server.sessions.push({ ...server.sessions[0]!, id: "ses_other", title: "Other work" })
  const view = await createTestRenderer({ width: 60, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  await leaveComposer(view)
  view.mockInput.pressKey("h")
  await waitForFrame(
    view,
    (frame) => frame.includes("History ·") && frame.includes("[ Older") && frame.includes("Inspecting the server"),
  )
  view.mockInput.pressKey("]")
  await waitForFrame(view, (frame) => frame.includes("Newest history page."))
  expect(view.captureCharFrame()).toContain("Inspecting the server")
  await clickText(view, "[ Older")
  await waitForFrame(view, (frame) => frame.includes("original task on the older page"))
  await app.refresh()
  expect(view.captureCharFrame()).toContain("original task on the older page")
  view.mockInput.pressKey("[")
  await waitForFrame(view, (frame) => frame.includes("Start of history reached."))
  expect(view.captureCharFrame()).toContain("original task on the older page")
  view.mockInput.pressArrow("right", { meta: true })
  await waitForFrame(view, (frame) => frame.includes("Other work"))
  view.mockInput.pressArrow("left", { meta: true })
  await waitForFrame(view, (frame) => frame.includes("original task on the older page") && frame.includes("History"))
  view.mockInput.pressKey("h")
  await waitForFrame(view, (frame) => frame.includes("Inspecting the server"))
  view.mockInput.pressKey("h")
  await waitForFrame(view, (frame) => frame.includes("original task on the older page"))
  view.mockInput.pressKey("]")
  await waitForFrame(view, (frame) => frame.includes("Inspecting the server") && frame.includes("History"))
  expect(server.messageCursors).toContain("older")
  expect(server.messageCursors).toContain("newer")
  expect(server.posts).toHaveLength(0)
})

test("history paging waits for the restored page instead of using Latest cursors", async () => {
  const server = fixture({ pages: true, messageDelay: 100 })
  const view = await createTestRenderer({ width: 70, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await leaveComposer(view)
  view.mockInput.pressKey("h")
  await waitForFrame(
    view,
    (frame) => frame.includes("History ·") && frame.includes("[ Older") && frame.includes("Inspecting the server"),
  )
  view.mockInput.pressKey("[")
  await waitForFrame(view, (frame) => frame.includes("original task on the older page"))
  view.mockInput.pressKey("h")
  await waitForFrame(view, (frame) => frame.includes("Inspecting the server"))
  const before = server.messageCursors.length
  view.mockInput.pressKey("h")
  view.mockInput.pressKey("[")
  await waitForFrame(view, (frame) => frame.includes("original task on the older page"))
  expect(server.messageCursors.slice(before)).toEqual(["older"])
  expect(server.posts).toHaveLength(0)
})

test("queued reply keeps its visible delivery mode and identity after an uncertain send", async () => {
  const server = fixture({ failPromptOnce: true })
  server.sessions[0] = {
    ...server.sessions[0]!,
    title: "A long session title that fills more than fifty terminal columns",
  }
  const view = await createTestRenderer({ width: 60, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await waitForFrame(view, (frame) => frame.includes("Esc shortcuts"))
  await view.mockInput.typeText("Follow this after pending steers")
  view.mockInput.pressKey("t", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Queue · sent when"))
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Ctrl+S retry"))
  view.mockInput.pressKey("t", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("original delivery mode"))
  view.mockInput.pressEscape()
  view.mockInput.pressKey("f")
  await waitForFrame(view, (frame) => frame.includes("Queue · sent when"))
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Reply queued."))
  expect(server.posts).toHaveLength(2)
  expect(server.posts[0]).toEqual(server.posts[1])
  expect(server.posts[0]?.body.delivery).toBe("queue")
})

test("question rejection is explicit, reversible before submission, and session-bound", async () => {
  const server = fixture()
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
  const view = await createTestRenderer({ width: 60, height: 24, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await waitForFrame(view, (frame) => frame.includes("Question 1 of 1"))
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Review answers"))
  view.mockInput.pressKey("r", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("confirm rejection"))
  for (const enter of ["\r", "\n", "\x1b[57414u"]) {
    await view.mockInput.pressKeys([enter])
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("Ctrl+S confirm rejection")
    expect(server.posts).toHaveLength(0)
  }
  view.mockInput.pressKey("r", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Review answers"))
  expect(view.captureCharFrame()).toContain("Source")
  view.mockInput.pressKey("r", { ctrl: true })
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Question rejected."))
  expect(server.posts).toEqual([{ path: "/api/session/ses_running/question/que_test/reject", body: {} }])
})

for (const kind of ["terminals", "automations"] as const) {
  test(`${kind} failures are visible without disabling replies and recover independently`, async () => {
    const options = { ptyStatus: kind === "terminals" ? 500 : 0, loopStatus: kind === "automations" ? 500 : 0 }
    const server = fixture(options)
    const view = await createTestRenderer({ width: 70, height: 24 })
    cleanup.push(() => view.renderer.destroy())
    const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
    await app.ready
    expect(view.captureCharFrame()).not.toContain("Disconnected")
    await waitForFrame(view, (frame) => frame.includes("Esc shortcuts"))
    await view.mockInput.typeText("Session work remains available")
    view.mockInput.pressKey("s", { ctrl: true })
    await waitForFrame(view, (frame) => frame.includes("Reply sent."))
    await leaveComposer(view)
    view.mockInput.pressKey(kind === "terminals" ? "2" : "3")
    await waitForFrame(view, (frame) => frame.includes("HTTP 500"))
    expect(view.captureCharFrame()).toContain("Sessions remain available")
    options.ptyStatus = 0
    options.loopStatus = 0
    await app.refresh()
    await waitForFrame(view, (frame) => frame.includes(kind === "terminals" ? "PID 4242" : "Nightly checks"))
  })
}

test("automation run failures preserve the overview", async () => {
  const server = fixture({ runStatus: 500 })
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("3")
  await waitForFrame(view, (frame) => frame.includes("Run history unavailable"))
  expect(view.captureCharFrame()).toContain("Review overnight changes")
  expect(view.captureCharFrame()).not.toContain("Details unavailable")
})
