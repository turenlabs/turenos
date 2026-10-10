import { expect, test } from "bun:test"
import { mountDashboard } from "../src/dashboard/mount"
import { connect } from "../src/server"
import { cleanup, session, terminal, turen, type Route } from "./support"

const at = (name: string, directory: string, projectID = "project") => ({
  ...session(name),
  projectID,
  location: { directory },
})

/** A server holding sessions in two folders and in a worktree of the first folder's project. */
function folders(routes: Record<string, Route> = {}) {
  const sessions = [
    at("repo", "/srv/repo"),
    at("tree", "/data/worktree/project/fix"),
    at("other", "/srv/other", "other"),
  ]
  return turen({
    name: "repo",
    routes: {
      "GET /api/location": (_, url) => ({
        directory: url.searchParams.get("location[directory]") ?? "/srv",
        project: { id: "project", directory: "/srv/repo" },
      }),
      "GET /api/fs/list": (_, url) => ({ location: { directory: url.searchParams.get("location[directory]") }, data: [] }),
      "GET /api/session": () => ({ data: sessions, cursor: {} }),
      ...routes,
    },
  })
}

async function start(server: ReturnType<typeof turen>, folder?: string, width = 120) {
  const { view, screen } = await terminal(width, 36)
  const app = mountDashboard(view.renderer, connect({ url: server.url }), server.url, undefined, { folder })
  cleanup.push(app.dispose)
  await app.ready
  return { view, screen, app }
}

test("a dashboard started in a folder lists its sessions and its project's worktrees, and starts new work there", async () => {
  const server = folders()
  const { view, screen } = await start(server, "/srv/repo")
  const frame = await screen("Folder · repo")
  expect(frame).toContain("repo task")
  expect(frame).toContain("tree task")
  expect(frame).not.toContain("other task")
  view.mockInput.pressKey("n", { ctrl: true })
  expect(await screen("Directory: /srv/repo")).toContain("What would you like to do?")
})

test("a start folder the server cannot read shows every folder and says why", async () => {
  const server = folders({ "GET /api/fs/list": () => new Response(null, { status: 404 }) })
  const { screen } = await start(server, "/srv/gone")
  const frame = await screen("is not readable on this server")
  expect(frame).toContain("Showing every folder: /srv/gone")
  expect(frame).toContain("Working folders · all shown")
  expect(frame).toContain("other task")
})

test("a start folder that is not open is marked so in Working folders", async () => {
  const server = folders({ "GET /global/storage": () => ({ state: stored(["/srv/other"]) }) })
  const { view, screen } = await start(server, "/srv/repo")
  await screen("Folder · repo")
  view.mockInput.pressKey("p", { ctrl: true })
  await view.mockInput.typeText("folders")
  view.mockInput.pressEnter()
  const pane = await screen("▶ /srv/repo  · showing  · not open")
  expect(pane).toContain("  /srv/other")
  expect(pane).not.toContain("/srv/other  · not open")
})

test("a refused credential at start drops the folder without calling it unreadable", async () => {
  const server = turen({ name: "repo", password: "right" })
  const { view, screen } = await terminal(120, 36)
  const app = mountDashboard(view.renderer, connect({ url: server.url, password: "wrong" }), server.url, undefined, {
    folder: "/srv/repo",
  })
  cleanup.push(app.dispose)
  await app.ready.catch(() => undefined)
  await screen("TurenOS")
  expect(view.captureCharFrame()).not.toContain("not readable")
})

test("the shown folder's sessions are read by folder and project, not only from the recent page", async () => {
  const older = at("old", "/srv/repo/docs")
  const server = folders({
    "GET /api/session": (_, url) => ({
      data: url.searchParams.get("directory") || url.searchParams.get("project") ? [older] : [at("other", "/srv/other", "other")],
      cursor: {},
    }),
  })
  const { screen } = await start(server, "/srv/repo")
  expect(await screen("old task")).not.toContain("other task")
  const queries = server.requests.filter((item) => item.path === "/api/session")
  expect(queries.length).toBeGreaterThan(1)
})

test("Working folders shows the folder chosen with the arrows and Enter, or with a tap, and All folders again", async () => {
  const server = folders({ "GET /global/storage": () => ({ state: stored(["/srv/repo", "/srv/other"]) }) })
  const { view, screen } = await start(server)
  await screen("Working folders · 2 open")
  view.mockInput.pressKey("p", { ctrl: true })
  await view.mockInput.typeText("folders")
  view.mockInput.pressEnter()
  await screen("▶ All open folders  · showing")
  view.mockInput.pressArrow("down")
  view.mockInput.pressArrow("down")
  await screen("▶ /srv/other")
  view.mockInput.pressEnter()
  const other = await screen("Folder · other")
  expect(other).toContain("other task")
  expect(other).not.toContain("tree task")
  await clickRow(view, "Folder · other")
  await screen("▶ /srv/other  · showing")
  await clickRow(view, "/srv/repo")
  expect(await screen("Folder · repo")).not.toContain("other task")
  await clickRow(view, "Folder · repo")
  await clickRow(view, "All open folders")
  expect(await screen("Working folders · 2 open")).toContain("other task")
  expect(server.requests.some((item) => item.method === "PUT")).toBe(false)
})

function stored(directories: string[]) {
  return {
    scope: "desktop/store/working-folders",
    key: "open",
    value: JSON.stringify({ version: 1, directories }),
    revision: 1,
    timeCreated: 1,
    timeUpdated: 1,
  }
}

/** Clicks the first screen line holding the text, at its first character. */
async function clickRow(view: Awaited<ReturnType<typeof terminal>>["view"], text: string) {
  for (let frame = 0; frame < 100; frame++) {
    await view.renderOnce()
    const lines = view.captureCharFrame().split("\n")
    const y = lines.findIndex((line) => line.includes(text))
    if (y >= 0) {
      await view.mockMouse.click(lines[y]!.indexOf(text), y)
      return view.renderOnce()
    }
    await Bun.sleep(20)
  }
  throw new Error(`No row holds ${JSON.stringify(text)}:\n${view.captureCharFrame()}`)
}
