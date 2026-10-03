import { afterEach, expect, test } from "bun:test"
import { SelectRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createDialogs } from "../src/dialogs"
import { createLayout } from "../src/layout"
import { connect, type Session } from "../src/server"
import { createSessionControls } from "../src/session-controls"
import { createDashboardState } from "../src/state"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function fixture() {
  const session: Session = {
    id: "ses_controls",
    projectID: "project",
    title: "Captured session",
    agent: "build",
    location: { directory: "/srv/project", workspaceID: "workspace" },
    time: { created: 1, updated: 2 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  const remote = {
    session: structuredClone(session),
    blocked: false,
    catalogError: false,
    lookupError: false,
    refusal: false,
    catalogGate: undefined as Promise<void> | undefined,
    mutationGate: undefined as Promise<void> | undefined,
  }
  const requests: { method: string; path: string; query: string; body: string }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = await request.text()
      requests.push({ method: request.method, path: url.pathname, query: url.search, body })
      if (request.method === "GET" && url.pathname === "/api/agent") {
        await remote.catalogGate
        if (remote.catalogError)
          return Response.json({ _tag: "InvalidRequestError", message: "Agent catalog unavailable" }, { status: 400 })
        return Response.json({
          location: { directory: "/srv/project", project: { id: "project", directory: "/srv/project" } },
          data: [
            { id: "build", mode: "primary", hidden: false },
            { id: "plan", mode: "all", hidden: false },
            { id: "internal", mode: "primary", hidden: true },
            { id: "worker", mode: "subagent", hidden: false },
          ].map((agent) => ({ ...agent, request: { headers: {}, body: {} }, permissions: [] })),
        })
      }
      if (request.method === "GET" && url.pathname === "/api/session/ses_controls") {
        if (remote.lookupError) return new Response(null, { status: 404 })
        return Response.json({ data: remote.session })
      }
      if (
        request.method === "POST" &&
        ["/api/session/ses_controls/compact", "/api/session/ses_controls/agent"].includes(url.pathname)
      ) {
        await remote.mutationGate
        if (remote.refusal)
          return Response.json(
            { _tag: "InvalidRequestError", message: "Session is busy; compaction refused" },
            { status: 400 },
          )
        if (url.pathname.endsWith("/agent")) remote.session = { ...remote.session, agent: JSON.parse(body).agent }
        return new Response(null, { status: 204 })
      }
      return new Response("Unexpected route", { status: 404 })
    },
  })
  cleanup.push(() => server.stop(true))
  const connection = connect({ url: server.url.href })
  cleanup.push(connection.close)
  const view = await createTestRenderer({ width: 100, height: 36, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  const state = createDashboardState()
  state.connected = true
  state.selected = session.id
  state.history = true
  state.historyCursor = "retained-cursor"
  state.snapshot = {
    location: { directory: "/srv/project", project: { id: "project", directory: "/srv/project" } },
    sessions: [session],
    active: {},
    terminals: [],
    terminalsAvailable: true,
    loops: [],
    inventoryErrors: { terminals: "", automations: "" },
    updated: 2,
    more: false,
  }
  view.renderer.once("destroy", () => {
    state.closed = true
  })
  const ui = createLayout(view.renderer, state)
  const notices: string[] = []
  const say = (message: string) => {
    notices.push(message)
  }
  const dialogs = createDialogs(view.renderer, state, ui, {
    rememberPosition: () => {},
    cancelPosition: () => {},
    changed: () => {
      ui.resize()
      ui.focus()
    },
    submitted: async () => {},
    say,
  })
  view.renderer.keyInput.on("keypress", dialogs.keypress)
  view.renderer.on("resize", ui.resize)
  const saved = { recipient: session, text: "Saved reply must stay here" }
  const controls = createSessionControls(
    view.renderer,
    state,
    connection,
    dialogs,
    say,
    (updated) => {
      saved.recipient = updated
    },
    (id) => id === session.id && remote.blocked,
  )
  async function waitFor(predicate: (frame: string) => boolean) {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      await view.renderOnce()
      if (predicate(view.captureCharFrame())) return view.captureCharFrame()
      await Bun.sleep(5)
    }
    throw new Error(`Expected control state did not appear:\n${view.captureCharFrame()}`)
  }
  const submit = () => view.mockInput.pressKey("s", { ctrl: true })
  return { state, remote, view, requests, controls, dialogs, saved, notices, waitFor, submit }
}

test("compact requires explicit confirmation and captures its recipient without changing the view", async () => {
  const app = await fixture()
  const gate = Promise.withResolvers<void>()
  app.remote.mutationGate = gate.promise
  app.controls.compact()
  const frame = await app.waitFor((frame) => frame.includes("Ctrl+S confirm"))
  expect(frame).toContain("summarize this conversation")
  app.view.mockInput.pressEnter()
  await app.view.renderOnce()
  expect(app.requests).toEqual([])
  app.state.selected = "ses_elsewhere"
  app.submit()
  await app.waitFor(() => app.requests.some((request) => request.method === "POST"))
  expect(app.dialogs.navigate()).toBe(false)
  app.submit()
  app.view.mockInput.pressEscape()
  expect(app.state.modal?.busy).toBe(true)
  expect(app.state.selected).toBe("ses_elsewhere")
  gate.resolve()
  await app.waitFor(() => !app.state.modal)
  expect(app.requests.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
    { method: "GET", path: "/api/session/ses_controls", body: "" },
    { method: "POST", path: "/api/session/ses_controls/compact", body: "" },
  ])
  expect(app.state.history).toBe(true)
  expect(app.state.historyCursor).toBe("retained-cursor")
  expect(app.saved.text).toBe("Saved reply must stay here")
  expect(app.saved.recipient.id).toBe("ses_controls")
})

test("server refusal stays visible and never sends interrupt or navigates", async () => {
  const app = await fixture()
  app.remote.refusal = true
  app.controls.compact()
  app.submit()
  await app.waitFor((frame) => frame.includes("compaction refused"))
  expect(app.state.modal?.busy).toBe(false)
  expect(app.state.selected).toBe("ses_controls")
  expect(app.state.historyCursor).toBe("retained-cursor")
  expect(app.requests.filter((request) => request.method === "POST").map((request) => request.path)).toEqual([
    "/api/session/ses_controls/compact",
  ])
})

test("agent discovery is read-only, excludes internal agents, and confirms the refreshed recipient", async () => {
  const app = await fixture()
  const gate = Promise.withResolvers<void>()
  app.remote.catalogGate = gate.promise
  app.controls.agent()
  await app.waitFor((frame) => frame.includes("Loading agents"))
  app.submit()
  await app.waitFor((frame) => frame.includes("Choose a loaded"))
  expect(app.requests.every((request) => request.method === "GET")).toBe(true)
  gate.resolve()
  await app.waitFor((frame) => frame.includes("Up/Down choose"))
  expect(new URLSearchParams(app.requests[0]!.query).get("location[directory]")).toBe("/srv/project")
  const select = app.state.modal!.fields.find((field) => field instanceof SelectRenderable) as SelectRenderable
  expect(select.options.map((option) => option.name.trim())).toEqual(["* build", "plan"])
  await app.view.mockInput.typeText("plan")
  app.state.selected = "ses_elsewhere"
  app.submit()
  await app.waitFor(() => !app.state.modal)
  expect(app.requests.slice(1).map(({ method, path, body }) => ({ method, path, body }))).toEqual([
    { method: "GET", path: "/api/session/ses_controls", body: "" },
    { method: "POST", path: "/api/session/ses_controls/agent", body: '{"agent":"plan"}' },
    { method: "GET", path: "/api/session/ses_controls", body: "" },
  ])
  expect(app.saved.recipient.agent).toBe("plan")
  expect(app.saved.recipient.id).toBe("ses_controls")
  expect(app.state.snapshot!.sessions[0]!.agent).toBe("plan")
  expect(app.state.selected).toBe("ses_elsewhere")
  expect(app.saved.text).toBe("Saved reply must stay here")
})

test("agent catalog failure retries manually and stale async results cannot populate another dialog", async () => {
  const app = await fixture()
  app.remote.catalogError = true
  app.controls.agent()
  await app.waitFor((frame) => frame.includes("Cannot load agents"))
  app.remote.catalogError = false
  app.view.mockInput.pressKey("r", { ctrl: true })
  await app.waitFor((frame) => frame.includes("Up/Down choose"))
  app.view.mockInput.pressEscape()
  const gate = Promise.withResolvers<void>()
  app.remote.catalogGate = gate.promise
  app.controls.agent()
  await app.waitFor((frame) => frame.includes("Loading agents"))
  app.view.mockInput.pressEscape()
  app.controls.compact()
  const dialog = app.state.modal
  gate.resolve()
  await Bun.sleep(20)
  await app.view.renderOnce()
  expect(app.state.modal).toBe(dialog)
  expect(app.view.captureCharFrame()).toContain("Ctrl+S confirm")
  expect(app.requests.every((request) => request.method === "GET")).toBe(true)
})

test("agent with no choice is read-only and pending switches reject repeated submits and navigation", async () => {
  const app = await fixture()
  app.controls.agent()
  await app.waitFor((frame) => frame.includes("Up/Down choose"))
  await app.view.mockInput.typeText("missing")
  app.submit()
  await app.waitFor((frame) => frame.includes("Choose a loaded"))
  expect(app.requests.every((request) => request.method === "GET")).toBe(true)
  app.view.mockInput.pressEscape()
  app.controls.agent()
  await app.waitFor((frame) => frame.includes("Up/Down choose"))
  await app.view.mockInput.typeText("plan")
  const gate = Promise.withResolvers<void>()
  app.remote.mutationGate = gate.promise
  app.submit()
  await app.waitFor(() => app.requests.some((request) => request.method === "POST"))
  app.submit()
  app.view.mockInput.pressEscape()
  expect(app.dialogs.navigate()).toBe(false)
  expect(app.state.selected).toBe("ses_controls")
  expect(app.saved.recipient.agent).toBe("build")
  gate.resolve()
  await app.waitFor(() => !app.state.modal)
  expect(app.requests.filter((request) => request.method === "POST")).toHaveLength(1)
  expect(app.saved.recipient.agent).toBe("plan")
})

for (const action of ["compact", "agent"] as const) {
  test(`${action} rejects known task ownership both on open and before submission`, async () => {
    const app = await fixture()
    app.remote.blocked = true
    app.controls[action]()
    expect(app.state.modal).toBeUndefined()
    expect(app.requests).toEqual([])
    expect(app.notices.at(-1)).toContain("Task-owned")
    app.remote.blocked = false
    app.controls[action]()
    if (action === "agent") await app.waitFor((frame) => frame.includes("Up/Down choose"))
    app.remote.blocked = true
    app.submit()
    await app.waitFor((frame) => frame.includes("Task-owned"))
    expect(app.requests.every((request) => request.method === "GET")).toBe(true)
  })
  for (const failure of ["lookup", "identity", "directory", "workspace"] as const) {
    test(`${action} requires exact validated GET (${failure})`, async () => {
      const app = await fixture()
      app.controls[action]()
      if (action === "agent") {
        await app.waitFor((frame) => frame.includes("Up/Down choose"))
        await app.view.mockInput.typeText("plan")
      }
      if (failure === "lookup") app.remote.lookupError = true
      if (failure === "identity") app.remote.session = { ...app.remote.session, id: "ses_wrong" }
      if (failure === "directory") app.remote.session = { ...app.remote.session, location: { directory: "/srv/wrong" } }
      if (failure === "workspace")
        app.remote.session = {
          ...app.remote.session,
          location: { ...app.remote.session.location, workspaceID: "wrong" },
        }
      app.submit()
      await app.waitFor((frame) => frame.includes("Ctrl+S retry"))
      expect(app.requests.every((request) => request.method === "GET")).toBe(true)
      expect(app.saved.recipient.agent).toBe("build")
      expect(app.state.selected).toBe("ses_controls")
    })
  }
}
