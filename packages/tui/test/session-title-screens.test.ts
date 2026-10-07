import { expect, test } from "bun:test"
import { agent } from "./agent-fixture"
import { dashboard, session } from "./support"

const raw = "New session - 2026-10-07T17:32:46.744Z"
const untitled = { ...session("main"), title: raw }
const routes = {
  "GET /api/session": () => ({ data: [untitled], cursor: {} }),
  "GET /api/session/ses_main": () => ({ data: untitled }),
}

/** The placeholder reads as a short local time, wherever the session's title is shown. */
function readable(frame: string) {
  expect(frame).toContain("New session · ")
  expect(frame).not.toContain("2026-10-07T17:32:46")
}

test("the header, sidebar and reply editor show the placeholder title as a local time", async () => {
  const { view, screen } = await dashboard(routes)
  readable(await screen("New session · "))
  view.mockInput.pressKey("f")
  const frame = await screen("Reply to New session · ")
  readable(frame)
  expect(frame).toContain("Reply to New session · ")
})

test("the session switcher shows the placeholder title as a local time", async () => {
  const { view, screen } = await dashboard(routes)
  await screen("New session · ")
  view.mockInput.pressKey("k", { ctrl: true })
  readable(await screen("Switch session"))
})

test("the model picker shows the placeholder title as a local time", async () => {
  const { view, screen } = await dashboard(routes)
  await screen("New session · ")
  view.mockInput.pressKey("m")
  readable(await screen("For: New session · "))
})

test("turen-tui sessions still prints the raw title", async () => {
  const { server } = await dashboard(routes)
  const result = await agent(["sessions"], { url: server.url })
  expect(result.stdout).toContain(raw)
})
