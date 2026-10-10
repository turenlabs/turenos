import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { mountDashboard } from "../src/index"
import { cleanup, waitForFrame, leaveComposer, clickText, fixture } from "./dashboard-fixture"

test("dashboard renders server inventory, global terminal PID, and responsive layout", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 120, height: 38 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  await view.renderOnce()
  await waitForFrame(view, (frame) => frame.includes("Inspecting the server"))
  expect(view.captureCharFrame()).toContain("TurenOS")
  expect(view.captureCharFrame()).toContain("* Review the server")
  expect(view.captureCharFrame()).toContain("Inspecting the server")
  view.mockInput.pressKey("2")
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("PID 4242")
  expect(view.captureCharFrame()).toContain("/srv/other")
  view.resize(70, 28)
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Build worker")
  expect(view.captureCharFrame()).toContain("Ctrl+P")
})

test("model picker searches connected models and switches only the captured session", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  expect(await waitForFrame(view, (frame) => frame.includes("Models m"))).toContain("Models m")
  view.mockInput.pressKey("m")
  await waitForFrame(view, (frame) => frame.includes("Catalog Model"))
  await view.mockInput.typeText("org/model")
  server.sessions.unshift({ ...server.sessions[0]!, id: "ses_another", title: "Another recipient" })
  await app.refresh()
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Model selected for Review the server"))
  expect(server.posts).toEqual([
    { path: "/api/session/ses_running/model", body: { model: { providerID: "test", id: "org/model" } } },
  ])
})

test("draft model selection preserves task, mid-text cursor, and directory without admitting work", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("n")
  await view.mockInput.typeText("Keep my unsent task")
  view.mockInput.pressArrow("left", { meta: true })
  expect(view.renderer.currentFocusedEditor?.cursorOffset).toBe("Keep my unsent ".length)
  view.mockInput.pressKey("l", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Catalog Model"))
  expect(view.captureCharFrame()).toContain("For this launch draft")
  await view.mockInput.typeText("org/model")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Keep my unsent task") && frame.includes("test/org/model"))
  expect(server.posts).toHaveLength(0)
  expect(view.renderer.currentFocusedEditor?.cursorOffset).toBe("Keep my unsent ".length)
  await view.mockInput.typeText("new ")
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Keep my unsent new task")
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Task sent."))
  expect(server.posts[0]?.body).toMatchObject({
    location: { directory: "/srv/project" },
    model: { providerID: "test", id: "org/model" },
  })
  expect(server.posts[1]?.body).toMatchObject({ prompt: { text: "Keep my unsent new task" } })
})

test("header Models targets an open draft, and Escape restores its mid-text cursor", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("n")
  await view.mockInput.typeText("Header draft")
  view.mockInput.pressArrow("left", { meta: true })
  expect(view.renderer.currentFocusedEditor?.cursorOffset).toBe("Header ".length)
  await clickText(view, "Models")
  await waitForFrame(view, (frame) => frame.includes("For this launch draft"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => frame.includes("Header draft"))
  expect(view.renderer.currentFocusedEditor?.cursorOffset).toBe("Header ".length)
  await view.mockInput.typeText("saved ")
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Header saved draft")
  expect(server.posts).toHaveLength(0)
})

test("navigating away from the draft model picker does not reopen the draft over another session", async () => {
  const server = fixture()
  server.sessions.push({ ...server.sessions[0]!, id: "ses_next", title: "Next session" })
  const view = await createTestRenderer({ width: 100, height: 36, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("n")
  await view.mockInput.typeText("Preserved draft")
  view.mockInput.pressKey("l", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Catalog Model"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => frame.includes("Preserved draft"))
  view.mockInput.pressEscape()
  view.mockInput.pressArrow("right", { meta: true })
  await waitForFrame(view, (frame) => frame.includes("Next session") && !frame.includes("Choose model"))
  expect(view.captureCharFrame()).not.toContain("What would you like to do?")
  view.mockInput.pressKey("n")
  await waitForFrame(view, (frame) => frame.includes("Preserved draft"))
  expect(server.posts).toHaveLength(0)
})

test("catalog failure is isolated from session readiness and can be retried", async () => {
  const options = { providerStatus: 404 as number | undefined }
  const server = fixture(options)
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  view.mockInput.pressKey("m")
  await waitForFrame(view, (frame) => frame.includes("Cannot load models"))
  expect(view.captureCharFrame()).not.toContain("Disconnected")
  options.providerStatus = undefined
  view.mockInput.pressKey("r", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Catalog Model"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Choose model"))
  view.mockInput.pressKey("f")
  await waitForFrame(view, (frame) => frame.includes("Typing"))
  expect(server.posts).toHaveLength(0)
})

test("an empty catalog leads to provider setup and returns without submitting at 60 columns", async () => {
  const server = fixture({ noModels: true })
  const view = await createTestRenderer({ width: 60, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  await leaveComposer(view)
  view.mockInput.pressKey("m")
  await waitForFrame(view, (frame) => frame.includes("No connected models"))
  view.mockInput.pressKey("F2")
  await waitForFrame(view, (frame) => frame.includes("Connect a provider"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => frame.includes("Choose model"))
  expect(server.posts).toHaveLength(0)
})

test("late catalog replies cannot replace a closed picker or mutate a session", async () => {
  const server = fixture({ providerDelay: 100 })
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("m")
  await waitForFrame(view, (frame) => frame.includes("Loading models"))
  view.mockInput.pressEscape()
  view.mockInput.pressKey("n")
  await view.mockInput.typeText("Not a model search")
  await Bun.sleep(150)
  await waitForFrame(view, (frame) => frame.includes("Not a model search"))
  expect(view.captureCharFrame()).not.toContain("Catalog Model")
  expect(server.posts).toHaveLength(0)
})

test("submitted launch locks model selection while preserving exact retry fields", async () => {
  const server = fixture({ failPromptOnce: true })
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("n")
  await view.mockInput.typeText("One admission")
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Ctrl+O inspect"))
  view.mockInput.pressKey("l", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("original submission is locked"))
  expect(server.reads).not.toContain("/provider")
  view.mockInput.pressKey("s", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Task sent."))
  expect(server.posts.filter((post) => post.path === "/api/session")).toHaveLength(1)
  expect(server.posts[2]).toEqual(server.posts[1])
})

test("keyboard launch chooses a primary agent and admits the typed task only once", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 110, height: 38, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  view.mockInput.pressKey("n")
  await waitForFrame(view, (frame) => frame.includes("What would you like to do?"))
  await view.mockInput.typeText("Inspect server processes")
  view.mockInput.pressTab()
  view.mockInput.pressTab()
  await waitForFrame(view, (frame) => frame.includes("Server default") && !frame.includes("Loading agents"))
  view.mockInput.pressArrow("down")
  view.mockInput.pressTab()
  await view.mockInput.typeText("test/local")
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Inspect server processes")
  view.mockInput.pressEnter({ ctrl: true })
  view.mockInput.pressEnter({ ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Task sent."))
  expect(server.posts.filter((post) => post.path === "/api/session")).toHaveLength(1)
  expect(server.posts[0]?.body).toMatchObject({
    agent: "build",
    model: { providerID: "test", id: "local" },
    location: { directory: "/srv/project" },
  })
  expect(server.posts[1]?.body).toMatchObject({ prompt: { text: "Inspect server processes" } })
})

test("filter, palette, and disconnected stale state remain keyboard operable", async () => {
  const server = fixture()
  const view = await createTestRenderer({ width: 110, height: 32, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  await app.ready
  view.mockInput.pressKey("/")
  await view.mockInput.typeText("missing")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("No matching loaded sessions"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Switch session"))
  view.mockInput.pressKey("p", { ctrl: true })
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Commands")
  view.mockInput.pressEscape()
  await app.refresh()
  await server.server.stop(true)
  await app.refresh()
  await view.renderOnce()
  expect(view.captureCharFrame()).toContain("Disconnected")
  expect(view.captureCharFrame()).toContain("saved data")
})

test("F2 composing refuses a draft whose submission is locked for retry", async () => {
  const server = fixture({ failPromptOnce: true })
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("Original message")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Ctrl+S retry"))
  expect(server.posts).toHaveLength(1)

  // Retrying requires the original text, so composing cannot rewrite it and
  // must not hand the terminal to an editor.
  view.mockInput.pressKey("\x1b[12~")
  await waitForFrame(view, (frame) => frame.includes("original submission is locked"))
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Original message")
  expect(server.posts).toHaveLength(1)
})

test("effort selection in a new draft is retained through reopening and sent with the chosen model", async () => {
  const server = fixture({ variants: { low: {}, high: {} } })
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("n")
  view.mockInput.pressKey("l", { ctrl: true })
  await waitForFrame(view, (frame) => frame.includes("Catalog Model"))
  await view.mockInput.typeText("Catalog")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("What would you like to do?"))
  await view.mockInput.typeText("/effort")
  await waitForFrame(view, (frame) => frame.includes("Choose model effort"))
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Model variant / effort") && frame.includes("low"))
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("What would you like to do?") && frame.includes("variant low"))
  expect(server.posts).toHaveLength(0)
  await view.mockInput.typeText("Use the selected effort")
  view.mockInput.pressEnter()
  await waitForFrame(view, (frame) => frame.includes("Task sent."))
  expect(server.posts[0]?.body.model).toEqual({ providerID: "test", id: "org/model", variant: "low" })
  expect(server.posts[1]?.body.prompt).toEqual({ text: "Use the selected effort" })
})
