import { afterEach, expect, test } from "bun:test"
import { InputRenderable, type KeyEvent } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createDialogs } from "../src/dialogs"
import { createLayout } from "../src/layout"
import { connect, type Session } from "../src/server"
import { createSessionActions } from "../src/session-actions"
import { createDashboardState } from "../src/state"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

function session(id = "ses_root"): Session {
  return {
    id,
    title: id === "ses_root" ? "Original title" : id,
    projectID: "project",
    location: { directory: "/srv/original project" },
    time: { created: 1, updated: 2 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

async function fixture(
  options: {
    failOnce?: boolean
    patchStatus?: number
    wrongID?: boolean
    archived?: number
    hold?: Promise<void>
  } = {},
) {
  const sessions = new Map(["ses_root", "ses_parent", "ses_child", "ses_nested"].map((id) => [id, session(id)]))
  sessions.set("ses_root", {
    ...session(),
    parentID: "ses_parent",
    time: { ...session().time, archived: options.archived },
  })
  const calls: {
    path: string
    method: string
    directory: string | null
    body?: { title?: string; time?: { archived: number | null } }
  }[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const address = new URL(request.url)
      const body =
        request.method === "PATCH"
          ? ((await request.json()) as { title?: string; time?: { archived: number | null } })
          : undefined
      calls.push({
        path: address.pathname,
        method: request.method,
        directory: address.searchParams.get("directory"),
        body,
      })
      if (body) {
        await options.hold
        if (options.patchStatus) return new Response("private server diagnostic", { status: options.patchStatus })
        const current = sessions.get(address.pathname.split("/")[2]!)!
        const updated = {
          ...current,
          title: body.title ?? current.title,
          time: { ...current.time, archived: body.time ? (body.time.archived ?? undefined) : current.time.archived },
        }
        sessions.set(current.id, updated)
        if (options.failOnce) {
          options.failOnce = false
          return new Response(null, { status: 502 })
        }
        return Response.json({
          id: updated.id,
          title: updated.title,
          directory: updated.location.directory,
          time: updated.time,
        })
      }
      if (address.pathname === "/api/location") return Response.json({ directory: "/srv/original project" })
      if (address.pathname === "/api/session")
        return Response.json({ data: [...sessions.values()].filter((s) => s.time.archived === undefined), cursor: {} })
      if (address.pathname === "/api/session/active") return Response.json({ data: {} })
      if (address.pathname === "/api/pty")
        return Response.json({ location: { directory: address.searchParams.get("location[directory]") }, data: [] })
      if (address.pathname === "/api/loop") return Response.json([])
      const id = address.pathname.split("/")[3]!
      if (address.pathname.endsWith("/task")) {
        const task = {
          id: "tsk_child",
          rootSessionID: "ses_root",
          parentSessionID: "ses_root",
          childSessionID: "ses_child",
          agent: "review",
          description: "Review code",
          status: "starting",
          depth: 1,
          revision: 1,
          time: { created: 1, updated: 2 },
        }
        return Response.json({
          data: [
            task,
            {
              ...task,
              id: "tsk_nested",
              parentSessionID: "ses_child",
              childSessionID: "ses_nested",
              description: "Nested checks",
              status: "failed",
              error: "Permission denied\u001b\u202e",
            },
          ],
          active: [{ ...task, status: "running" }],
          cursor: { next: "older-tasks" },
        })
      }
      if (address.pathname.endsWith("/message")) return Response.json({ data: [], cursor: {} })
      if (["/permission", "/question", "/input"].some((suffix) => address.pathname.endsWith(suffix)))
        return Response.json({ data: [] })
      if (sessions.has(id)) return Response.json({ data: options.wrongID ? session("ses_wrong") : sessions.get(id) })
      return new Response(null, { status: 404 })
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
  state.selected = "ses_root"
  if (options.archived !== undefined) state.snapshot.sessions.push(sessions.get("ses_root")!)
  state.detail = await connection.detail("ses_root")
  const ui = createLayout(view.renderer, state)
  view.renderer.once("destroy", () => {
    state.closed = true
  })
  view.renderer.on("resize", ui.resize)
  const notices: string[] = []
  const opened: { id: string; inspect?: boolean; session?: Session }[] = []
  const say = (message: string) => {
    notices.push(message)
  }
  const dialogs = createDialogs(view.renderer, state, ui, {
    rememberPosition: () => {},
    cancelPosition: () => {},
    changed: () => {},
    say,
    submitted: async () => {
      state.snapshot = await connection.snapshot()
    },
  })
  view.renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (ui.sizeNotice.visible) {
      key.preventDefault()
      return
    }
    dialogs.keypress(key)
  })
  view.renderer.keyInput.on("paste", dialogs.paste)
  const actions = createSessionActions(view.renderer, state, connection, dialogs, say, (id, inspect, session) => {
    opened.push({ id, inspect, session })
    state.selected = id
    state.inspected = session
  })
  function input() {
    const field = state.modal?.fields[0]
    if (!(field instanceof InputRenderable)) throw new Error("Expected an input field")
    return field
  }
  async function wait(predicate: () => boolean) {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      await view.renderOnce()
      if (predicate()) return
      await Bun.sleep(5)
    }
    throw new Error(`Expected state did not arrive:\n${view.captureCharFrame()}`)
  }
  async function screen(text: string) {
    await wait(() => view.captureCharFrame().includes(text))
    return view.captureCharFrame()
  }
  calls.length = 0
  return { actions, view, state, ui, dialogs, calls, notices, opened, sessions, input, wait, screen }
}

test("rename seeds the title, displays the exact recipient and does not retarget after selection changes", async () => {
  const app = await fixture()
  expect(app.actions.rename()).toBeUndefined()
  expect(app.input().value).toBe("Original title")
  expect(await app.screen("Rename session")).toContain("ses_root")
  expect(app.view.captureCharFrame()).toContain("/srv/original project")
  app.state.selected = "ses_child"
  app.input().value = "New title"
  app.view.mockInput.pressEnter()
  await app.wait(() => !app.state.modal)
  expect(app.calls.filter((call) => call.method === "PATCH")).toEqual([
    { path: "/session/ses_root", method: "PATCH", directory: "/srv/original project", body: { title: "New title" } },
  ])
  expect(app.opened).toEqual([{ id: "ses_root", inspect: false, session: app.sessions.get("ses_root") }])
  expect(app.state.inspected?.title).toBe("New title")
  expect(app.state.snapshot?.sessions.find((s) => s.id === "ses_root")?.title).toBe("New title")
})

test("rename Ctrl+S submits and empty titles fail without leaving the form or sending", async () => {
  const app = await fixture()
  app.actions.rename()
  app.input().value = "   "
  app.view.mockInput.pressKey("s", { ctrl: true })
  await app.screen("Enter a title between 1 and 200")
  expect(app.calls).toEqual([])
  expect(app.state.modal?.busy).toBe(false)
  app.input().value = "Saved title"
  app.view.mockInput.pressKey("s", { ctrl: true })
  await app.wait(() => app.opened.length === 1)
  expect(app.opened[0]?.session?.title).toBe("Saved title")
})

test("archive requires explicit typed confirmation, retries a stable timestamp, unpins and never interrupts", async () => {
  const app = await fixture({ failOnce: true })
  app.state.inspected = app.sessions.get("ses_root")
  app.state.inspection = "ses_root"
  app.state.query = "ses_root"
  app.actions.archive()
  expect(await app.screen("Archive session")).toContain("does not interrupt")
  app.view.mockInput.pressEnter()
  expect(app.calls).toEqual([])
  await app.dialogs.submit()
  await app.screen("Type archive to confirm.")
  expect(app.calls).toEqual([])
  app.input().value = "archive"
  app.view.mockInput.pressEnter()
  expect(app.calls).toEqual([])
  await app.dialogs.submit()
  await app.screen("Server returned HTTP 502")
  const first = app.calls.find((call) => call.method === "PATCH")!.body
  await Bun.sleep(5)
  await app.dialogs.submit()
  expect(app.calls.filter((call) => call.method === "PATCH").map((call) => call.body)).toEqual([first, first])
  expect(app.calls.some((call) => call.path.includes("interrupt"))).toBe(false)
  expect(app.state.inspected).toBeUndefined()
  expect(app.state.inspection).toBe("")
  expect(app.state.query).toBe("")
  expect(app.state.snapshot?.sessions.some((s) => s.id === "ses_root")).toBe(false)
  expect(app.opened).toEqual([])
  expect(app.notices).toContain("Session archived. Running work was not interrupted.")
})

test("archived zero offers restore and sends explicit null before reopening a fresh session", async () => {
  const app = await fixture({ archived: 0 })
  app.actions.archive()
  await app.screen("Restore session")
  app.input().value = "restore"
  app.view.mockInput.pressEnter()
  expect(app.calls).toEqual([])
  await app.dialogs.submit()
  expect(app.calls.find((call) => call.method === "PATCH")?.body).toEqual({ time: { archived: null } })
  expect(app.opened).toEqual([{ id: "ses_root", inspect: false, session: app.sessions.get("ses_root") }])
  expect(app.state.inspected?.time.archived).toBeUndefined()
})

test("task-owned mutation rejection stays visible without changing selection or claiming success", async () => {
  const app = await fixture({ patchStatus: 409 })
  app.actions.archive()
  expect(await app.screen("Archive session")).toContain("Task-owned sessions may reject")
  app.input().value = "archive"
  await app.dialogs.submit()
  const frame = await app.screen("Server returned HTTP 409")
  expect(frame).not.toContain("private server diagnostic")
  expect(app.state.selected).toBe("ses_root")
  expect(app.opened).toEqual([])
  expect(app.state.modal?.busy).toBe(false)
})

test("tasks deduplicate active records, show failures and keep search typing focus through keyboard navigation", async () => {
  const app = await fixture()
  app.actions.tasks()
  const frame = await app.screen("[running] Review code")
  expect(frame).toContain("Root-wide")
  expect(frame).toContain("[failed] Nested checks")
  expect(frame).toContain("Failure: Permission denied")
  expect(frame).toContain("1/2")
  expect(frame).not.toContain("[starting]")
  expect(frame).not.toContain("\u001b")
  expect(app.state.modal?.fields).toHaveLength(1)
  const query = app.input()
  app.view.mockInput.pressTab()
  app.view.mockInput.pressArrow("down")
  expect(query.focused).toBe(true)
  await app.view.mockInput.typeText("j")
  expect(query.value).toBe("j")
  await app.screen("No matching loaded tasks")
  app.view.mockInput.pressEnter()
  expect(app.calls).toEqual([])
  query.value = "failed"
  query.emit("input")
  await app.screen("1/1")
  app.view.mockInput.pressEnter()
  await app.wait(() => app.opened.length === 1)
  expect(app.calls[0]?.path).toBe("/api/session/ses_nested")
  expect(app.opened[0]).toEqual({ id: "ses_nested", inspect: false, session: app.sessions.get("ses_nested") })
})

test("task mouse navigation uses the clicked child and search survives whitespace clicks and minimum-size resize", async () => {
  const app = await fixture()
  app.actions.tasks()
  app.view.resize(60, 24)
  await app.screen("Nested checks")
  const query = app.input()
  const form = app.state.modal!.form
  await app.view.mockMouse.click(form.x + 1, form.y + form.height - 1)
  expect(query.focused).toBe(true)
  app.view.resize(59, 23)
  await app.view.renderOnce()
  app.view.mockInput.pressEnter()
  expect(app.calls).toEqual([])
  app.view.resize(60, 24)
  await app.screen("Nested checks")
  const lines = app.view.captureCharFrame().split("\n")
  const y = lines.findIndex((line) => line.includes("Nested checks"))
  await app.view.mockMouse.click(lines[y]!.indexOf("Nested checks") + 1, y)
  await app.wait(() => app.opened.length === 1)
  expect(app.opened[0]?.id).toBe("ses_nested")
})

test("parent and child navigation reject substituted sessions and preserve the current selection", async () => {
  for (const action of ["parent", "tasks"] as const) {
    const app = await fixture({ wrongID: true })
    app.actions[action]()
    if (action === "tasks") app.view.mockInput.pressEnter()
    await app.screen("Invalid server response (session identity)")
    expect(app.opened).toEqual([])
    expect(app.state.selected).toBe("ses_root")
    expect(app.calls[0]?.path).toBe(action === "parent" ? "/api/session/ses_parent" : "/api/session/ses_child")
  }
})

test("parent opens the captured parent ID and malformed IDs never reach the server", async () => {
  const app = await fixture()
  expect(app.actions.parent()).toBeUndefined()
  app.state.selected = "ses_child"
  await app.wait(() => app.opened.length === 1)
  expect(app.opened[0]).toEqual({ id: "ses_parent", inspect: false, session: app.sessions.get("ses_parent") })
  await app.wait(() => app.calls.some((call) => call.path === "/api/pty"))
  app.state.selected = "ses_root"
  app.state.snapshot!.sessions = [{ ...session(), parentID: "../bad" }]
  const count = app.calls.length
  app.actions.parent()
  await app.screen("Invalid server response (identifier)")
  expect(app.calls).toHaveLength(count)
})

test("busy mutations block edits, closing and duplicate sends", async () => {
  const held = Promise.withResolvers<void>()
  const app = await fixture({ hold: held.promise })
  app.actions.rename()
  app.input().value = "Held title"
  app.view.mockInput.pressEnter()
  await app.wait(() => app.calls.length === 1)
  app.view.mockInput.pressEscape()
  app.view.mockInput.pressEnter()
  await app.view.mockInput.typeText("changed")
  expect(app.state.modal?.busy).toBe(true)
  expect(app.input().value).toBe("Held title")
  held.resolve()
  await app.wait(() => !app.state.modal)
  expect(app.calls.filter((call) => call.method === "PATCH")).toHaveLength(1)
})

test("task paging keeps search focus and rejects malformed child IDs before GET", async () => {
  const app = await fixture()
  const detail = app.state.detail!
  detail.tasks = {
    data: Array.from({ length: 20 }, (_, i) => ({
      ...detail.tasks.data[0]!,
      id: `tsk_${i}`,
      childSessionID: i === 0 ? "../bad" : "ses_child",
      description: `Task number ${i}`,
    })),
    active: [],
    cursor: {},
  }
  app.actions.tasks()
  app.view.resize(60, 24)
  await app.screen("Task number 0")
  app.view.mockInput.pressKey("\x1b[6~")
  await app.view.renderOnce()
  expect(app.input().focused).toBe(true)
  expect(app.state.modal!.form.scrollTop).toBeGreaterThan(0)
  app.input().value = "tsk_0"
  app.input().emit("input")
  await app.screen("1/1")
  app.view.mockInput.pressEnter()
  await app.screen("Invalid server response (identifier)")
  expect(app.calls).toEqual([])
})

test("unavailable session, stale tasks and offline navigation do not send requests", async () => {
  const app = await fixture()
  app.state.selected = "ses_missing"
  app.actions.rename()
  expect(app.notices.at(-1)).toBe("Select an available session first.")
  app.state.selected = "ses_child"
  app.actions.parent()
  expect(app.notices.at(-1)).toBe("This session has no parent session.")
  app.actions.tasks()
  expect(app.notices.at(-1)).toContain("Refresh this session's details")
  app.state.selected = "ses_root"
  app.state.connected = false
  app.actions.parent()
  await app.screen("Reconnect before opening a session.")
  expect(app.calls).toEqual([])
})
