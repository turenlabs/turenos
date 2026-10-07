import { afterEach, expect, test } from "bun:test"
import { SelectRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createDialogs } from "../src/dialogs"
import { createLayout } from "../src/layout"
import { createModelVariants } from "../src/model-variants"
import { connect, type Session } from "../src/server"
import { createDashboardState } from "../src/state"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function fixture(
  options: {
    variants?: unknown
    absent?: boolean
    missing?: boolean
    catalogStatus?: number
    width?: number
    height?: number
  } = {},
) {
  const session: Session = {
    id: "ses_variant",
    projectID: "project",
    parentID: "ses_parent",
    subpath: "scope",
    title: "Variant fixture " + "long metadata ".repeat(15),
    agent: "build",
    location: { directory: "/srv/project", workspaceID: "workspace" },
    model: { providerID: "test", id: "org/model", variant: "high" },
    time: { created: 1, updated: 2 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  const remote = {
    session: structuredClone(session),
    owned: false,
    lookupStatus: 0,
    postStatus: 204,
    apply: true,
    verificationFails: false,
  }
  const requests: { method: string; path: string; directory: string | null; body?: unknown }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const entry = { method: request.method, path: url.pathname, directory: url.searchParams.get("directory") }
      if (request.method === "POST" && url.pathname === "/api/session/ses_variant/model") {
        const body: { model: Session["model"] } = await request.json()
        requests.push({ ...entry, body })
        if (remote.apply && remote.postStatus !== 400) remote.session = { ...remote.session, model: body.model }
        if (remote.verificationFails) remote.lookupStatus = 503
        if (remote.postStatus === 400)
          return Response.json({ _tag: "InvalidRequestError", message: "Variant refused" }, { status: 400 })
        return new Response(null, { status: remote.postStatus })
      }
      requests.push(entry)
      if (url.pathname === "/api/session/ses_variant") {
        if (remote.lookupStatus) return new Response(null, { status: remote.lookupStatus })
        return Response.json({ data: remote.session })
      }
      if (url.pathname === "/provider") {
        if (options.catalogStatus) return new Response(null, { status: options.catalogStatus })
        return Response.json({
          all: [
            {
              id: "test",
              name: "Test",
              models: options.missing
                ? {}
                : {
                    "org/model": {
                      id: "org/model",
                      providerID: "test",
                      name: "Fixture model",
                      ...(options.absent
                        ? {}
                        : { variants: options.variants === undefined ? { low: {}, high: {} } : options.variants }),
                    },
                  },
            },
          ],
          connected: ["test"],
          default: {},
        })
      }
      return new Response(null, { status: 404 })
    },
  })
  cleanup.push(() => server.stop(true))
  const connection = connect({ url: server.url.href })
  cleanup.push(connection.close)
  const view = await createTestRenderer({
    width: options.width ?? 100,
    height: options.height ?? 36,
    kittyKeyboard: true,
  })
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
    updated: 2,
    more: false,
  }
  view.renderer.once("destroy", () => {
    state.closed = true
  })
  const ui = createLayout(view.renderer, state)
  const notices: string[] = []
  const updates: Session[] = []
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
  const variants = createModelVariants(
    view.renderer,
    state,
    connection,
    dialogs,
    say,
    (session) => {
      updates.push(session)
    },
    () => remote.owned,
  )
  async function waitFor(predicate: (frame: string) => boolean) {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      await view.renderOnce()
      const frame = view.captureCharFrame()
      if (predicate(frame)) return frame
      await Bun.sleep(5)
    }
    throw new Error(`Variant state did not appear:\n${view.captureCharFrame()}`)
  }
  const ready = () => waitFor((frame) => frame.includes("Up/Down choose"))
  const select = () => state.modal!.fields.find((field) => field instanceof SelectRenderable) as SelectRenderable
  const writes = () => requests.filter((request) => request.method !== "GET")
  return {
    view,
    state,
    remote,
    connection,
    variants,
    dialogs,
    requests,
    updates,
    notices,
    waitFor,
    ready,
    select,
    writes,
  }
}

test("catalog retains only bounded variant names, not bodies; absent metadata stays absent", async () => {
  const app = await fixture({
    variants: { low: { secret: "fixture-private" }, high: { disabled: true, config: "fixture-private" } },
  })
  const catalog = await app.connection.providers.list("/srv/project")
  expect(catalog.models[0]?.variants).toEqual(["low", "high"])
  expect(JSON.stringify(catalog)).not.toContain("fixture-private")
  expect(JSON.stringify(catalog)).not.toContain("disabled")
  const absent = await fixture({ absent: true })
  expect((await absent.connection.providers.list("/srv/project")).models[0]).toEqual({
    providerID: "test",
    id: "org/model",
    name: "Fixture model",
    providerName: "Test",
  })
  const bounded = await fixture({ variants: Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`v${i}`, {}])) })
  expect((await bounded.connection.providers.list("/srv/project")).models[0]?.variants).toHaveLength(128)
})

for (const variants of [
  null,
  [],
  "high",
  { "": {} },
  { " high": {} },
  { "bad\u001b": {} },
  { "a\u202eb": {} },
  { constructor: {} },
  { ["a".repeat(513)]: {} },
  Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`v${i}`, {}])),
]) {
  test(`rejects invalid variant metadata ${JSON.stringify(variants).slice(0, 70)}`, async () => {
    const app = await fixture({ variants })
    await expect(app.connection.providers.list("/srv/project")).rejects.toThrow()
  })
}

test("captured identity and model survive selection changes; acknowledgement is verified with GET", async () => {
  const app = await fixture()
  app.state.inspected = app.state.snapshot!.sessions[0]
  app.variants.open()
  await app.ready()
  app.state.selected = "ses_elsewhere"
  app.view.mockInput.pressArrow("up")
  app.view.mockInput.pressEnter()
  await app.waitFor(() => !app.state.modal)
  expect(app.requests.map((request) => [request.method, request.path])).toEqual([
    ["GET", "/provider"],
    ["GET", "/api/session/ses_variant"],
    ["POST", "/api/session/ses_variant/model"],
    ["GET", "/api/session/ses_variant"],
  ])
  expect(app.requests[0]?.directory).toBe("/srv/project")
  expect(app.writes()[0]?.body).toEqual({ model: { providerID: "test", id: "org/model", variant: "low" } })
  expect(app.updates[0]?.model?.variant).toBe("low")
  expect(app.state.inspected?.model?.variant).toBe("low")
  expect(app.notices.at(-1)).toContain("Variant confirmed")
})

test("a definitely refused variant switch can be retried instead of freezing the choice", async () => {
  const app = await fixture()
  app.variants.open()
  await app.ready()
  app.view.mockInput.pressArrow("up")
  app.remote.postStatus = 400
  app.view.mockInput.pressEnter()
  await app.waitFor((frame) => frame.includes("Rejected by the server"))
  app.remote.postStatus = 204
  app.view.mockInput.pressEnter()
  await app.waitFor(() => !app.state.modal)
  expect(app.writes()).toHaveLength(2)
  expect(app.notices.at(-1)).toContain("Variant confirmed")
})

test("Ctrl+S clears to Model default with no variant member; unchanged choice sends no POST", async () => {
  const app = await fixture()
  app.variants.open()
  await app.ready()
  app.view.mockInput.pressEnter()
  await app.waitFor(() => !app.state.modal)
  expect(app.writes()).toEqual([])
  app.variants.open()
  await app.ready()
  app.view.mockInput.pressArrow("up")
  app.view.mockInput.pressArrow("up")
  app.view.mockInput.pressKey("s", { ctrl: true })
  await app.waitFor(() => !app.state.modal)
  expect(app.writes()[0]?.body).toEqual({ model: { providerID: "test", id: "org/model" } })
  expect(app.remote.session.model?.variant).toBeUndefined()
})

test("60x24 picker labels unadvertised current choice and launch choices are local", async () => {
  const app = await fixture({ width: 60, height: 24 })
  const choices: (string | undefined)[] = []
  let cancelled = 0
  const target = {
    directory: "/srv/project",
    model: { providerID: "test", id: "org/model" },
    current: "custom",
    choose: (variant: string | undefined) => {
      choices.push(variant)
    },
    cancel: () => {
      cancelled++
    },
  }
  app.variants.pick(target)
  const frame = await app.ready()
  expect(frame).toContain("Model default")
  expect(frame).toContain("custom")
  expect(frame).toContain("Ctrl+S select")
  expect(app.state.modal?.save).toBeUndefined()
  app.view.mockInput.pressArrow("up", { ctrl: true })
  app.view.mockInput.pressEnter({ shift: true })
  await app.view.renderOnce()
  expect(choices).toEqual([])
  expect(app.select().getSelectedIndex()).toBe(3)
  app.view.mockInput.pressEnter()
  await app.waitFor((frame) => frame.includes("no longer advertised"))
  app.view.mockInput.pressArrow("up")
  app.view.mockInput.pressEnter()
  await app.waitFor(() => !app.state.modal)
  expect(choices).toEqual(["high"])
  expect(app.requests.every((request) => request.method === "GET" && request.path === "/provider")).toBe(true)
  app.variants.pick(target)
  await app.ready()
  app.view.mockInput.pressEscape()
  expect(cancelled).toBe(1)
})

for (const options of [{ missing: true }, { catalogStatus: 503 }]) {
  test(`unavailable catalog fails closed ${JSON.stringify(options)}`, async () => {
    const app = await fixture(options)
    app.variants.open()
    await app.waitFor((frame) => frame.includes("Cannot load variants"))
    app.view.mockInput.pressEnter()
    await app.waitFor(() => !app.state.modal?.busy)
    expect(app.writes()).toEqual([])
  })
}

for (const change of ["provider", "model", "workspace", "created", "lookup", "owned"]) {
  test(`preflight rejects changed ${change} without mutation`, async () => {
    const app = await fixture()
    app.variants.open()
    await app.ready()
    if (change === "provider")
      app.remote.session = { ...app.remote.session, model: { ...app.remote.session.model!, providerID: "other" } }
    if (change === "model")
      app.remote.session = { ...app.remote.session, model: { ...app.remote.session.model!, id: "other" } }
    if (change === "workspace")
      app.remote.session = { ...app.remote.session, location: { ...app.remote.session.location, workspaceID: "other" } }
    if (change === "created")
      app.remote.session = { ...app.remote.session, time: { ...app.remote.session.time, created: 3 } }
    if (change === "lookup") app.remote.lookupStatus = 404
    if (change === "owned") app.remote.owned = true
    app.view.mockInput.pressArrow("up")
    app.view.mockInput.pressEnter()
    await app.waitFor((frame) => frame.includes("Ctrl+S retry"))
    expect(app.writes()).toEqual([])
    expect(app.updates).toEqual([])
  })
}

for (const apply of [true, false]) {
  test(`ambiguous POST freezes choice and retries GET only (applied=${apply})`, async () => {
    const app = await fixture()
    app.remote.postStatus = 503
    app.remote.apply = apply
    app.variants.open()
    await app.ready()
    app.view.mockInput.pressArrow("up")
    app.view.mockInput.pressEnter()
    await app.waitFor((frame) => frame.includes("Choice frozen"))
    app.view.mockInput.pressArrow("up")
    app.view.mockInput.pressKey("s", { ctrl: true })
    if (apply) await app.waitFor(() => !app.state.modal)
    else await app.waitFor((frame) => frame.includes("Variant not confirmed"))
    expect(app.writes()).toHaveLength(1)
    expect(app.writes()[0]?.body).toEqual({ model: { providerID: "test", id: "org/model", variant: "low" } })
    expect(app.updates).toHaveLength(apply ? 1 : 0)
  })
}

test("failed post-acknowledgement GET does not announce success or resend", async () => {
  const app = await fixture()
  app.remote.verificationFails = true
  app.variants.open()
  await app.ready()
  app.view.mockInput.pressArrow("up")
  app.view.mockInput.pressEnter()
  await app.waitFor((frame) => frame.includes("Ctrl+S retry"))
  expect(app.updates).toEqual([])
  app.remote.lookupStatus = 0
  app.view.mockInput.pressKey("s", { ctrl: true })
  await app.waitFor(() => !app.state.modal)
  expect(app.writes()).toHaveLength(1)
  expect(app.updates[0]?.model?.variant).toBe("low")
})

test("known task ownership and unknown session model block opening without network work", async () => {
  const app = await fixture()
  app.remote.owned = true
  app.variants.open()
  expect(app.state.modal).toBeUndefined()
  expect(app.notices.at(-1)).toContain("Task-owned")
  app.remote.owned = false
  app.state.snapshot!.sessions = app.state.snapshot!.sessions.map((session) => ({ ...session, model: undefined }))
  app.variants.open()
  expect(app.notices.at(-1)).toContain("Press m")
  expect(app.requests).toEqual([])
})

test.each([false, true])("unadvertised current variant is retained only while unchanged (%s)", async (changed) => {
  const app = await fixture({ variants: { low: {} } })
  app.variants.open()
  await app.ready()
  expect(app.view.captureCharFrame()).toContain("current only")
  if (changed)
    app.remote.session = { ...app.remote.session, model: { providerID: "test", id: "org/model", variant: "low" } }
  app.view.mockInput.pressEnter()
  await app.waitFor((frame) => (changed ? frame.includes("no longer current") : !app.state.modal))
  expect(app.writes()).toHaveLength(0)
})

test("new draft cannot choose an unadvertised retained variant and can select default instead", async () => {
  const app = await fixture({ variants: { low: {} } })
  const chosen: (string | undefined)[] = []
  app.variants.pick({
    directory: "/srv/project",
    model: { providerID: "test", id: "org/model" },
    current: "high",
    choose: (variant) => {
      chosen.push(variant)
    },
  })
  await app.ready()
  app.view.mockInput.pressEnter()
  await app.waitFor((frame) => frame.includes("no longer advertised"))
  expect(chosen).toEqual([])
  app.select().setSelectedIndex(0)
  app.view.mockInput.pressEnter()
  await app.waitFor(() => !app.state.modal)
  expect(chosen).toEqual([undefined])
  expect(app.writes()).toHaveLength(0)
})
