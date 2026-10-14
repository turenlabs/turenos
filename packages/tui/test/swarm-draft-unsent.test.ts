import { expect, test } from "bun:test"
import { connect } from "../src/server"
import { cleanup, openSwarmRoom, terminal, turen, until } from "./support"

async function keepDraft(onQuit = () => {}) {
  const { mountDashboard } = await import("../src/index")
  const server = turen({ routes: {} })
  const app = await terminal(120, 36)
  const { view, screen } = app
  const dashboard = mountDashboard(view.renderer, connect({ url: server.url }), server.url, onQuit)
  cleanup.push(dashboard.dispose)
  await dashboard.ready
  await openSwarmRoom(app as Parameters<typeof openSwarmRoom>[0])
  await view.mockInput.typeText("half a thought")
  await screen("half a thought")
  view.mockInput.pressKey("ESCAPE")
  await until(() => !view.captureCharFrame().includes("Swarm room"))
  await screen("Post draft kept")
  return { dashboard, view }
}

test("a kept swarm post draft counts as an unsent draft", async () => {
  const { dashboard } = await keepDraft()
  expect(dashboard.drafts()).toBe(1)
})

test("quitting with a kept swarm post draft waits for a second press", async () => {
  let quits = 0
  const { view } = await keepDraft(() => quits++)
  view.mockInput.pressKey("q")
  await Bun.sleep(100)
  expect(quits).toBe(0)
  view.mockInput.pressKey("q")
  await until(() => quits === 1)
})
