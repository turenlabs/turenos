import { expect, test } from "bun:test"
import { dashboard, until } from "./support"
import { repeat } from "./panels-audit-fixture"

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

async function memoriesRoom(routes: Parameters<typeof dashboard>[0], ready = "Global bun is too old.") {
  const app = await dashboard({
    "GET /api/memory/wing": () => [wing],
    "GET /api/memory/room": () => [room],
    "GET /api/memory": () => [memory],
    ...routes,
  })
  await app.palette("Memories")
  await app.screen("project · turen")
  app.view.mockInput.pressEnter()
  await app.screen("All rooms")
  app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressEnter()
  await app.screen(ready)
  return app
}

const deletes = (app: Awaited<ReturnType<typeof memoriesRoom>>) =>
  app.server.requests.filter((item) => item.method === "DELETE").length

test("deleting a memory needs a second Ctrl+D inside the window, not a held key", async () => {
  const app = await memoriesRoom({ "DELETE /api/memory/drw_1": () => new Response(null, { status: 204 }) })
  app.view.mockInput.pressKey("d", { ctrl: true })
  await app.screen("Ctrl+D again deletes")
  app.view.renderer.keyInput.emit("keypress", repeat())
  await Bun.sleep(100)
  expect(deletes(app)).toBe(0)
  const realNow = Date.now
  Date.now = () => realNow() + 3000
  try {
    app.view.mockInput.pressKey("d", { ctrl: true })
    await Bun.sleep(100)
  } finally {
    Date.now = realNow
  }
  expect(deletes(app)).toBe(0)
  app.view.mockInput.pressKey("d", { ctrl: true })
  await until(() => deletes(app) === 1)
})

test("a third Ctrl+D while the delete is in flight sends nothing more", async () => {
  let release = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const app = await memoriesRoom({
    "DELETE /api/memory/drw_1": async () => {
      await gate
      return new Response(null, { status: 204 })
    },
  })
  for (let press = 0; press < 3; press++) app.view.mockInput.pressKey("d", { ctrl: true })
  await until(() => deletes(app) === 1)
  app.view.mockInput.pressKey("d", { ctrl: true })
  await Bun.sleep(100)
  expect(deletes(app)).toBe(1)
  release()
  await app.screen("Deleted")
})

test("a slow refresh cannot repaint a memory deleted since it started", async () => {
  let calls = 0
  let deleted = false
  let release = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const app = await memoriesRoom({
    "GET /api/memory": async () => {
      calls++
      if (calls !== 2) return deleted ? [] : [memory]
      await gate
      return [memory]
    },
    "DELETE /api/memory/drw_1": () => {
      deleted = true
      return new Response(null, { status: 204 })
    },
  })
  app.view.mockInput.pressKey("r", { ctrl: true })
  await until(() => calls === 2)
  app.view.mockInput.pressKey("d", { ctrl: true })
  await app.screen("Ctrl+D again deletes")
  app.view.mockInput.pressKey("d", { ctrl: true })
  await app.screen("No memories here yet")
  release()
  await Bun.sleep(150)
  await app.view.renderOnce()
  expect(app.view.captureCharFrame()).toContain("0 memories")
})

test("Ctrl+S after an uncertain create does not add a second memory, but a refusal may be corrected", async () => {
  let status = 500
  const app = await memoriesRoom({
    "POST /api/memory": () => new Response(JSON.stringify({ message: "nope" }), { status }),
  })
  app.view.mockInput.pressKey("a")
  await app.screen("New memory")
  await app.view.mockInput.typeText("Run tests alone")
  app.view.mockInput.pressTab()
  await app.confirm("Parallel runs flake.")
  const posts = () => app.server.requests.filter((item) => item.method === "POST" && item.path === "/api/memory").length
  await until(() => posts() === 1)
  await Bun.sleep(100)
  app.view.mockInput.pressKey("s", { ctrl: true })
  await app.screen("The memory may already exist")
  expect(posts()).toBe(1)
})

test("a definite refusal of a memory create lets the corrected form be sent again", async () => {
  const app = await memoriesRoom({
    "POST /api/memory": () => Response.json({ _tag: "InvalidRequestError", message: "nope" }, { status: 400 }),
  })
  app.view.mockInput.pressKey("a")
  await app.screen("New memory")
  await app.view.mockInput.typeText("Run tests alone")
  app.view.mockInput.pressTab()
  await app.confirm("Parallel runs flake.")
  const posts = () => app.server.requests.filter((item) => item.method === "POST" && item.path === "/api/memory").length
  await until(() => posts() === 1)
  await Bun.sleep(100)
  app.view.mockInput.pressKey("s", { ctrl: true })
  await until(() => posts() === 2)
})

test("a memory's title, body and source cannot carry terminal control sequences", async () => {
  const osc = "\x1b]0;x\x07"
  const app = await memoriesRoom(
    {
      "GET /api/memory": () => [
        {
          ...memory,
          title: `Title${osc}`,
          body: `Body${osc}`,
          provenance: { assertedBy: "build", source: `src${osc}` },
        },
      ],
    },
    "Body]0;x",
  )
  expect(app.view.captureCharFrame()).not.toContain("\x1b")
  expect(app.view.captureCharFrame()).toContain("src]0;x")
  app.view.mockInput.pressKey("E")
  const frame = await app.screen("Edit memory")
  expect(frame).not.toContain("\x1b")
  expect(frame).toContain("Title]0;x")
})
