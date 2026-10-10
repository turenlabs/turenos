import type { Renderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { mountDashboard } from "../src/index"
import { connect } from "../src/server"
import { cleanup } from "./preload"

export { cleanup }

export type Route = (request: Request, url: URL) => unknown

/** Waits up to three seconds for `check` to hold. */
export async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met")
    await Bun.sleep(10)
  }
}

/** A `/global/event` stream route; `emit` sends one server event to every open stream. */
export function globalEvents() {
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const frame = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
  return {
    route: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streams.add(controller)
            controller.enqueue(frame({ payload: { type: "server.connected", properties: {} } }))
          },
          cancel() {
            streams.clear()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    emit: (event: unknown) => streams.forEach((controller) => controller.enqueue(frame(event))),
  }
}

export function session(name = "main") {
  return {
    id: `ses_${name}`,
    projectID: "project",
    title: `${name} task`,
    agent: "build",
    location: { directory: `/srv/${name}` },
    time: { created: 1, updated: 2 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

export function assistant(id: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    id: `msg_${id}`,
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "model" },
    // A finished turn, as servers record it; a test of an unfinished one overrides these.
    time: { created: 1, completed: 2 },
    finish: "stop",
    content: [{ id: `text_${id}`, type: "text", text }],
    ...extra,
  }
}

/**
 * A TurenOS-shaped server with one session, `ses_<name>` in `/srv/<name>`. `routes` answers extra
 * or replaced "METHOD /path" keys. Every request is recorded, so a test proves exactly what was sent.
 */
/** A fake TurenOS server on a loopback port, or on the Unix socket `socket` as a 1.0.44 persistent server listens. */
export function turen(
  options: { name?: string; password?: string; routes?: Record<string, Route>; socket?: string } = {},
) {
  const name = options.name ?? "main"
  const id = `ses_${name}`
  const requests: { method: string; path: string; body?: unknown }[] = []
  const defaults: Record<string, Route> = {
    "GET /global/health": () => ({ healthy: true, version: "1.0.32" }),
    "GET /global/storage": () => ({ state: null }),
    "GET /api/location": () => ({ directory: `/srv/${name}`, project: { id: "project", directory: `/srv/${name}` } }),
    "GET /api/session": () => ({ data: [session(name)], cursor: {} }),
    "GET /api/session/active": () => ({ data: {} }),
    "GET /api/pty": (_, url) => ({ location: { directory: url.searchParams.get("location[directory]") }, data: [] }),
    "GET /api/loop": () => [],
    [`GET /api/session/${id}`]: () => ({ data: session(name) }),
    [`GET /api/session/${id}/message`]: () => ({ data: [assistant(name, `${name} says hello`)], cursor: {} }),
    [`GET /api/session/${id}/task`]: () => ({ data: [], active: [], cursor: {} }),
    [`GET /api/session/${id}/permission`]: () => ({ data: [] }),
    [`GET /api/session/${id}/question`]: () => ({ data: [] }),
    [`GET /api/session/${id}/input`]: () => ({ data: [] }),
  }
  const serve = {
    async fetch(request: Request) {
      const url = new URL(request.url)
      const body = ["GET", "DELETE"].includes(request.method) ? undefined : await request.text()
      requests.push({ method: request.method, path: url.pathname, body: body ? JSON.parse(body) : undefined })
      if (options.password && request.headers.get("authorization") !== `Basic ${btoa(`forge:${options.password}`)}`)
        return new Response(null, { status: 401 })
      const key = `${request.method} ${url.pathname}`
      const route = options.routes?.[key] ?? defaults[key]
      if (!route) return new Response(null, { status: 404 })
      const result = await route(new Request(request.url, { method: request.method, body }), url)
      return result instanceof Response ? result : Response.json(result)
    },
  }
  const listener = options.socket
    ? Bun.serve({ unix: options.socket, ...serve })
    : Bun.serve({ hostname: "127.0.0.1", port: 0, ...serve })
  cleanup.push(() => listener.stop(true))
  return {
    listener,
    url: options.socket ? "http://localhost" : listener.url.origin,
    requests,
    paths: () => requests.map((item) => item.path),
    sent: (path: string) => requests.filter((item) => item.path === path),
  }
}

/**
 * A test renderer plus `screen(text)`, which renders until the text appears or fails with the frame.
 * `ctrlC` leaves Ctrl+C to the dashboard, as the client's own renderer does, instead of destroying it.
 */
export async function terminal(width = 120, height = 36, ctrlC = false) {
  const view = await createTestRenderer({ width, height, ...(ctrlC ? { exitOnCtrlC: false } : {}) })
  cleanup.push(() => view.renderer.destroy())
  async function screen(text: string, timeout = 5000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      await view.renderOnce()
      if (view.captureCharFrame().includes(text)) return view.captureCharFrame()
      await Bun.sleep(20)
    }
    throw new Error(`Expected ${JSON.stringify(text)}:\n${view.captureCharFrame()}`)
  }
  return { view, screen }
}

/** Backspace as terminals send it, DEL. The mock sends 0x08, which is Ctrl+H outside the kitty keyboard protocol. */
export function backspace(view: Awaited<ReturnType<typeof createTestRenderer>>) {
  view.renderer.stdin.emit("data", Buffer.from("\x7f"))
}

/** A dashboard of the given size on a `turen()` server, with a helper for Ctrl+P palette actions. */
export async function sized(width: number, height: number, routes: Record<string, Route> = {}) {
  const server = turen({ routes })
  const { view, screen } = await terminal(width, height)
  const app = mountDashboard(view.renderer, connect({ url: server.url }), server.url)
  cleanup.push(app.dispose)
  await app.ready
  /** Runs a Ctrl+P palette action by name. */
  async function palette(name: string) {
    view.mockInput.pressKey("p", { ctrl: true })
    await view.mockInput.typeText(name)
    view.mockInput.pressEnter()
  }
  return { server, view, screen, palette }
}

/** A `sized` dashboard at the default 120x36, with a helper for typed confirmations. */
export async function dashboard(routes: Record<string, Route>) {
  const app = await sized(120, 36, routes)
  /** Types text and submits the dialog with Ctrl+S. */
  async function confirm(text: string) {
    await app.view.mockInput.typeText(text)
    app.view.mockInput.pressKey("s", { ctrl: true })
  }
  return { ...app, confirm }
}

/** A dashboard whose Ctrl+C is left to it (as the client's renderer does), waiting for `ready` to show. */
export async function mount(
  width: number,
  routes: Record<string, Route> = {},
  height = 24,
  address = "",
  ready = "says hello",
  quit?: () => void,
) {
  const server = turen({ routes })
  const { view, screen } = await terminal(width, height, true)
  const app = mountDashboard(view.renderer, connect({ url: server.url }), server.url, quit, {
    server: address || server.url.replace("http://", ""),
  })
  cleanup.push(app.dispose)
  await app.ready
  await screen(ready)
  return { view, screen, server }
}

/** A frame's lines without the dialog border, its scroll bar and the padding beside them. */
export function frameLines(frame: string) {
  return frame
    .split("\n")
    .map((line) => line.replace(/^\s*│\s?/, "").replace(/\s*(?:[█▀▄])?\s*│\s*$/, "").trimEnd())
}

/** Every renderable below `node`, parents before their children. */
export function descendants(node: Renderable): Renderable[] {
  return node.getChildren().flatMap((child) => [child, ...descendants(child)])
}
