import { expect, test } from "bun:test"
import { until } from "./support"
import { answer, message, open } from "./team-fixture"

const many = (count: number, text = (seq: number) => `entry ${seq}`) =>
  Array.from({ length: count }, (_, index) => message(index + 1, text(index + 1)))

/** The sequence number of the first `entry N` line in the frame. */
const topEntry = (frame: string) => Number(/entry (\d+)/.exec(frame)?.[1])

test("a poll that drops the oldest messages at the cap does not move a reader who scrolled up", async () => {
  const all = many(100)
  const routes = {
    "GET /api/team": (_: Request, url: URL) => {
      const limit = Number(url.searchParams.get("limit"))
      if (!url.searchParams.has("after")) return answer(all.slice(-limit))
      return answer(all.filter((item) => item.seq > Number(url.searchParams.get("after"))).slice(0, limit))
    },
  }
  const { view, screen } = await open(routes)
  await screen("entry 100")
  // One poll pages in the rest, up to the 500 the client keeps.
  all.push(...many(500).slice(100))
  await screen("entry 500")
  for (let page = 0; page < 5; page++) view.mockInput.pressKey("\x1b[5~")
  await until(() => !view.captureCharFrame().includes("entry 500"))
  await view.renderOnce()

  const before = topEntry(view.captureCharFrame())
  // Three tall messages arrive and push three of the oldest out of the 500 kept.
  all.push(...[501, 502, 503].map((seq) => message(seq, `entry ${seq}\n${"more\n".repeat(12)}`)))
  await until(() => view.captureCharFrame().includes("↓") || all.length === 503)
  await Bun.sleep(2600)
  await view.renderOnce()
  const after = topEntry(view.captureCharFrame())
  expect(before).toBeGreaterThan(0)
  expect(after - before).toBeLessThan(10)
})
