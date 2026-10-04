import { expect, test } from "bun:test"
import { mountDashboard } from "../src/index"
import { connect } from "../src/server"
import { cleanup, session, terminal, turen, type Route } from "./support"

async function sized(width: number, height: number, routes: Record<string, Route> = {}) {
  const server = turen({ routes })
  const { view, screen } = await terminal(width, height)
  const app = mountDashboard(view.renderer, connect({ url: server.url }), server.url)
  cleanup.push(app.dispose)
  await app.ready
  return { server, view, screen }
}

test("New session shows a Settings heading and marks the focused setting once Tab opens them", async () => {
  const { view, screen } = await sized(120, 36)
  view.mockInput.pressKey("n")
  const closed = await screen("What would you like to do?")
  expect(closed).not.toContain("Settings")
  expect(closed).toContain("▶ What would you like to do?")
  view.mockInput.pressTab()
  const open = await screen("▶ Directory on the server")
  expect(open).toContain("Settings")
  expect(open).not.toContain("▶ What would you like to do?")
  view.mockInput.pressTab()
  expect(await screen("▶ Agent")).not.toContain("▶ Directory")
})

test("the settings stay open when New session reopens after Esc", async () => {
  const { view, screen } = await sized(120, 36)
  view.mockInput.pressKey("n")
  await screen("What would you like to do?")
  view.mockInput.pressTab()
  await screen("Directory on the server")
  view.mockInput.pressKey("ESCAPE")
  await screen("Draft kept")
  view.mockInput.pressKey("n")
  const frame = await screen("What would you like to do?")
  expect(frame).toContain("Settings")
  expect(frame).toContain("Directory on the server")
})

test("a failed send's error goes away once the task is edited", async () => {
  const { view, screen } = await sized(120, 36)
  view.mockInput.pressKey("n")
  await screen("What would you like to do?")
  view.mockInput.pressEnter()
  await screen("Ctrl+S retry")
  await view.mockInput.typeText("fix it")
  await screen("Shift/Alt+Enter newline")
  expect(view.captureCharFrame()).not.toContain("Ctrl+S retry")
})

test("Trace marks a shortened event name with an ellipsis", async () => {
  const { view, screen } = await sized(80, 24, {
    "GET /api/session/ses_main/replay": () => ({
      data: [
        {
          id: "evt_1",
          type: "session.next.step.completed.with.a.very.long.event.name",
          durable: { aggregateID: "ses_main", seq: 7, version: 1 },
          data: {},
        },
      ],
      cursor: {},
    }),
  })
  await screen("main task")
  view.mockInput.pressKey("p", { ctrl: true })
  await view.mockInput.typeText("Session trace")
  view.mockInput.pressEnter()
  const frame = await screen("#7 session.next")
  expect(frame).toMatch(/#7 session\.next[^\n]*…/)
})

test("the permission dialog's hint names the arrow keys, the digits and what Ctrl+S confirms", async () => {
  const { view, screen } = await sized(120, 36, {
    "GET /api/session": () => ({ data: [{ ...session(), status: "running" }], cursor: {} }),
    "GET /api/session/ses_main/permission": () => ({
      data: [
        {
          id: "per_1",
          sessionID: "ses_main",
          action: "bash",
          resources: ["ls"],
          save: [],
          always: [],
          time: { created: 1 },
        },
      ],
    }),
  })
  await screen("main task")
  view.mockInput.pressKey("p")
  const frame = await screen("Permission request")
  expect(frame).toContain("↑↓")
  expect(frame).toContain("Ctrl+S Reject")
})
