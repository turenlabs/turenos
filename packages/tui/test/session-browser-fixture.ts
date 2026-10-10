import { InputRenderable, type KeyEvent } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createDialogs } from "../src/dialogs"
import { createLayout } from "../src/layout"
import { createMenus } from "../src/menus"
import { connect, type Session } from "../src/server"
import { createDashboardState } from "../src/state"
import { cleanup } from "./support"
export { cleanup }

export function session(id: string, title: string, archived?: number): Session {
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

export async function fixture() {
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
