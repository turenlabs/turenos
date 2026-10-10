import { expect, test } from "bun:test"
import { refresh } from "../src/dashboard/refresh"
import { mountDashboard } from "../src/index"
import { connect } from "../src/server"
import { cleanup, openSwarmRoom, sized, terminal, turen, until } from "./support"

test("a second Enter while a swarm post is on its way does not post it twice", async () => {
  const answer = Promise.withResolvers<void>()
  const app = await sized(120, 36, {
    "POST /api/session/ses_main/room/entries": async () => {
      await answer.promise
      return new Response(null, { status: 500 })
    },
  })
  const { server, view, screen } = app
  await openSwarmRoom(app)
  await view.mockInput.typeText("ship it")
  view.mockInput.pressEnter()
  await screen("Posting…")
  view.mockInput.pressEnter()
  await Bun.sleep(100)
  answer.resolve()
  await until(() => server.sent("/api/session/ses_main/room/entries").length > 0)
  await Bun.sleep(100)
  expect(server.sent("/api/session/ses_main/room/entries")).toHaveLength(1)
})

test("the Files preview reads only the file the selection rests on", async () => {
  const file = (name: string) => ({ name, path: name, absolute: `/srv/main/${name}`, type: "file", ignored: false })
  const read: string[] = []
  const { view, screen } = await sized(120, 36, {
    "GET /file": () => ["a.md", "b.md", "c.md", "d.md"].map(file),
    "GET /file/content": (_, url) => {
      const path = url.searchParams.get("path")!
      read.push(path)
      return { type: "text", content: `contents of ${path}` }
    },
  })
  view.mockInput.pressKey("e")
  await screen("contents of a.md")
  for (const _ of "bcd") view.mockInput.pressArrow("down")
  await screen("contents of d.md")
  expect(read).toEqual(["a.md", "d.md"])
})

test("a password refusal names the server picker when the dashboard has one", async () => {
  const server = turen({ password: "secret" })
  const { view, screen } = await terminal(120, 36)
  const app = mountDashboard(view.renderer, connect({ url: server.url }), server.url, undefined, {
    server: server.url.replace("http://", ""),
    servers: () => {},
  })
  cleanup.push(app.dispose)
  await app.ready
  await screen("Press s to choose a server and enter its password")
})

test("while the live stream works the snapshot poll slows down", async () => {
  const connected = new TextEncoder().encode(
    `data: ${JSON.stringify({ id: "evt_1", type: "server.connected", data: {} })}\n\n`,
  )
  const { server, screen } = await sized(120, 36, {
    "GET /api/event": () =>
      new Response(new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(connected) }), {
        headers: { "content-type": "text/event-stream" },
      }),
  })
  await screen("Live")
  // Let the snapshot the connection asked for finish, then count the polls that follow.
  await Bun.sleep(500)
  const polls = () => server.sent("/api/session/active").length
  const before = polls()
  await Bun.sleep(4000)
  expect(polls() - before).toBeLessThanOrEqual(1)
}, 15000)

test("no snapshot is read or scheduled while a terminal is attached", async () => {
  const reads: unknown[] = []
  const d = {
    state: { closed: false, attached: true },
    run: { timer: undefined },
    connection: { snapshot: async (folder: unknown) => void reads.push(folder) },
  }
  await refresh(d as never)
  expect(reads).toEqual([])
  // Detaching calls refresh, which starts the poll again; nothing may be left waiting meanwhile.
  expect(d.run.timer).toBeUndefined()
})
