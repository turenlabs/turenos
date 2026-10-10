import { expect, test } from "bun:test"
import { dashboard, globalEvents, session, until, type Route } from "./support"

/** Starts a new session with Workspace set to a new git worktree, against the given worktree routes. */
async function worktreeLaunch(routes: (order: string[]) => Record<string, Route>) {
  const events = globalEvents()
  const order: string[] = []
  const app = await dashboard({
    "GET /global/event": events.route,
    "GET /api/agent": (_, url) => ({
      location: { directory: url.searchParams.get("location[directory]") },
      data: [{ id: "build", mode: "primary", hidden: false, request: { headers: {}, body: {} }, permissions: [] }],
    }),
    "POST /api/session": async (request) => {
      order.push("session")
      const body = (await request.json()) as Record<string, unknown>
      return { data: { ...session(), id: body.id, location: body.location } }
    },
    ...routes(order),
  })
  const view = app.view
  view.mockInput.pressKey("n")
  await app.screen("What would you like to do?")
  await view.mockInput.typeText("Try the refactor")
  // Directory, agent, model, then workspace; each Tab lays out before the next, as in a terminal.
  for (let step = 0; step < 4; step++) {
    view.mockInput.pressTab()
    await view.renderOnce()
  }
  await app.screen("New git worktree")
  view.mockInput.pressArrow("down")
  await app.screen("▶ New git worktree")
  view.mockInput.pressKey("s", { ctrl: true })
  const created = () => app.server.requests.find((item) => item.method === "POST" && item.path === "/api/session")
  return { ...app, order, created }
}

const worktreeName = async (request: Request) => ((await request.json()) as { name: string }).name

test("a new worktree session starts only after authoritative bootstrap readiness", async () => {
  const names: string[] = []
  const { order, created } = await worktreeLaunch((order) => ({
    "POST /experimental/worktree": async (request) => {
      const name = await worktreeName(request)
      names.push(name)
      order.push("created")
      return { name, directory: `/srv/wt/${name}` }
    },
    "GET /experimental/worktree/status": () => {
      if (!names.length) return { status: "unknown" }
      order.push("ready")
      return { status: "ready", directory: `/srv/wt/${names[0]}` }
    },
  }))
  await until(() => !!created())
  expect(order).toEqual(["created", "ready", "session"])
  expect(created()?.body).toMatchObject({ location: { directory: `/srv/wt/${names[0]}` } })
})

test("a failed worktree is reported, and the next try makes a new one", async () => {
  const names: string[] = []
  const { view, screen, created } = await worktreeLaunch(() => ({
    "POST /experimental/worktree": async (request) => {
      const name = await worktreeName(request)
      names.push(name)
      return { name, directory: `/srv/wt/${name}` }
    },
    "GET /experimental/worktree/status": (_, url) =>
      names.includes(url.searchParams.get("name") ?? "")
        ? { status: "failed", message: "checkout failed" }
        : { status: "unknown" },
  }))
  await screen("could not prepare the worktree: checkout failed")
  view.mockInput.pressKey("s", { ctrl: true })
  await until(() => names.length === 2)
  expect(names[1]).not.toBe(names[0])
  expect(created()).toBeUndefined()
})

test("Escape stops waiting for pending worktree readiness without launching", async () => {
  let posted = false
  const { view, screen, created, server } = await worktreeLaunch(() => ({
    "GET /experimental/worktree/status": () => ({ status: posted ? "pending" : "unknown" }),
    "POST /experimental/worktree": async (request) => {
      posted = true
      return { name: await worktreeName(request), directory: "/srv/wt/pending" }
    },
  }))
  await until(() => posted)
  await screen("Esc stops waiting")
  view.mockInput.pressEscape()
  await screen("Stopped waiting for the worktree")
  expect(created()).toBeUndefined()
  expect(server.requests.filter((item) => item.method === "POST")).toHaveLength(1)
  expect(view.captureCharFrame()).toContain("Esc keep draft")
})

test("preflight failure keeps a fresh creation safe to retry", async () => {
  let reads = 0
  let name = ""
  const { view, screen, created, server } = await worktreeLaunch(() => ({
    "GET /experimental/worktree/status": () => {
      if (++reads === 1) return new Response("offline", { status: 503 })
      return name ? { status: "ready", directory: `/srv/wt/${name}` } : { status: "unknown" }
    },
    "POST /experimental/worktree": async (request) => {
      name = await worktreeName(request)
      return { name, directory: `/srv/wt/${name}` }
    },
  }))
  await screen("Worktree creation has not started")
  expect(server.requests.filter((item) => item.method === "POST")).toHaveLength(0)
  view.mockInput.pressKey("s", { ctrl: true })
  await until(() => !!created())
  expect(server.sent("/experimental/worktree")).toHaveLength(1)
})

test("after an uncertain worktree request, a retry reuses its authoritative outcome", async () => {
  const names: string[] = []
  const { view, screen, created } = await worktreeLaunch(() => ({
    "POST /experimental/worktree": async (request) => {
      names.push(await worktreeName(request))
      return new Response("upstream reset", { status: 502 })
    },
    "GET /experimental/worktree/status": () =>
      names.length ? { status: "ready", directory: `/srv/wt/${names[0]}` } : { status: "unknown" },
  }))
  await screen("Server returned HTTP 502")
  view.mockInput.pressKey("s", { ctrl: true })
  await until(() => !!created())
  expect(names).toHaveLength(1)
  expect(created()?.body).toMatchObject({ location: { directory: `/srv/wt/${names[0]}` } })
})
