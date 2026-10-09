import { SelectRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createDialogs } from "../src/dialogs"
import { createLayout } from "../src/layout"
import { createModelVariants } from "../src/model-variants"
import { connect, type Session } from "../src/server"
import { createDashboardState } from "../src/state"
import { cleanup } from "./support"

export async function fixture(
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
    terminalFolderErrors: [],
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
