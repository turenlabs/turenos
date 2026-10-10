import { expect, test } from "bun:test"
import { mountDashboard } from "../src/index"
import { connect } from "../src/server"
import { cleanup, terminal, turen } from "./support"

test("disposing a dashboard releases the renderer listeners its markdown registered", async () => {
  const server = turen({})
  const { view } = await terminal()
  const baseline = view.renderer.listenerCount("destroy")
  const first = mountDashboard(view.renderer, connect({ url: server.url }), server.url)
  cleanup.push(first.dispose)
  await first.ready
  // A server switch mounts the next dashboard before disposing this one.
  const second = mountDashboard(view.renderer, connect({ url: server.url }), server.url)
  cleanup.push(second.dispose)
  await second.ready
  const both = view.renderer.listenerCount("destroy")
  first.dispose()
  expect(view.renderer.listenerCount("destroy")).toBeLessThan(both)
  second.dispose()
  expect(view.renderer.listenerCount("destroy")).toBe(baseline)
})
