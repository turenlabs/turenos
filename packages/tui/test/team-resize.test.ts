import { expect, test } from "bun:test"
import { ScrollBoxRenderable } from "@opentui/core"
import { descendants, until } from "./support"
import { answer, message, open } from "./team-fixture"

const all = Array.from({ length: 2000 }, (_, index) =>
  message(index + 1, `entry ${index + 1} ${"lorem ipsum dolor sit amet ".repeat(1 + (index % 4))}`),
)

const routes = {
  "GET /api/team": (_: Request, url: URL) => {
    const limit = Number(url.searchParams.get("limit"))
    if (!url.searchParams.has("after")) return answer(all.slice(-limit))
    return answer(all.filter((item) => item.seq > Number(url.searchParams.get("after"))).slice(0, limit))
  },
}

test.each([
  [120, 56, 120, 32],
  [65, 56, 65, 32],
  [65, 56, 58, 32],
])("the Team tab keeps the newest message in view when %ix%i shrinks to %ix%i", async (width, height, to, rows) => {
  const { view, screen } = await open(routes, width, height)
  await screen("entry 2000")
  view.resize(to, rows)
  await until(() => view.captureCharFrame().includes("entry 2000"))
  expect(view.captureCharFrame().match(/entry \d+/g)?.length ?? 0).toBeGreaterThan(3)
})

test("a shorter Team transcript keeps the reader's position through refresh", async () => {
  const { view, screen, server } = await open(routes, 120, 56)
  await screen("entry 2000")
  const detail = descendants(view.renderer.root).find(
    (node) => node instanceof ScrollBoxRenderable && node.scrollHeight > node.viewport.height,
  ) as ScrollBoxRenderable
  view.mockInput.pressKey("\x1b[5~")
  view.mockInput.pressKey("\x1b[5~")
  await until(() => !view.captureCharFrame().includes("entry 2000"))
  const before = detail.scrollTop
  const marker = view.captureCharFrame().match(/entry \d+/)![0]
  view.resize(120, 32)
  await view.renderOnce()
  await view.renderOnce()
  expect(detail.scrollTop).toBe(before)
  expect(view.captureCharFrame()).toContain(marker)
  expect(view.captureCharFrame()).not.toContain("entry 2000")
  const requests = server.requests.filter((item) => item.path === "/api/team").length
  view.mockInput.pressKey("r")
  await until(() => server.requests.filter((item) => item.path === "/api/team").length > requests)
  await Bun.sleep(100)
  await view.renderOnce()
  expect(detail.scrollTop).toBe(before)
  expect(view.captureCharFrame()).toContain(marker)
  expect(view.captureCharFrame()).not.toContain("entry 2000")
})
