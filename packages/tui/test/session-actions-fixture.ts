import { InputRenderable, type KeyEvent } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createDialogs } from "../src/dialogs"
import { createLayout } from "../src/layout"
import { connect, type Session } from "../src/server"
import { createSessionActions } from "../src/session-actions"
import { createDashboardState } from "../src/state"
import { cleanup } from "./support"

export function session(id = "ses_root"): Session {
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

export async function fixture(
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
