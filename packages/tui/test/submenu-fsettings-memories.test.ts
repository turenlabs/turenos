import { afterEach, expect, test } from "bun:test"
import { cleanup, dashboard } from "./support"

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})

const wing = { id: "wng_1", kind: "project", key: "turen", name: "turen", timeCreated: 1, timeUpdated: 1 }
const room = { id: "rom_1", wingID: "wng_1", slug: "tooling", name: "Tooling", timeCreated: 1, timeUpdated: 1 }
const memory = {
  id: "drw_1",
  wingID: "wng_1",
  roomID: "rom_1",
  kind: "decision",
  title: "Use pinned bun",
  body: "Global bun is too old.",
  anchor: {},
  provenance: { assertedBy: "build", source: "agent" },
  timeValidFrom: 1,
  timeCreated: 1,
  timeUpdated: 5,
}

async function fromSettings(routes: Parameters<typeof dashboard>[0]) {
  const app = await dashboard(routes)
  app.view.mockInput.pressKey(",")
  await app.screen("Usage and limits")
  for (let step = 0; step < 3; step++) app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressEnter()
  return app
}

test("Memories opened from Settings names its parent at every level", async () => {
  const app = await fromSettings({
    "GET /api/memory/wing": () => [wing],
    "GET /api/memory/room": () => [room],
    "GET /api/memory": () => [memory],
  })
  await app.screen("Settings › Memories")
  await app.screen("project · turen")
  app.view.mockInput.pressEnter()
  await app.screen("All rooms")
  app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressEnter()
  await app.screen("Settings › Memories › turen › Tooling")
  await app.screen("Global bun is too old.")
})

test("adding, editing and deleting a memory each say what happened", async () => {
  const app = await dashboard({
    "GET /api/memory/wing": () => [wing],
    "GET /api/memory/room": () => [room],
    "GET /api/memory": () => [memory],
    "POST /api/memory": () => ({ ...memory, id: "drw_2" }),
    "DELETE /api/memory/drw_1": () => new Response(null, { status: 204 }),
  })
  await app.palette("Memories")
  await app.screen("project · turen")
  app.view.mockInput.pressEnter()
  await app.screen("All rooms")
  app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressEnter()
  await app.screen("Global bun is too old.")
  app.view.mockInput.pressKey("a")
  await app.screen("New memory")
  await app.view.mockInput.typeText("Run tests alone")
  app.view.mockInput.pressTab()
  await app.confirm("Parallel runs flake.")
  await app.screen("Memory added.")
  app.view.mockInput.pressKey("d", { ctrl: true })
  await app.screen("Ctrl+D again deletes")
  app.view.mockInput.pressKey("d", { ctrl: true })
  await app.screen("Deleted")
  expect(app.server.sent("/api/memory/drw_1").some((item) => item.method === "DELETE")).toBe(true)
})

test("a new personal wing asks for its name before anything is created", async () => {
  const app = await dashboard({
    "GET /api/memory/wing": () => [wing],
    "POST /api/memory/wing": () => ({ ...wing, id: "wng_2", kind: "person", key: "home", name: "Home" }),
    "POST /api/memory/room": () => room,
  })
  await app.palette("Memories")
  await app.screen("+ New personal wing")
  app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressEnter()
  await app.screen("Name")
  expect(app.server.sent("/api/memory/wing").some((item) => item.method === "POST")).toBe(false)
  for (let key = 0; key < "Personal".length; key++) app.view.mockInput.pressBackspace()
  await app.view.mockInput.typeText("Home")
  app.view.mockInput.pressKey("s", { ctrl: true })
  await app.screen("Created wing Home")
  expect(app.server.sent("/api/memory/wing").find((item) => item.method === "POST")?.body).toMatchObject({
    name: "Home",
    kind: "person",
  })
})
