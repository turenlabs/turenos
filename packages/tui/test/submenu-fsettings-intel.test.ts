import { afterEach, expect, test } from "bun:test"
import { cleanup, dashboard, terminal, turen } from "./support"
import { connect } from "../src/server"
import { mountDashboard } from "../src"

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})

const advisory = {
  id: "GHSA-1",
  title: "CVE-2025-6917 Parser overflow",
  severity: "critical",
  cvss: 9.8,
  publishedAt: 1,
  updatedAt: 1,
  source: "github",
  summary: "Heap overflow in the parser.",
}
const routes = {
  "GET /api/intel/advisories": () => ({ items: [advisory], total: 1, page: 1, pageSize: 50 }),
  "GET /api/intel/kev": () => ({ items: [], total: 0, page: 1, pageSize: 50 }),
  "GET /api/intel/feeds": () => [
    { id: "kev", name: "CISA KEV", kind: "kev", url: "https://cisa.gov/kev", enabled: true },
  ],
  "POST /api/intel/poll": () => ({ feeds: [] }),
}

test("Intel titles name the list and its parent", async () => {
  const app = await dashboard(routes)
  app.view.mockInput.pressKey("I")
  await app.screen("Intel › Advisories")
  await app.screen("Heap overflow in the parser.")
  app.view.mockInput.pressKey("m")
  await app.screen("Intel › Known exploited (KEV)")
  app.view.mockInput.pressKey("f")
  await app.screen("Intel › Feeds")
  await app.screen("CISA KEV")
})

test("a poll leaves its result visible after the list reloads", async () => {
  const app = await dashboard(routes)
  app.view.mockInput.pressKey("I")
  await app.screen("Heap overflow in the parser.")
  app.view.mockInput.pressKey("p")
  await app.screen("Feeds updated.")
})

test("at 60 columns the CVE id stays whole and the hint fits two lines", async () => {
  const server = turen({ routes })
  const { view, screen } = await terminal(60, 24)
  const app = mountDashboard(view.renderer, connect({ url: server.url }), server.url)
  cleanup.push(app.dispose)
  await app.ready
  view.mockInput.pressKey("I")
  const frame = await screen("Heap overflow")
  expect(frame).toContain("CVE-2025-6917")
  expect(frame).toContain("Esc close")
})
