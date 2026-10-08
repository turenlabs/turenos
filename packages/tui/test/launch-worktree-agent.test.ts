import { expect, test } from "bun:test"
import { dashboard, globalEvents, session, until } from "./support"

const agent = (id: string) => ({
  id,
  mode: "primary",
  hidden: false,
  request: { headers: {}, body: {} },
  permissions: [],
})

/** Launches from /srv/main with `planner` selected and Workspace set to a new worktree whose agents are `offered`. */
async function launch(offered: string[]) {
  const events = globalEvents()
  let name = ""
  const app = await dashboard({
    "GET /global/event": events.route,
    "GET /api/agent": (_, url) => {
      const directory = url.searchParams.get("location[directory]") ?? ""
      return {
        location: { directory },
        data: (directory.startsWith("/srv/wt/") ? offered : ["build", "planner"]).map(agent),
      }
    },
    "POST /experimental/worktree": async (request) => {
      name = ((await request.json()) as { name: string }).name
      return { name, directory: `/srv/wt/${name}` }
    },
    "GET /experimental/worktree/status": () =>
      name ? { status: "ready", directory: `/srv/wt/${name}` } : { status: "unknown" },
    "POST /api/session": async (request) => {
      const body = (await request.json()) as Record<string, unknown>
      return { data: { ...session(), id: body.id, location: body.location } }
    },
  })
  const view = app.view
  view.mockInput.pressKey("n")
  await app.screen("What would you like to do?")
  await view.mockInput.typeText("Plan the refactor")
  // Directory, then agent: let discovery finish and pick the second listed agent, planner.
  for (let step = 0; step < 2; step++) {
    view.mockInput.pressTab()
    await view.renderOnce()
  }
  await app.screen("planner")
  view.mockInput.pressArrow("down")
  view.mockInput.pressArrow("down")
  await view.renderOnce()
  for (let step = 0; step < 2; step++) {
    view.mockInput.pressTab()
    await view.renderOnce()
  }
  view.mockInput.pressArrow("down")
  await app.screen("▶ New git worktree")
  view.mockInput.pressKey("s", { ctrl: true })
  return {
    ...app,
    created: () => app.server.requests.find((item) => item.method === "POST" && item.path === "/api/session"),
  }
}

test("the chosen agent survives creating a worktree that still offers it", async () => {
  const { created } = await launch(["build", "planner"])
  await until(() => !!created())
  expect(created()?.body).toMatchObject({
    agent: "planner",
    location: { directory: expect.stringContaining("/srv/wt/") },
  })
})

test("a worktree that does not offer the chosen agent refuses to launch instead of dropping it", async () => {
  const { screen, created, server } = await launch(["build"])
  await screen("planner")
  await screen("not offered in the new worktree")
  await Bun.sleep(100)
  expect(created()).toBeUndefined()
  expect(server.sent("/experimental/worktree")).toHaveLength(1)
})
