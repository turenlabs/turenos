import { InputRenderable, type KeyEvent } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createDialogs } from "../src/dialogs"
import { createLayout } from "../src/layout"
import { createModelConnections } from "../src/model-connections"
import { createProviders, type AuthMethod } from "../src/providers"
import { connect } from "../src/server"
import { createDashboardState } from "../src/state"
import { cleanup } from "./support"
export { cleanup }

export async function fixture(
  options: {
    methods?: AuthMethod[]
    authMissing?: boolean
    mode?: "auto" | "code"
    callback?: Promise<void>
    failConfig?: boolean
    failAuth?: boolean
    failCatalogAfterSave?: boolean
  } = {},
) {
  const requests: { path: string; method: string; directory: string | null; body?: unknown }[] = []
  let saved = false
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      requests.push({
        path: url.pathname,
        method: request.method,
        directory: url.searchParams.get("directory"),
        body: request.method === "GET" ? undefined : await request.json(),
      })
      if (url.pathname === "/provider") {
        if (saved && options.failCatalogAfterSave) return new Response(null, { status: 503 })
        return Response.json({ all: [{ id: "test", name: "Test Provider", models: {} }], connected: [] })
      }
      if (url.pathname === "/provider/auth")
        return Response.json(
          options.authMissing ? {} : { test: options.methods ?? [{ type: "api", label: "Use API key" }] },
        )
      if (url.pathname === "/provider/test/oauth/authorize")
        return Response.json({
          url: "https://auth.example.test/device?state=fixture-state",
          instructions: "Use device code TEST-1234 in your browser.",
          method: options.mode ?? "auto",
        })
      if (url.pathname === "/provider/test/oauth/callback") {
        await options.callback
        saved = true
        return Response.json(true)
      }
      if (url.pathname.startsWith("/auth/")) {
        if (options.failAuth) return new Response("fixture-key-do-not-display", { status: 401 })
        saved = true
        return Response.json(true)
      }
      if (url.pathname === "/global/config") {
        if (request.method === "GET") return Response.json({})
        if (options.failConfig) return new Response("fixture-key-do-not-display", { status: 500 })
        saved = true
        return new Response("full config with fixture-key-do-not-display")
      }
      return new Response("Unexpected route", { status: 404 })
    },
  })
  cleanup.push(() => server.stop(true))
  const controller = new AbortController()
  const connection = Object.assign(connect({ url: server.url.href }), {
    address: server.url.origin,
    providers: createProviders({ url: server.url, headers: new Headers(), signal: controller.signal }),
  })
  cleanup.push(connection.close, () => controller.abort())
  const view = await createTestRenderer({ width: 100, height: 36, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  const state = createDashboardState()
  view.renderer.once("destroy", () => {
    state.closed = true
  })
  const ui = createLayout(view.renderer, state)
  const notices: { message: string; error?: boolean }[] = []
  const say = (message: string, error?: boolean) => {
    notices.push({ message, error })
  }
  let submissions = 0
  const dialogs = createDialogs(view.renderer, state, ui, {
    rememberPosition: () => {},
    cancelPosition: () => {},
    changed: () => {},
    submitted: async () => {
      submissions++
    },
    say,
  })
  view.renderer.keyInput.on("keypress", (key: KeyEvent) => dialogs.keypress(key))
  view.renderer.keyInput.on("paste", dialogs.paste)
  const connections = createModelConnections(view.renderer, state, connection, dialogs, say)
  let returns = 0
  const open = () =>
    connections.open("/srv/original directory", () => {
      returns++
      dialogs.open("Model picker")
    })
  async function screen(text: string) {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      await view.renderOnce()
      if (view.captureCharFrame().includes(text)) return view.captureCharFrame()
      await Bun.sleep(5)
    }
    throw new Error(`Missing ${text}:\n${view.captureCharFrame()}`)
  }
  async function provider() {
    open()
    await screen("Connect a provider")
    await view.mockInput.typeText("test")
    view.mockInput.pressEnter()
    await screen("Connect Test Provider")
  }
  function input(index = 0) {
    const field = state.modal?.fields.at(index)
    if (!(field instanceof InputRenderable)) throw new Error("Expected input")
    return field
  }
  return {
    view,
    state,
    dialogs,
    connection,
    requests,
    notices,
    open,
    screen,
    provider,
    input,
    returns: () => returns,
    submissions: () => submissions,
  }
}
