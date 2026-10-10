import { expect, test } from "bun:test"
import { backspace, dashboard, session, until } from "./support"
import { repeat } from "./panels-audit-fixture"

const loop = {
  id: "loop_1",
  name: "Nightly check",
  prompt: "Run the tests",
  location: { directory: "/srv/main" },
  status: "active",
  schedule: { type: "interval", seconds: 86400, timezone: "UTC" },
}

async function editLoop(item: Record<string, unknown>) {
  const app = await dashboard({
    "GET /api/loop": () => [item],
    "GET /api/loop/loop_1/run": () => [],
    "PATCH /api/loop/loop_1": () => item,
  })
  app.view.mockInput.pressKey("3")
  await app.screen("Nightly check")
  app.view.mockInput.pressKey("E")
  await app.screen("Edit automation")
  return app
}

const patched = (app: Awaited<ReturnType<typeof editLoop>>) =>
  app.server.requests.find((item) => item.method === "PATCH" && item.path === "/api/loop/loop_1")?.body as
    | Record<string, unknown>
    | undefined

test("renaming an event-triggered automation never sends a schedule", async () => {
  const app = await editLoop({
    ...loop,
    schedule: { type: "interval", seconds: 60, timezone: "UTC" },
    eventTrigger: { type: "file-change", paths: ["src"] },
  })
  const frame = await app.screen("edited in the desktop")
  expect(frame).not.toContain("Schedule:")
  await app.confirm(" two")
  await app.screen("Automation saved.")
  expect(patched(app)).toMatchObject({ name: "Nightly check two" })
  expect(Object.keys(patched(app)!)).not.toContain("intervalSeconds")
  expect(Object.keys(patched(app)!)).not.toContain("cronExpression")
})

test("a name-only edit leaves the schedule alone and a changed schedule is sent", async () => {
  const app = await editLoop(loop)
  await app.confirm(" two")
  await app.screen("Automation saved.")
  expect(patched(app)).toMatchObject({ name: "Nightly check two" })
  expect(Object.keys(patched(app)!)).not.toContain("intervalSeconds")

  const changed = await editLoop(loop)
  changed.view.mockInput.pressTab()
  changed.view.mockInput.pressTab()
  for (let step = 0; step < 8; step++) backspace(changed.view)
  await changed.confirm("every 2h")
  await changed.screen("Automation saved.")
  expect(patched(changed)).toMatchObject({ intervalSeconds: 7200 })
})

test("an interval too long to count in seconds is refused with a reason", async () => {
  const app = await editLoop(loop)
  app.view.mockInput.pressTab()
  app.view.mockInput.pressTab()
  for (let step = 0; step < 8; step++) backspace(app.view)
  await app.confirm("every 999999999999999999d")
  await app.screen("That interval is too long.")
  expect(patched(app)).toBeUndefined()
})

test("a prefilled automation prompt cannot carry terminal control sequences", async () => {
  const app = await editLoop({ ...loop, prompt: "Run\u001b]0;pwned\u0007 the tests" })
  const frame = await app.screen("Run")
  expect(frame).not.toContain("\u001b")
  expect(frame).toContain("Run]0;pwned the tests")
})

test("Ctrl+D on a live run needs a second press inside the window and ignores key repeat", async () => {
  const app = await dashboard({
    "GET /api/loop": () => [loop],
    "GET /api/loop/loop_1/run": () => [{ id: "run_1", loopID: "loop_1", status: "running", time: { created: 1 } }],
    "POST /api/loop/loop_1/run/run_1/cancel": () => ({ id: "run_1", loopID: "loop_1", status: "cancelled" }),
  })
  app.view.mockInput.pressKey("3")
  await app.screen("Nightly check")
  await app.palette("Manage automation")
  await app.screen("Runs")
  app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressEnter()
  await app.screen("1 recent run")
  const cancels = () => app.server.requests.filter((item) => item.path.endsWith("/cancel")).length
  app.view.mockInput.pressKey("d", { ctrl: true })
  await app.screen("Ctrl+D again cancels this run.")
  // A repeat event is the held key, not a second press.
  app.view.renderer.keyInput.emit("keypress", repeat())
  await Bun.sleep(100)
  expect(cancels()).toBe(0)
  const realNow = Date.now
  Date.now = () => realNow() + 3000
  try {
    app.view.mockInput.pressKey("d", { ctrl: true })
    await Bun.sleep(100)
  } finally {
    Date.now = realNow
  }
  expect(cancels()).toBe(0)
  app.view.mockInput.pressKey("d", { ctrl: true })
  await until(() => cancels() === 1)
})

test("more than 128 running sessions leaves the dashboard connected", async () => {
  const routes: Parameters<typeof dashboard>[0] = {
    "GET /api/session/active": () => ({
      data: Object.fromEntries(Array.from({ length: 130 }, (_, i) => [`ses_r${i}`, { type: "running" }])),
    }),
  }
  for (let i = 0; i < 130; i++) routes[`GET /api/session/ses_r${i}`] = () => ({ data: session(`r${i}`) })
  const app = await dashboard(routes)
  const frame = await app.screen("128+ running")
  expect(frame).not.toContain("Could not connect")
})

test("permission checks the server does not report read as unknown and cannot be toggled", async () => {
  const app = await dashboard({
    "GET /global/permission-checks": () => ({}),
    "GET /api/permission/saved": () => ({ data: [] }),
    "PUT /global/permission-checks": () => ({ enforced: true }),
  })
  app.view.mockInput.pressKey(",")
  await app.screen("Usage and limits")
  for (let step = 0; step < 5; step++) app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressEnter()
  const frame = await app.screen("Permission checks: unknown")
  expect(frame).not.toContain("Tools act without asking")
  app.view.mockInput.pressEnter()
  await app.screen("Permission checks: unknown")
  expect(app.server.requests.some((item) => item.method === "PUT")).toBe(false)
})

test("a title over 200 characters is cut to the field and says so", async () => {
  const long = `${"t".repeat(190)} ${"u".repeat(100)}`
  const app = await dashboard({
    "GET /api/session": () => ({ data: [{ ...session(), title: long }], cursor: {} }),
  })
  await app.screen("t".repeat(20))
  await app.palette("Rename session")
  const frame = await app.screen("The title was shortened to 200 characters.")
  expect(frame).toContain("Rename session")
})
