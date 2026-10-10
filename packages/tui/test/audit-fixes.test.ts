import { expect, test } from "bun:test"
import { connect } from "../src/server"
import { assistant, cleanup, dashboard, mount, turen, until, type Route } from "./support"

test("Ctrl+S after a digit answer does not answer the permission that opens next", async () => {
  const answered = new Set<string>()
  const request = (id: string, resource: string) => ({
    id,
    sessionID: "ses_main",
    action: "shell",
    resources: [resource],
  })
  const { server, view, screen } = await dashboard({
    "POST /api/session/ses_main/permission/per_one/reply": () => {
      answered.add("per_one")
      return new Response(null, { status: 204 })
    },
    "POST /api/session/ses_main/permission/per_two/reply": () => new Response(null, { status: 204 }),
    "GET /api/session/ses_main/permission": () => ({
      data: [
        ...(answered.has("per_one") ? [] : [request("per_one", "npm test")]),
        request("per_two", "rm build-output"),
      ],
    }),
  })
  await screen("npm test")
  // Past the guard that keeps a digit typed as the prompt opens from answering it.
  await Bun.sleep(600)
  view.mockInput.pressKey("2")
  await screen("rm build-output", 3000)
  // The user's Ctrl+S meant to confirm the digit they just pressed.
  view.mockInput.pressKey("s", { ctrl: true })
  await Bun.sleep(300)
  expect(server.sent("/api/session/ses_main/permission/per_one/reply").map((item) => item.body)).toEqual([
    { reply: "once" },
  ])
  expect(server.sent("/api/session/ses_main/permission/per_two/reply")).toHaveLength(0)
})

test("Ctrl+S after a failed folder close retries the chosen row, not the typed path", async () => {
  const state = { directories: ["/srv/a", "/srv/b"], revision: 1, fail: true }
  const stored = () => folders(state.directories, state.revision)
  const puts: string[][] = []
  const app = await dashboard({
    "GET /global/storage": () => ({ state: stored() }),
    "PUT /global/storage": async (request) => {
      puts.push(JSON.parse(((await request.json()) as { value: string }).value).directories)
      if (state.fail) {
        state.fail = false
        return new Response("synthetic failure", { status: 500 })
      }
      state.directories = puts.at(-1)!
      state.revision++
      return stored()
    },
  })
  await app.screen("Connected")
  await app.palette("Working folders")
  await app.screen("Working folders")
  await app.view.mockInput.typeText("/srv/b")
  app.view.mockInput.pressKey("r", { ctrl: true })
  await app.screen("Close")
  app.view.mockInput.pressArrow("down")
  await app.screen("▶ /srv/a")
  app.view.mockInput.pressEnter()
  await app.screen("Ctrl+S retry")
  app.view.mockInput.pressKey("s", { ctrl: true })
  await until(() => puts.length >= 2)
  expect(puts).toEqual([["/srv/b"], ["/srv/b"]])
})

test("terminals are read in the shown folder and in every open folder", async () => {
  const open = Array.from({ length: 10 }, (_, index) => `/srv/f${index}`)
  const read: string[] = []
  const server = turen({
    routes: {
      "GET /global/storage": () => ({ state: folders(open, 1) }),
      "GET /api/pty": (_, url) => {
        const directory = url.searchParams.get("location[directory]")!
        read.push(directory)
        return { location: { directory }, data: [] }
      },
    },
  })
  const connection = connect({ url: server.url })
  cleanup.push(connection.close)
  await connection.snapshot({ directory: "/srv/shown" })
  expect(read.toSorted()).toEqual(["/srv/main", "/srv/shown", ...open].toSorted())
})

test("a reconnect reloads the History page the reader is on", async () => {
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const connected = new TextEncoder().encode(
    `data: ${JSON.stringify({ id: "evt_1", type: "server.connected", data: {} })}\n\n`,
  )
  const events: Route = () =>
    new Response(new ReadableStream<Uint8Array>({ start: (controller) => void streams.add(controller) }), {
      headers: { "content-type": "text/event-stream" },
    })
  const pages: Route = (_, url) =>
    url.searchParams.get("cursor") === "older"
      ? { data: [assistant("old", "older page text")], cursor: { previous: "newer" } }
      : { data: [assistant("new", "main says hello")], cursor: { next: "older" } }
  const { view, screen, server } = await mount(
    140,
    { "GET /api/session/ses_main/message": pages, "GET /api/event": events },
    36,
  )
  view.mockInput.pressKey("h")
  await screen("History · page 1")
  await screen("1 messages")
  view.mockInput.pressKey("[")
  await screen("History · page 2")
  await screen("older page text")
  const reads = server.sent("/api/session/ses_main/message").length
  await until(() => streams.size > 0)
  streams.forEach((controller) => controller.enqueue(connected))
  await until(() => server.sent("/api/session/ses_main/message").length > reads)
  await screen("History · page 2")
  await screen("older page text")
})

/** The stored list of open folders, as the server keeps it. */
function folders(directories: string[], revision: number) {
  return {
    scope: "desktop/store/working-folders",
    key: "open",
    value: JSON.stringify({ version: 1, directories }),
    revision,
    timeCreated: 1,
    timeUpdated: 1,
  }
}
