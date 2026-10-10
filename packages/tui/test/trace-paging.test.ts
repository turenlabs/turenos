import { afterEach, expect, test } from "bun:test"
import { mountDashboard } from "../src/index"
import { connect } from "../src/server"
import { cleanup, terminal, turen } from "./support"

afterEach(() => cleanup.splice(0).forEach((fn) => fn()))

const log = Array.from({ length: 450 }, (_, index) => ({
  id: `evt_${index + 1}`,
  type: `step.${index + 1}`,
  durable: { aggregateID: "ses_main", seq: index + 1, version: 1 },
  data: {},
}))

/** The server's replay endpoint: no direction reads forward from the start, `before` reads back from the end. */
function replay(_: Request, url: URL) {
  const limit = Number(url.searchParams.get("limit"))
  const cursor = url.searchParams.get("cursor")
  const at = cursor ? log.findIndex((event) => event.id === cursor) : -1
  if (url.searchParams.get("direction") === "before") {
    const end = cursor ? at : log.length
    const page = log.slice(Math.max(0, end - limit), end)
    return { data: page, cursor: end - limit > 0 ? { previous: page[0]!.id } : {} }
  }
  const page = log.slice(at + 1, at + 1 + limit)
  return { data: page, cursor: at + 1 + limit < log.length ? { next: page.at(-1)!.id } : {} }
}

async function trace() {
  const server = turen({ routes: { "GET /api/session/ses_main/replay": replay } })
  const { view, screen } = await terminal(100, 30)
  const app = mountDashboard(view.renderer, connect({ url: server.url }), server.url)
  cleanup.push(app.dispose)
  await app.ready
  await screen("main task")
  view.mockInput.pressKey("p", { ctrl: true })
  await view.mockInput.typeText("Session trace")
  view.mockInput.pressEnter()
  return { view, screen }
}

test("Trace opens on the newest 200 events and [ pages to older ones", async () => {
  const { view, screen } = await trace()
  expect(await screen("200 events")).toContain("#251–#450")
  await view.mockInput.typeText("[")
  expect(await screen("#51–#250")).not.toContain("No older events")
  await view.mockInput.typeText("[")
  expect(await screen("#1–#50")).toContain("50 events")
  await view.mockInput.typeText("[")
  expect(await screen("No older events")).toContain("#1–#50")
})

test("] pages back to newer events and stops at the newest", async () => {
  const { view, screen } = await trace()
  await screen("#251–#450")
  await view.mockInput.typeText("[")
  await screen("#51–#250")
  await view.mockInput.typeText("]")
  await screen("#251–#450")
  await view.mockInput.typeText("]")
  expect(await screen("No newer events")).toContain("#251–#450")
})
