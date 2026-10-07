import { afterEach, expect, test } from "bun:test"
import { mountDashboard } from "../src/index"
import { connect } from "../src/server"
import { cleanup, terminal, turen, type Route } from "./support"

afterEach(() => cleanup.splice(0).forEach((fn) => fn()))

const pty = {
  id: "pty_good",
  title: "build shell",
  command: "bash",
  args: [],
  cwd: "/srv/good",
  status: "running",
  pid: 4242,
}

function routes(failure: number): Record<string, Route> {
  return {
    "GET /global/storage": () => ({
      state: {
        scope: "desktop/store/working-folders",
        key: "open",
        value: JSON.stringify({ version: 1, directories: ["/srv/good", "/srv/bad"] }),
        revision: 1,
        timeCreated: 1,
        timeUpdated: 1,
      },
    }),
    "GET /api/pty": (_, url) => {
      const directory = url.searchParams.get("location[directory]")
      if (directory === "/srv/bad") return new Response("broken", { status: failure })
      return { location: { directory }, data: directory === "/srv/good" ? [pty] : [] }
    },
  }
}

for (const failure of [500, 404]) {
  test(`one working folder answering ${failure} keeps the other folder's terminals and is marked`, async () => {
    const server = turen({ routes: routes(failure) })
    const connection = connect({ url: server.url })
    cleanup.push(connection.close)
    const snapshot = await connection.snapshot()
    expect(snapshot.terminals.map((item) => item.id)).toEqual(["pty_good"])
    expect(snapshot.terminalsAvailable).toBe(true)
    expect(snapshot.inventoryErrors.terminals).toBe("")
    expect(snapshot.terminalFolderErrors.map((item) => item.directory)).toEqual(["/srv/bad"])
  })
}

test("the Terminals tab lists the answering folder's terminal and names the failing folder", async () => {
  const server = turen({ routes: routes(500) })
  const { view, screen } = await terminal(120, 36)
  const app = mountDashboard(view.renderer, connect({ url: server.url }), server.url)
  cleanup.push(app.dispose)
  await app.ready
  await screen("Connected")
  view.mockInput.pressKey("2")
  const frame = await screen("build shell")
  expect(frame).not.toContain("Terminal inventory unavailable")
  expect(frame).toContain("/srv/bad")
})
