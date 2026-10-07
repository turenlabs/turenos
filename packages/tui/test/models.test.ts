import { afterEach, expect, test } from "bun:test"
import { SelectRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createDialogs } from "../src/dialogs"
import { createLayout } from "../src/layout"
import { createModels } from "../src/models"
import { connect, type Session } from "../src/server"
import { createDashboardState } from "../src/state"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function fixture(options: { catalog?: Promise<void>; lookupStatus?: number; lookupID?: string } = {}) {
  const session: Session = {
    id: "ses_model",
    projectID: "project",
    title: "Review models",
    agent: "build",
    location: { directory: "/srv/project" },
    model: { providerID: "test", id: "org/model", variant: "high" },
    time: { created: 1, updated: 2 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  const remote = { session: structuredClone(session) }
  const requests: { method: string; path: string; body?: unknown }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method === "POST" && url.pathname === "/api/session/ses_model/model") {
        const body: { model: Session["model"] } = await request.json()
        requests.push({ method: request.method, path: url.pathname, body })
        remote.session = { ...remote.session, model: body.model }
        return new Response(null, { status: 204 })
      }
      requests.push({ method: request.method, path: url.pathname })
      if (request.method === "GET" && url.pathname === "/api/session/ses_model") {
        if (options.lookupStatus) return new Response(null, { status: options.lookupStatus })
        return Response.json({ data: { ...remote.session, id: options.lookupID ?? remote.session.id } })
      }
      if (request.method === "GET" && url.pathname === "/provider") {
        await options.catalog
        return Response.json({
          all: [
            {
              id: "test",
              name: "Test Provider",
              models: {
                "org/model": { id: "org/model", providerID: "test", name: "Catalog Model" },
                "org/other": { id: "org/other", providerID: "test", name: "Other Model" },
              },
            },
            {
              id: "other",
              name: "Other Provider",
              models: { "org/model": { id: "org/model", providerID: "other", name: "Other Provider Model" } },
            },
          ],
          connected: ["test", "other"],
          default: {},
        })
      }
      return new Response(`Unexpected fixture route: ${request.method} ${url.pathname}`, { status: 404 })
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
  state.snapshot = {
    location: { directory: "/srv/project", project: { id: "project", directory: "/srv/project" } },
    sessions: [session],
    active: {},
    terminals: [],
    terminalsAvailable: true,
    loops: [],
    inventoryErrors: { terminals: "", automations: "" },
    terminalFolderErrors: [],
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
    ui.notice.content = message
    ui.notice.visible = !!message
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
  view.renderer.keyInput.on("paste", dialogs.paste)
  view.renderer.on("resize", ui.resize)
  const saved = { recipient: session }
  const models = createModels(view.renderer, state, connection, dialogs, say, (session) => {
    saved.recipient = session
  })
  async function waitFor(predicate: (frame: string) => boolean) {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      await view.renderOnce()
      if (predicate(view.captureCharFrame())) return view.captureCharFrame()
      await Bun.sleep(5)
    }
    throw new Error(`Expected model picker state did not appear:\n${view.captureCharFrame()}`)
  }
  return { view, state, remote, requests, notices, models, waitFor, saved }
}

test("loading the catalog is read-only and reselecting the same model preserves its explicit variant", async () => {
  const catalog = Promise.withResolvers<void>()
  const app = await fixture({ catalog: catalog.promise })
  app.models.open()
  const loading = await app.waitFor((frame) => frame.includes("Loading models"))
  expect(loading).toContain("Current: test/org/model (variant: high)")
  app.view.mockInput.pressEnter()
  expect(app.remote.session.model?.variant).toBe("high")
  expect(app.state.snapshot?.sessions[0]?.model?.variant).toBe("high")
  expect(app.requests.every((request) => request.method === "GET")).toBe(true)
  catalog.resolve()
  await app.waitFor((frame) => frame.includes("Catalog Model"))
  const select = app.state.modal?.fields.find((field) => field instanceof SelectRenderable)
  expect(select?.options).toHaveLength(3)
  expect(select?.options.find((option) => option.name.startsWith("* "))?.description).toBe(
    "  test/org/model (variant: high) · Test Provider",
  )
  app.view.mockInput.pressEnter()
  app.view.mockInput.pressEnter()
  await app.waitFor(() => !app.state.modal)
  expect(app.requests).toEqual([
    { method: "GET", path: "/provider" },
    { method: "GET", path: "/api/session/ses_model" },
  ])
  expect(app.remote.session.model).toEqual({ providerID: "test", id: "org/model", variant: "high" })
  expect(app.state.snapshot?.sessions[0]?.model).toEqual(app.remote.session.model)
  expect(app.notices.at(-1)).toContain("Model unchanged")
  expect(app.notices.at(-1)).toContain("test/org/model (variant: high)")
  expect(app.notices.at(-1)).toContain("No switch sent")
})

for (const variant of ["xhigh", "default", undefined]) {
  test(`same-model selection preserves the latest exact session variant (${variant}) instead of stale metadata`, async () => {
    const app = await fixture()
    app.state.inspected = app.state.snapshot!.sessions[0]
    app.models.open()
    await app.waitFor((frame) => frame.includes("Catalog Model"))
    app.remote.session = { ...app.remote.session, model: { providerID: "test", id: "org/model", variant } }
    app.view.mockInput.pressEnter()
    await app.waitFor(() => !app.state.modal)
    expect(app.requests.filter((request) => request.method !== "GET")).toEqual([])
    expect(app.requests.at(-1)?.path).toBe("/api/session/ses_model")
    expect(app.remote.session.model?.variant).toBe(variant)
    expect(app.state.snapshot?.sessions[0]?.model?.variant).toBe(variant)
    expect(app.state.inspected?.model?.variant).toBe(variant)
    expect(app.saved.recipient.model?.variant).toBe(variant)
    expect(app.notices.at(-1)).toContain(`variant: ${variant ?? "default"}`)
  })
}

for (const model of [
  { providerID: "test", id: "org/other" },
  { providerID: "other", id: "org/model" },
]) {
  test(`switching to ${model.providerID}/${model.id} resets the variant only for the captured recipient`, async () => {
    const app = await fixture()
    app.state.inspected = app.state.snapshot!.sessions[0]
    app.models.open()
    await app.waitFor((frame) => frame.includes("Catalog Model"))
    await app.view.mockInput.typeText(`${model.providerID}/${model.id}`)
    app.state.selected = "ses_elsewhere"
    app.view.mockInput.pressEnter()
    await app.waitFor(() => !app.state.modal)
    expect(app.requests).toEqual([
      { method: "GET", path: "/provider" },
      { method: "GET", path: "/api/session/ses_model" },
      { method: "POST", path: "/api/session/ses_model/model", body: { model } },
    ])
    expect(app.remote.session.model).toEqual(model)
    expect(app.state.snapshot?.sessions[0]?.model).toEqual(model)
    expect(app.state.inspected?.model).toEqual(model)
    expect(app.saved.recipient.model).toEqual(model)
    expect(app.notices.at(-1)).toContain("Variant reset to model default")
    expect(app.notices.at(-1)).toContain("Applies to subsequent turns")
  })
}

test("reselecting the snapshot model is a real switch if another client has since changed the model", async () => {
  const app = await fixture()
  app.models.open()
  await app.waitFor((frame) => frame.includes("Catalog Model"))
  app.remote.session = { ...app.remote.session, model: { providerID: "test", id: "org/other", variant: "low" } }
  app.view.mockInput.pressEnter()
  await app.waitFor(() => !app.state.modal)
  expect(app.requests.at(-1)).toEqual({
    method: "POST",
    path: "/api/session/ses_model/model",
    body: { model: { providerID: "test", id: "org/model" } },
  })
  expect(app.notices.at(-1)).toContain("Variant reset to model default")
})

for (const options of [{ lookupStatus: 404 }, { lookupID: "ses_wrong" }]) {
  test(`failed exact session lookup prevents switching: ${JSON.stringify(options)}`, async () => {
    const app = await fixture(options)
    app.models.open()
    await app.waitFor((frame) => frame.includes("Catalog Model"))
    await app.view.mockInput.typeText("test/org/other")
    app.view.mockInput.pressEnter()
    await app.waitFor((frame) => frame.includes("Could not select model"))
    expect(app.requests.filter((request) => request.method !== "GET")).toEqual([])
    expect(app.remote.session.model?.variant).toBe("high")
    expect(app.state.modal?.busy).toBe(false)
    // The first Esc clears the filter text; the second leaves.
    app.view.mockInput.pressEscape()
    app.view.mockInput.pressEscape()
    expect(app.state.modal).toBeUndefined()
  })
}

test("the minimum-size picker keeps the current variant readable and draft choices stay local", async () => {
  const app = await fixture()
  app.view.resize(60, 24)
  app.models.open()
  const frame = await app.waitFor((frame) => frame.includes("Catalog Model"))
  expect(frame).toContain("Current: test/org/model (variant: high)")
  app.view.mockInput.pressEscape()
  const choices: string[] = []
  app.models.pick({ directory: "/srv/project", current: "test/org/model", choose: (model) => void choices.push(model) })
  await app.waitFor((frame) => frame.includes("Server default") && frame.includes("Catalog Model"))
  await app.view.mockInput.typeText("test/org/other")
  app.view.mockInput.pressEnter()
  await app.waitFor(() => !app.state.modal)
  expect(choices).toEqual(["test/org/other"])
  expect(app.requests.every((request) => request.method === "GET" && request.path === "/provider")).toBe(true)
  expect(app.remote.session.model?.variant).toBe("high")
})
