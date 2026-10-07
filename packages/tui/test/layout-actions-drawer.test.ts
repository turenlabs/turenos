import { expect, test } from "bun:test"
import { mountDashboard } from "../src/index"
import { connect } from "../src/server"
import { cleanup, terminal, turen } from "./support"

test.each([60, 80])("the action row keeps its entries while the narrow drawer is open at %i columns", async (width) => {
  const server = turen({ routes: { "GET /api/session/active": () => ({ data: { ses_main: { type: "running" } } }) } })
  const { view, screen } = await terminal(width, 24)
  const app = mountDashboard(view.renderer, connect({ url: server.url }), server.url)
  cleanup.push(app.dispose)
  await app.ready
  await screen("main says hello")
  // The stop entry belongs to the shortcut row; Esc leaves the reply editor first.
  view.mockInput.pressKey("ESCAPE")
  await screen("x Stop")
  view.mockInput.pressKey("b")
  await screen("Sessions")
  await view.renderOnce()
  // The drawer reports its laid-out width only after a pass, so the next resize repaints the row with it.
  view.resize(width, 25)
  await view.renderOnce()
  const frame = await screen("x Stop")
  expect(frame).toContain("h History")
  expect(frame).toContain("i Details")
})
