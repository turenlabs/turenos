import { expect, test } from "bun:test"
import { dashboard, until } from "./support"

const loop = {
  id: "loop_1",
  name: "Nightly",
  prompt: "Run the tests",
  location: { directory: "/srv/main" },
  status: "active",
  schedule: { type: "interval", seconds: 3600, timezone: "UTC" },
}

/** An Automations tab whose run-now answer is `answer(admitted)`; `admit` records a run, as a server that took the request would. */
async function runNow(answer: (posts: number, admit: () => void) => Response | unknown) {
  const runs: Record<string, unknown>[] = []
  let posts = 0
  const app = await dashboard({
    "GET /api/loop": () => [loop],
    "GET /api/loop/loop_1/run": () => runs,
    "POST /api/loop/loop_1/run": () =>
      answer(++posts, () =>
        runs.push({
          id: `run_${posts}`,
          loopID: "loop_1",
          status: "running",
          trigger: "manual",
          sessionID: "ses_run",
          time: { created: Date.UTC(2026, 9, 8, 9, 41) },
        }),
      ),
  })
  app.view.mockInput.pressKey("3")
  await app.screen("Enter manage (run now, pause, edit, runs)")
  await app.palette("Manage automation")
  await app.screen("Run now")
  app.view.mockInput.pressEnter()
  return {
    ...app,
    posts: () => app.server.sent("/api/loop/loop_1/run").filter((item) => item.method === "POST").length,
  }
}

const lost = (_: number, admit: () => void) => {
  admit()
  return new Response("gateway timeout", { status: 504 })
}

test("Run now after a lost answer checks the run history instead of starting a second run", async () => {
  const { view, screen, posts } = await runNow(lost)
  await screen("HTTP 504")
  view.mockInput.pressKey("s", { ctrl: true })
  // The run that was found is one key away: the Runs list opens on it.
  await screen("A run started at")
  await screen("1 recent run")
  await screen("running · 2026-10-08 09:41 · manual")
  expect(posts()).toBe(1)
})

test("Run now sends again only after the history showed no new run and the user confirmed", async () => {
  const { view, screen, posts } = await runNow((count) =>
    count === 1 ? new Response("down", { status: 503 }) : { id: "run_2", loopID: "loop_1", status: "claimed" },
  )
  await screen("HTTP 503")
  view.mockInput.pressKey("s", { ctrl: true })
  await screen("No new run was recorded")
  expect(posts()).toBe(1)
  view.mockInput.pressKey("s", { ctrl: true })
  await screen("Started a run.")
  expect(posts()).toBe(2)
})

test("Run now after a definite refusal retries at once, because nothing was admitted", async () => {
  const { view, screen, posts } = await runNow((count) =>
    count === 1 ? Response.json({ _tag: "InvalidRequestError", message: "Loop is busy" }, { status: 400 }) : {},
  )
  await screen("Loop is busy")
  view.mockInput.pressKey("s", { ctrl: true })
  await until(() => posts() === 2)
  await screen("Started a run.")
})
