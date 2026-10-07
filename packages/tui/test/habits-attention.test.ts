import { expect, test } from "bun:test"
import { mountDashboard } from "../src/index"
import { connect } from "../src/server"
import { assistant, cleanup, dashboard, session, terminal, turen } from "./support"

const running = (...ids: string[]) => ({
  "GET /api/session/active": () => ({ data: Object.fromEntries(ids.map((id) => [id, { type: "running" }])) }),
})
const pending = (id: string) => ({
  [`GET /api/session/${id}/permission`]: () => ({
    data: [{ id: "per_one", sessionID: id, action: "shell", resources: ["npm test"] }],
  }),
})
const two = {
  "GET /api/session": () => ({
    data: [session("main"), { ...session("other"), time: { created: 1, updated: 1 } }],
    cursor: {},
  }),
}
const BEL = "\x07"
const CLEAR = "\x1b]2;\x07"

/** A dashboard whose bell and title writes are captured instead of reaching the real terminal. */
async function attended(routes: Parameters<typeof dashboard>[0]) {
  const server = turen({ routes })
  const { view, screen } = await terminal()
  const writes: string[] = []
  const app = mountDashboard(view.renderer, connect({ url: server.url }), server.url, undefined, {
    terminal: { write: (text) => void writes.push(text) },
  })
  cleanup.push(app.dispose)
  await app.ready
  return { server, view, screen, writes, app }
}

/** Renders until `check` holds, for states that are the absence of text or a captured write. */
async function waitFor(view: { renderOnce(): Promise<void> }, check: () => boolean) {
  const deadline = Date.now() + 6000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met")
    await view.renderOnce()
    await Bun.sleep(20)
  }
}

test("a running session with a pending permission is marked ? and counted in the header", async () => {
  const { screen } = await dashboard({ ...two, ...running("ses_main", "ses_other"), ...pending("ses_other") })
  const frame = await screen("? other task")
  expect(frame).toContain("* main task")
  expect(frame).toContain("● 2 running · ? 1 need input")
})

test("a 404 from the pending-request routes leaves no mark and does not fail the snapshot", async () => {
  const server = turen({
    routes: {
      ...running("ses_main"),
      "GET /api/session/ses_main/permission": () => new Response(null, { status: 404 }),
      "GET /api/session/ses_main/question": () => new Response(null, { status: 404 }),
    },
  })
  const snapshot = await connect({ url: server.url }).snapshot()
  expect(Object.keys(snapshot.active)).toEqual(["ses_main"])
  expect(snapshot.needsInput).toBeUndefined()
  expect(server.paths()).toContain("/api/session/ses_main/permission")
})

/** `count` running sessions the recent page does not list, each fetched by id. */
const crowd = (count: number) => {
  const ids = Array.from({ length: count }, (_, index) => `ses_s${index}`)
  return {
    ...running(...ids),
    ...Object.fromEntries(ids.map((id) => [`GET /api/session/${id}`, () => ({ data: { ...session(), id } })])),
  }
}
const reads = (server: ReturnType<typeof turen>) => server.paths().filter((path) => path.endsWith("/permission"))

test("pending requests are read for at most eight running sessions", async () => {
  const server = turen({ routes: crowd(10) })
  const snapshot = await connect({ url: server.url }).snapshot()
  expect(reads(server)).toHaveLength(8)
  expect(snapshot.needsInput).toBeUndefined()
})

test("no pending request is read when the active map was cut", async () => {
  const server = turen({ routes: crowd(130) })
  const snapshot = await connect({ url: server.url }).snapshot()
  expect(snapshot.activeOmitted).toBe(2)
  expect(reads(server)).toHaveLength(0)
})

/** The server lists a session's messages newest first; `newer` goes ahead of the failed turn. */
const turn = (newer: unknown[]) => ({
  "GET /api/session/ses_main/message": () => ({
    data: [
      ...newer,
      assistant("one", "partial", { finish: "error", error: { message: "provider exploded" } }),
      { id: "msg_user", type: "user", text: "go", time: { created: 1 } },
    ],
    cursor: {},
  }),
})

test("the header keeps saying the last turn failed, until a newer prompt clears it", async () => {
  const newer: unknown[] = []
  const { view, screen } = await dashboard(turn(newer))
  await screen("! last turn failed")
  newer.push({ id: "msg_next", type: "user", text: "again", time: { created: 3 } })
  await waitFor(view, () => !view.captureCharFrame().includes("! last turn failed"))
})

test("a new permission rings the bell once and puts needs input in the title", async () => {
  const { screen, writes } = await attended({ ...running("ses_main"), ...pending("ses_main") })
  await screen("Allow once")
  expect(writes.filter((text) => text === BEL)).toHaveLength(1)
  expect(writes.some((text) => text.startsWith("\x1b]2;TurenOS · needs input · main task"))).toBe(true)
  await Bun.sleep(300)
  expect(writes.filter((text) => text === BEL)).toHaveLength(1)
})

test("the end of the selected session's turn rings once", async () => {
  const state = { active: true }
  const { view, writes } = await attended({
    "GET /api/session/active": () => ({ data: state.active ? { ses_main: { type: "running" } } : {} }),
  })
  await waitFor(view, () => writes.some((text) => text.includes("TurenOS · working · main task")))
  expect(writes).not.toContain(BEL)
  state.active = false
  await waitFor(view, () => writes.some((text) => text.includes("TurenOS · idle")))
  expect(writes.filter((text) => text === BEL)).toHaveLength(1)
})

test("with attention off nothing is written", async () => {
  process.env.TURENOS_NO_ATTENTION = "1"
  try {
    const { screen, writes, app } = await attended({ ...running("ses_main"), ...pending("ses_main") })
    await screen("Allow once")
    app.dispose()
    expect(writes).toEqual([])
  } finally {
    delete process.env.TURENOS_NO_ATTENTION
  }
})

test("the Appearance toggle turns the alerts off, clearing the title, and dispose clears the title it set", async () => {
  const { view, screen, writes, app } = await attended({})
  await waitFor(view, () => writes.some((text) => text.includes("TurenOS · idle")))
  view.mockInput.pressKey(",")
  await screen("Usage and limits")
  for (let step = 0; step < 7; step++) view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  await screen("Turn attention alerts off")
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  await screen("Turn attention alerts on")
  expect(writes.at(-1)).toBe(CLEAR)
  const count = writes.length
  app.dispose()
  expect(writes).toHaveLength(count)
})

test("dispose clears the title the dashboard set", async () => {
  const { view, writes, app } = await attended({})
  await waitFor(view, () => writes.some((text) => text.includes("TurenOS · idle")))
  app.dispose()
  expect(writes.at(-1)).toBe(CLEAR)
})
