import { expect, test } from "bun:test"
import { parseSchedule } from "../src/automations"
import { dashboard, session } from "./support"

test("editing an automation keeps the time zone its cron expression was created in", () => {
  const schedule = { type: "cron" as const, seconds: 0, expression: "0 9 * * MON-FRI", timezone: "Asia/Tokyo" }
  expect(parseSchedule("0 9 * * MON-FRI", schedule)).toEqual({
    cronExpression: "0 9 * * mon-fri",
    timezone: "Asia/Tokyo",
  })
  expect(parseSchedule("0 10 * * mon-fri", schedule)?.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
  expect(parseSchedule("every 2h", schedule)).toEqual({ intervalSeconds: 7200 })
})

test("a run's session fetched for opening is not opened once the user moved on", async () => {
  const loop = {
    id: "loop_1",
    name: "Nightly check",
    prompt: "Run the tests",
    location: { directory: "/srv/main" },
    status: "active",
    schedule: { type: "interval", seconds: 3600, timezone: "UTC" },
  }
  const { view, screen, palette } = await dashboard({
    "GET /api/loop": () => [loop],
    "GET /api/loop/loop_1/run": () => [
      {
        id: "run_1",
        loopID: "loop_1",
        status: "succeeded",
        trigger: "manual",
        sessionID: "ses_run",
        time: { created: 1, updated: 1 },
      },
    ],
    "GET /api/session/ses_run": () => Bun.sleep(600).then(() => ({ data: session("run") })),
  })
  view.mockInput.pressKey("3")
  await screen("Enter manage (run now, pause, edit, runs)")
  await palette("Manage automation")
  await screen("Runs")
  view.mockInput.pressArrow("down")
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  await screen("1 recent run")
  view.mockInput.pressEnter()
  // Back to the sessions tab while the run's session is still being fetched.
  view.mockInput.pressKey("1")
  await screen("main says hello")
  await Bun.sleep(800)
  await view.renderOnce()
  expect(view.captureCharFrame()).not.toContain("run task")
  expect(view.captureCharFrame()).toContain("main says hello")
})

test("automations can be run now and created with a plain-language schedule", async () => {
  const loop = {
    id: "loop_1",
    name: "Nightly check",
    prompt: "Run the tests",
    location: { directory: "/srv/main" },
    status: "active",
    schedule: { type: "interval", seconds: 3600, timezone: "UTC" },
  }
  const { server, view, screen, palette, confirm } = await dashboard({
    "GET /api/loop": () => [loop],
    "GET /api/loop/loop_1/run": () => [],
    "POST /api/loop/loop_1/run": () => ({ id: "run_1", loopID: "loop_1", status: "claimed" }),
    "POST /api/loop": () => ({ ...loop, id: "loop_2" }),
  })
  view.mockInput.pressKey("3")
  await screen("Enter manage (run now, pause, edit, runs)")
  await palette("Manage automation")
  await screen("Run now")
  view.mockInput.pressEnter()
  await screen("Started a run.")
  expect(server.sent("/api/loop/loop_1/run").some((item) => item.method === "POST")).toBe(true)
  view.mockInput.pressKey("a")
  await screen("╭─ New automation")
  await view.mockInput.typeText("Weekly docs")
  view.mockInput.pressTab()
  await confirm("Update the changelog")
  await screen("Automation created.")
  expect(server.requests.find((item) => item.method === "POST" && item.path === "/api/loop")?.body).toMatchObject({
    name: "Weekly docs",
    prompt: "Update the changelog",
    intervalSeconds: 3600,
    location: { directory: "/srv/main" },
  })
})

test("schedules accept intervals and cron expressions", () => {
  expect(parseSchedule("every 15m")).toEqual({ intervalSeconds: 900 })
  expect(parseSchedule("2h")).toEqual({ intervalSeconds: 7200 })
  expect(parseSchedule("every 1 day")).toEqual({ intervalSeconds: 86400 })
  expect(parseSchedule("0 9 * * 1-5")).toMatchObject({ cronExpression: "0 9 * * 1-5" })
  expect(parseSchedule("sometimes")).toBeUndefined()
})

test("enabled extension skills appear as slash commands and run as commands", async () => {
  const { server, view, screen } = await dashboard({
    "GET /api/command": (_, url) => ({
      location: {
        directory: url.searchParams.get("location[directory]"),
        project: { id: "project", directory: "/srv/main" },
      },
      data: [],
    }),
    "GET /extension": () => [
      {
        enabled: true,
        manifest: { contributions: [{ type: "skill", id: "review", name: "Review", description: "Review code" }] },
      },
      {
        enabled: false,
        manifest: { contributions: [{ type: "skill", id: "hidden", name: "Hidden", description: "" }] },
      },
    ],
    "POST /api/session/ses_main/command": async (request) => ({
      data: { id: ((await request.json()) as { id: string }).id, sessionID: "ses_main" },
    }),
  })
  view.mockInput.pressKey("f")
  await screen("Typing")
  await view.mockInput.typeText("/rev")
  const frame = await screen("/review - Skill · Review code")
  expect(frame).not.toContain("/hidden")
  view.mockInput.pressTab()
  await view.mockInput.typeText("src")
  view.mockInput.pressEnter()
  await screen("Reply sent.")
  expect(server.sent("/api/session/ses_main/command")[0]?.body).toMatchObject({ command: "review", arguments: "src" })
})
