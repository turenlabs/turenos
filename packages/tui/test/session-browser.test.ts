import { afterEach, expect, test } from "bun:test"
import { InputRenderable, type KeyEvent } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createDialogs } from "../src/dialogs"
import { createLayout } from "../src/layout"
import { createMenus } from "../src/menus"
import { connect, type Session } from "../src/server"
import { createDashboardState } from "../src/state"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

function session(id: string, title: string, archived?: number): Session {
  return {
    id,
    title,
    projectID: "project",
    location: { directory: "/srv/browser project" },
    time: { created: 1, updated: 2, ...(archived === undefined ? {} : { archived }) },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

async function fixture() {
  const recent = Array.from({ length: 100 }, (_, i) => ({
    ...session(`ses_recent${i}`, `Recent record ${i}`),
    time: { created: 1, updated: 1000 - i },
  }))
  const old = session("ses_old", "Forgotten design notes")
  const sessions = new Map([...recent, old].map((item) => [item.id, item]))
  const routes = new Map<string, (request: Request) => Response | Promise<Response>>()
  const calls: { request: Request; path: string; query: Record<string, string>; completed: boolean }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const call = { request, path: url.pathname, query: Object.fromEntries(url.searchParams), completed: false }
      calls.push(call)
      try {
        const route = routes.get(url.pathname)
        if (route) return await route(request)
        if (url.pathname === "/api/location") return Response.json({ directory: "/srv/browser project" })
        if (url.pathname === "/api/session") return Response.json({ data: recent, cursor: { next: "outside-recent" } })
        if (url.pathname === "/api/session/active") return Response.json({ data: {} })
        if (url.pathname === "/api/pty")
          return Response.json({ location: { directory: url.searchParams.get("location[directory]") }, data: [] })
        if (url.pathname === "/api/loop") return Response.json([])
        const current = sessions.get(url.pathname.slice("/api/session/".length))
        return current ? Response.json({ data: current }) : new Response(null, { status: 404 })
      } finally {
        call.completed = true
      }
    },
  })
  cleanup.push(() => server.stop(true))
  const connection = connect({ url: server.url.href })
  cleanup.push(connection.close)
  const view = await createTestRenderer({ width: 100, height: 36, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  const state = createDashboardState()
  state.connected = true
  state.snapshot = await connection.snapshot()
  state.selected = "ses_recent0"
  const ui = createLayout(view.renderer, state)
  view.renderer.once("destroy", () => {
    state.closed = true
  })
  view.renderer.on("resize", ui.resize)
  const notices: string[] = []
  const drafts = new Set<string>()
  const opened: { id: string; inspect?: boolean; session?: Session }[] = []
  const dialogs = createDialogs(view.renderer, state, ui, {
    rememberPosition: () => {},
    cancelPosition: () => {},
    changed: () => ui.resize(),
    submitted: async () => {},
    say: (message) => notices.push(message),
  })
  const menus = createMenus(view.renderer, state, dialogs, connection, {
    launch: () => notices.push("launch"),
    hasDraft: (id) => drafts.has(id),
    say: (message) => notices.push(message),
    openSession: (id, inspect, current) => {
      opened.push({ id, inspect, session: current })
      state.selected = id
      state.inspected = current
    },
  })
  view.renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (ui.sizeNotice.visible) return key.preventDefault()
    dialogs.keypress(key)
  })
  view.renderer.keyInput.on("paste", dialogs.paste)
  function input() {
    const field = state.modal?.fields[0]
    if (!(field instanceof InputRenderable)) throw new Error("Expected the session search input")
    return field
  }
  function query(value: string) {
    input().value = value
    input().emit("input")
  }
  async function wait(predicate: () => boolean) {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      if (!state.closed) await view.renderOnce()
      if (predicate()) return
      await Bun.sleep(5)
    }
    throw new Error(
      `Expected browser state did not arrive:\n${state.closed ? "Renderer closed" : view.captureCharFrame()}`,
    )
  }
  async function screen(text: string) {
    await wait(() => view.captureCharFrame().includes(text))
    return view.captureCharFrame()
  }
  async function click(text: string, lineOffset = 0) {
    const lines = (await screen(text)).split("\n")
    const y = lines.findIndex((line) => line.includes(text))
    await view.mockMouse.click(lines[y]!.indexOf(text) + 1, y + lineOffset)
  }
  function searches() {
    return calls.filter((call) => call.path === "/api/session")
  }
  calls.length = 0
  return {
    menus,
    view,
    state,
    ui,
    calls,
    routes,
    sessions,
    old,
    opened,
    notices,
    drafts,
    input,
    query,
    wait,
    screen,
    click,
    searches,
  }
}

test("Recent starts with mains, searches loaded children by metadata, and keeps selection and draft markers", async () => {
  const app = await fixture()
  const main = session("ses_main", "Main conversation")
  const child = {
    ...session("ses_child", "Investigate rendering"),
    parentID: main.id,
    agent: "auditor",
    location: { directory: "/srv/child-project" },
  }
  app.state.snapshot!.sessions = [main, child]
  app.state.snapshot!.active = { [child.id]: { type: "running" } }
  app.state.selected = child.id
  app.state.previousSession = child.id
  app.drafts.add(child.id)
  app.menus.switcher()
  const recent = await app.screen("Main conversation")
  expect(recent).not.toContain(child.title)
  expect(recent).toContain("Type to include subagents")
  expect(recent).toContain("1/1")
  for (const value of ["rendering", "/srv/child-project", "auditor", "ses_child"]) {
    app.query(value)
    const frame = await app.screen("▶ * Investigate rendering")
    expect(frame).toContain("[child] · current [draft]")
    expect(frame).not.toContain("[task]")
    expect(frame.split("\n").filter((line) => line.includes(child.title))).toHaveLength(1)
    expect(app.input().focused).toBe(true)
  }
  app.query(" ")
  expect(await app.screen("Main conversation")).not.toContain(child.title)
  app.query("ses_")
  // The session on screen leads the list, so the main session the earlier query left selected is the second row.
  await app.screen("▶ Main conversation")
  app.view.mockInput.pressArrow("up")
  await app.screen("▶ * Investigate rendering")
  app.query("ses_ ")
  await app.screen("▶ * Investigate rendering")
  expect(app.calls).toEqual([])
  app.view.mockInput.pressEnter()
  expect(app.opened).toEqual([{ id: child.id, inspect: false, session: child }])
  expect(app.drafts.has(child.id)).toBe(true)
})

test("Recent project headings reuse compact path and workspace disambiguation", async () => {
  const app = await fixture()
  app.state.snapshot!.sessions = [
    { ...session("ses_a", "Alpha main"), location: { directory: "/srv/alpha/project" } },
    { ...session("ses_b", "Beta main"), location: { directory: "/srv/beta/project" } },
    { ...session("ses_c", "Default main"), location: { directory: "/srv/unique" } },
    { ...session("ses_d", "Workspace main"), location: { directory: "/srv/unique", workspaceID: "ws_one" } },
  ]
  app.menus.switcher()
  const frame = await app.screen("Workspace main")
  for (const heading of ["alpha/project", "beta/project", "unique [default]", "unique [ws_one]"])
    expect(frame).toContain(heading)
  // The selected session's own path sits under the list; the headings carry only the compact form.
  expect(frame.split("\n").filter((line) => line.includes("/srv/"))).toEqual([
    expect.stringContaining("/srv/alpha/project"),
  ])
  expect(frame).toContain("1/4")
  expect(app.input().focused).toBe(true)
})

test("Recent with no loaded mains offers child discovery and preserves open by ID", async () => {
  const app = await fixture()
  const child = { ...session("ses_child", "Only loaded child"), parentID: "ses_missing" }
  app.state.snapshot!.sessions = [child]
  app.menus.switcher()
  const frame = await app.screen("No loaded main sessions")
  expect(frame).toContain("Type to include subagents")
  expect(frame).toContain("Tab All")
  expect(frame).toContain("Ctrl+O ID")
  app.view.mockInput.pressEnter()
  expect(app.opened).toEqual([])
  app.query("child")
  expect(await app.screen("Only loaded child")).toContain("[child]")
  expect(app.calls).toEqual([])
  app.query("ses_old")
  app.view.mockInput.pressKey("o", { ctrl: true })
  await app.screen("Open session by ID")
  expect(app.input().value).toBe("ses_old")
  app.view.mockInput.pressEnter()
  await app.wait(() => !app.state.modal)
  expect(app.opened).toEqual([{ id: "ses_old", inspect: false, session: app.old }])
})

test("desktop finder uses available space and exposes selected session details", async () => {
  const app = await fixture()
  app.view.resize(180, 50)
  app.menus.switcher()
  await app.screen("Recent record 0")
  expect(app.state.modal!.frame.width).toBeGreaterThan(96)
  expect(app.state.modal!.frame.height).toBeGreaterThan(32)
  expect(app.view.captureCharFrame()).toContain("/srv/browser project")
  app.view.mockInput.pressKey("END", { ctrl: true })
  await app.screen("ses_recent99")
  expect(app.input().focused).toBe(true)
  app.view.mockInput.pressKey("HOME", { ctrl: true })
  await app.screen("ses_recent0")
  expect(app.opened).toEqual([])
})

test("resized finder masks conversation text outside its frame", async () => {
  const app = await fixture()
  app.ui.renderContent(Array.from({ length: 80 }, () => "BACKGROUND CONVERSATION").join("\n"))
  app.menus.switcher()
  for (const [width, height] of [
    [60, 24],
    [120, 36],
    [60, 24],
  ]) {
    app.view.resize(width!, height!)
    await app.view.renderOnce()
    const frame = app.view.captureCharFrame()
    expect(frame).toContain("Switch session")
    expect(frame).not.toContain("BACKGROUND CONVERSATION")
    expect(app.input().focused).toBe(true)
  }
})

test("All sessions finds an old title outside recent 100 and validates its exact GET before opening", async () => {
  const app = await fixture()
  const snapshot = app.state.snapshot!
  expect(snapshot.sessions).toHaveLength(100)
  expect(snapshot.sessions.some((item) => item.id === app.old.id)).toBe(false)
  app.routes.set("/api/session", () => Response.json({ data: [app.old], cursor: {} }))
  const held = Promise.withResolvers<Response>()
  cleanup.push(() => held.resolve(Response.json({ data: app.old })))
  app.routes.set("/api/session/ses_old", () => held.promise)

  app.menus.switcher()
  expect(await app.screen("[Recent]")).toContain("All sessions")
  app.query("Forgotten design")
  expect(await app.screen("No matching loaded sessions")).toContain("Archived")
  expect(app.calls).toEqual([])
  app.view.mockInput.pressTab()
  await app.screen("Forgotten design notes")
  expect(app.searches().map((call) => call.query)).toEqual([
    { search: "Forgotten design", archived: "false", order: "desc", limit: "100" },
  ])
  expect(app.input().focused).toBe(true)
  expect(app.state.selected).toBe("ses_recent0")
  expect(app.opened).toEqual([])

  app.view.mockInput.pressEnter()
  await app.wait(() => app.calls.some((call) => call.path === "/api/session/ses_old"))
  expect(app.calls.at(-1)?.request.method).toBe("GET")
  expect(app.calls.at(-1)?.query).toEqual({})
  expect(app.state.modal?.busy).toBe(true)
  expect(app.opened).toEqual([])
  const fresh = { ...app.old, title: "Fresh exact session title" }
  held.resolve(Response.json({ data: fresh }))
  await app.wait(() => !app.state.modal)
  expect(app.opened).toEqual([{ id: "ses_old", inspect: false, session: fresh }])
  expect(app.state.snapshot).toBe(snapshot)
  expect(snapshot.sessions).toHaveLength(100)
  expect(snapshot.sessions.some((item) => item.id === "ses_old")).toBe(false)
})

test("scope buttons stay fixed, Tab cycles and Shift+Tab goes back, and Archived avoids redundant row labels", async () => {
  const app = await fixture()
  const archived = [session("ses_zero", "Epoch archive", 0), session("ses_stamp", "Dated archive", 123)]
  app.routes.set("/api/session", (request) =>
    Response.json({
      data: new URL(request.url).searchParams.get("archived") === "true" ? archived : [app.old],
      cursor: {},
    }),
  )
  app.view.resize(60, 24)
  app.menus.switcher()
  await app.screen("[Recent]")
  // The single project has no heading row, so the first page fits and the second one scrolls.
  app.view.mockInput.pressKey("\x1b[6~")
  app.view.mockInput.pressKey("\x1b[6~")
  await app.view.renderOnce()
  expect(app.state.modal!.form.scrollTop).toBeGreaterThan(0)
  expect(app.view.captureCharFrame()).toContain("[Recent]  All sessions  Archived")
  await app.click("All sessions")
  const all = await app.screen("Forgotten design notes")
  expect(all).toContain("[All sessions]")
  expect(all).not.toContain("archived")
  expect(app.searches().at(-1)?.query).toEqual({ archived: "false", order: "desc", limit: "100" })

  app.view.mockInput.pressTab()
  const frame = await app.screen("Epoch archive")
  expect(frame).toContain("[Archived]")
  const lines = frame.split("\n")
  for (const title of ["Epoch archive", "Dated archive"]) {
    expect(lines.find((line) => line.includes(title))).not.toContain("[archived]")
  }
  expect(app.searches().at(-1)?.query).toEqual({ archived: "true", order: "desc", limit: "100" })
  app.query("Epoch")
  await app.wait(() => app.searches().at(-1)?.query.search === "Epoch")
  await app.screen("1/2")
  expect(app.searches().at(-1)?.query).toEqual({ search: "Epoch", archived: "true", order: "desc", limit: "100" })
  app.view.mockInput.pressArrow("down")
  expect(app.input().focused).toBe(true)
  // Tab wraps from Archived to Recent and keeps the search typed so far.
  app.view.mockInput.pressTab()
  await app.screen("[Recent]")
  expect(app.input().focused).toBe(true)
  expect(app.input().value).toBe("Epoch")
  app.query("")
  await app.screen("Recent record 0")
  const count = app.searches().length
  await app.click("Archived")
  await app.screen("Epoch archive")
  expect(app.searches()).toHaveLength(count + 1)
  app.view.mockInput.pressTab({ shift: true })
  await app.screen("[All sessions]")
  expect(app.opened).toEqual([])
})

test("server title input debounces for 250 ms and coalesces edits into one trimmed query", async () => {
  const app = await fixture()
  app.routes.set("/api/session", () => Response.json({ data: [app.old], cursor: {} }))
  app.menus.switcher("all")
  await app.screen("Forgotten design notes")
  expect(app.searches()[0]?.query).toEqual({ archived: "false", order: "desc", limit: "100" })
  const edited = performance.now()
  await app.view.mockInput.typeText("  title +/&?")
  await Bun.sleep(100)
  expect(app.searches()).toHaveLength(1)
  await app.view.mockInput.typeText(" final  ")
  const lastEdit = performance.now()
  await Bun.sleep(100)
  expect(app.searches()).toHaveLength(1)
  await app.wait(() => app.searches().length === 2)
  expect(performance.now() - lastEdit).toBeGreaterThanOrEqual(240)
  expect(performance.now() - edited).toBeGreaterThanOrEqual(340)
  expect(app.searches()[1]?.query).toEqual({
    search: "title +/&? final",
    archived: "false",
    order: "desc",
    limit: "100",
  })
  await app.screen("Forgotten design notes")
  expect(app.input().focused).toBe(true)
})

test("older and newer opaque cursors omit filters and empty boundaries keep visible rows and the way back", async () => {
  const app = await fixture()
  const older = "older+/=&?cursor"
  const newer = "newer+/=&?cursor"
  const first = [session("ses_first", "First remote page"), session("ses_second", "Second remote row")]
  const last = [session("ses_last", "Oldest remote page"), session("ses_target", "Clicked remote target")]
  app.sessions.set("ses_target", last[1]!)
  app.routes.set("/api/session", (request) => {
    const cursor = new URL(request.url).searchParams.get("cursor")
    if (cursor === older) return Response.json({ data: last, cursor: { next: "empty-older", previous: newer } })
    if (cursor?.startsWith("empty")) return Response.json({ data: [], cursor: {} })
    return Response.json({ data: first, cursor: { next: older, previous: "empty-newer" } })
  })
  app.menus.switcher("archived")
  await app.screen("First remote page")
  app.query("remote")
  await app.screen("First remote page")
  expect(app.searches().at(-1)?.query).toEqual({ search: "remote", archived: "true", order: "desc", limit: "100" })
  app.view.mockInput.pressArrow("down")
  await app.screen("▶ Second remote row")
  app.view.mockInput.pressKey("F3", { shift: true })
  const boundary = await app.screen("End of results; current page kept.")
  expect(boundary).toContain("▶ Second remote row")
  expect(boundary).toContain("First remote page")
  expect(app.searches().at(-1)?.query).toEqual({ cursor: "empty-newer", limit: "100" })

  app.view.mockInput.pressKey("F3")
  await app.screen("Oldest remote page")
  expect(app.searches().at(-1)?.query).toEqual({ cursor: older, limit: "100" })
  expect(app.view.captureCharFrame()).not.toContain("First remote page")
  app.view.mockInput.pressKey("F3")
  expect(await app.screen("End of results; current page kept.")).toContain("Clicked remote target")
  expect(app.searches().at(-1)?.query).toEqual({ cursor: "empty-older", limit: "100" })
  app.view.mockInput.pressKey("F3", { shift: true })
  await app.screen("First remote page")
  expect(app.searches().at(-1)?.query).toEqual({ cursor: newer, limit: "100" })
  app.view.mockInput.pressKey("F3")
  await app.screen("▶ Oldest remote page")
  expect(app.input().focused).toBe(true)
  // Click an unselected title, not the keyboard selection.
  await app.click("Clicked remote target")
  await app.wait(() => !app.state.modal)
  expect(app.calls.at(-1)?.path).toBe("/api/session/ses_target")
  expect(app.opened).toEqual([{ id: "ses_target", inspect: false, session: last[1] }])
})

test("a stale title response is aborted and cannot replace the current query's rows", async () => {
  const app = await fixture()
  const held = Promise.withResolvers<Response>()
  const stale = session("ses_stale", "Obsolete query result")
  const current = session("ses_current", "Current query result")
  cleanup.push(() => held.resolve(Response.json({ data: [stale], cursor: {} })))
  app.sessions.set(current.id, current)
  app.routes.set("/api/session", (request) => {
    const search = new URL(request.url).searchParams.get("search")
    if (search === "obsolete") return held.promise
    return Response.json({ data: search === "current" ? [current] : [app.old], cursor: {} })
  })
  app.menus.switcher("all")
  await app.screen("Forgotten design notes")
  app.query("obsolete")
  await app.wait(() => app.searches().some((call) => call.query.search === "obsolete"))
  const request = app.searches().at(-1)!
  app.query("current")
  app.view.mockInput.pressEnter()
  expect(app.opened).toEqual([])
  await app.wait(() => request.request.signal.aborted)
  await app.screen("Current query result")
  held.resolve(Response.json({ data: [stale], cursor: { next: "obsolete-cursor" } }))
  await app.wait(() => request.completed)
  await Bun.sleep(30)
  const frame = await app.screen("Current query result")
  expect(frame).not.toContain("Obsolete query result")
  expect(frame).not.toContain("Retry")
  expect(app.input().value).toBe("current")
  const count = app.searches().length
  app.view.mockInput.pressKey("F3")
  await Bun.sleep(30)
  expect(app.searches()).toHaveLength(count)
  app.view.mockInput.pressEnter()
  await app.wait(() => app.opened.length === 1)
  expect(app.opened[0]?.id).toBe("ses_current")
  expect(app.calls.at(-1)?.path).toBe("/api/session/ses_current")
})

test("Escape aborts an in-flight search and its late response cannot reopen or navigate a replacement picker", async () => {
  const app = await fixture()
  const held = Promise.withResolvers<Response>()
  cleanup.push(() => held.resolve(Response.json({ data: [app.old], cursor: {} })))
  app.routes.set("/api/session", () => held.promise)
  app.menus.switcher("all")
  await app.wait(() => app.searches().length === 1)
  const request = app.searches()[0]!
  const closed = app.state.modal!
  app.view.mockInput.pressEscape()
  expect(app.state.modal).toBeUndefined()
  expect(closed.box.isDestroyed).toBe(true)
  await app.wait(() => request.request.signal.aborted)
  app.menus.switcher()
  const replacement = app.state.modal
  held.resolve(Response.json({ data: [app.old], cursor: {} }))
  await app.wait(() => request.completed)
  await Bun.sleep(30)
  const frame = await app.screen("[Recent]")
  expect(frame).toContain("Recent record 0")
  expect(frame).not.toContain("Forgotten design notes")
  expect(app.state.modal).toBe(replacement)
  expect(app.state.selected).toBe("ses_recent0")
  expect(app.opened).toEqual([])
  app.view.mockInput.pressEscape()
  expect(app.state.modal).toBeUndefined()
  expect(app.calls.every((call) => call.path === "/api/session")).toBe(true)
})

test("cancelled debounce and switching back to Recent do not send a pending title query", async () => {
  const app = await fixture()
  app.routes.set("/api/session", () => Response.json({ data: [app.old], cursor: {} }))
  for (const cancel of ["escape", "recent"] as const) {
    app.menus.switcher("archived")
    await app.screen("Forgotten design notes")
    const count = app.searches().length
    app.query("must not be sent")
    if (cancel === "escape") app.view.mockInput.pressEscape()
    if (cancel === "recent") app.view.mockInput.pressTab()
    await Bun.sleep(300)
    expect(app.searches()).toHaveLength(count)
    expect(app.state.selected).toBe("ses_recent0")
    expect(app.opened).toEqual([])
    if (cancel === "recent") {
      await app.screen("[Recent]")
      app.view.mockInput.pressEscape()
    }
  }
})

for (const failure of ["wrong identity", "malformed session", "404"] as const) {
  test(`an exact GET with ${failure} leaves the picker recoverable without changing selection`, async () => {
    const app = await fixture()
    app.routes.set("/api/session", () => Response.json({ data: [app.old], cursor: {} }))
    app.routes.set("/api/session/ses_old", () =>
      failure === "404"
        ? Response.json(
            { _tag: "SessionNotFoundError", sessionID: "ses_old", message: "Session no longer available" },
            { status: 404 },
          )
        : Response.json({
            data: failure === "wrong identity" ? session("ses_substitute", "Imposter") : { id: "ses_old" },
          }),
    )
    app.menus.switcher("all")
    await app.screen("Forgotten design notes")
    const picker = app.state.modal
    app.view.mockInput.pressEnter()
    const frame = await app.screen(failure === "404" ? "Session no longer available" : "Invalid server response")
    expect(frame).toContain("Forgotten design notes")
    expect(frame).not.toContain("private diagnostic")
    expect(app.state.modal).toBe(picker)
    expect(app.state.modal?.busy).toBe(false)
    expect(app.input().focused).toBe(true)
    expect(app.state.selected).toBe("ses_recent0")
    expect(app.opened).toEqual([])
    app.routes.delete("/api/session/ses_old")
    app.view.mockInput.pressKey("s", { ctrl: true })
    await app.wait(() => !app.state.modal)
    expect(app.calls.filter((call) => call.path === "/api/session/ses_old")).toHaveLength(2)
    expect(app.opened).toEqual([{ id: "ses_old", inspect: false, session: app.old }])
  })
}

test("server search errors offer F3 retry with the same query and archive scope", async () => {
  const app = await fixture()
  app.routes.set("/api/session", () => Response.json({ data: [app.old], cursor: {} }))
  app.menus.switcher("archived")
  await app.screen("Forgotten design notes")
  app.routes.set("/api/session", () => new Response("private server diagnostic", { status: 503 }))
  app.query("retry title")
  const frame = await app.screen("Server returned HTTP 503")
  expect(frame).toContain("F3 Retry")
  expect(frame).not.toContain("private server diagnostic")
  expect(app.state.modal?.busy).toBe(false)
  expect(app.state.selected).toBe("ses_recent0")
  expect(app.opened).toEqual([])
  const failed = app.searches().at(-1)!.query
  const restored = session("ses_restored", "Recovered title", 0)
  app.routes.set("/api/session", () => Response.json({ data: [restored], cursor: {} }))
  app.view.mockInput.pressKey("F3")
  expect(await app.screen("Recovered title")).not.toContain("HTTP 503")
  expect(app.searches().at(-1)?.query).toEqual(failed)
  expect(failed).toEqual({ search: "retry title", archived: "true", order: "desc", limit: "100" })
  expect(app.input().value).toBe("retry title")
  expect(app.input().focused).toBe(true)
})

test("destroying the renderer aborts searches and ignores a late exact-session GET", async () => {
  for (const phase of ["search", "open"] as const) {
    const app = await fixture()
    const held = Promise.withResolvers<Response>()
    cleanup.push(() =>
      held.resolve(Response.json(phase === "search" ? { data: [app.old], cursor: {} } : { data: app.old })),
    )
    app.routes.set("/api/session", () =>
      phase === "search" ? held.promise : Response.json({ data: [app.old], cursor: {} }),
    )
    app.routes.set("/api/session/ses_old", () => held.promise)
    app.menus.switcher("all")
    if (phase === "open") {
      await app.screen("Forgotten design notes")
      app.view.mockInput.pressEnter()
    }
    const path = phase === "search" ? "/api/session" : "/api/session/ses_old"
    await app.wait(() => app.calls.some((call) => call.path === path))
    const request = app.calls.find((call) => call.path === path)!
    app.view.renderer.destroy()
    expect(app.state.closed).toBe(true)
    if (phase === "search") await app.wait(() => request.request.signal.aborted)
    held.resolve(Response.json(phase === "search" ? { data: [app.old], cursor: {} } : { data: app.old }))
    await app.wait(() => request.completed)
    await Bun.sleep(30)
    expect(app.state.selected).toBe("ses_recent0")
    expect(app.opened).toEqual([])
  }
})

test("choosing an open row passes the captured session even if evicted from snapshot by polling", async () => {
  const app = await fixture()
  app.menus.switcher()
  await app.screen("Recent record 0")
  // Simulate polling eviction from snapshot while the switcher remains open
  app.state.snapshot!.sessions = app.state.snapshot!.sessions.filter((s) => s.id !== "ses_recent0")
  app.view.mockInput.pressEnter()
  expect(app.opened).toHaveLength(1)
  expect(app.opened[0]!.id).toBe("ses_recent0")
  expect(app.opened[0]!.session?.id).toBe("ses_recent0")
})
