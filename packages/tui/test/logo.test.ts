import { expect, test } from "bun:test"
import { turenLogo, welcomeMark } from "../src/logo"
import { mountDashboard } from "../src/dashboard/mount"
import { connect } from "../src/server"
import { cleanup, terminal, turen } from "./support"

const rows = (logo: { content: { chunks: { text: string }[] } }) =>
  logo.content.chunks
    .map((chunk) => chunk.text)
    .join("")
    .split("\n")

test("the logo carries the anvil wherever a dialog has room, and never outgrows it", () => {
  const wide = turenLogo(true)
  expect([wide.width, wide.height]).toEqual([66, 9])
  // A tall terminal has room for the desktop's mark itself beside the wordmark.
  const tall = turenLogo(true, 160, 44)
  expect([tall.width, tall.height]).toEqual([75, 16])
  expect(turenLogo(true, 160, 43).height).toBe(9)
  // A 58-column phone leaves a dialog 52 inner columns: the small anvil and the wordmark fill them exactly.
  expect(turenLogo(false, 58).width).toBe(52)
  expect(turenLogo(false, 57).width).toBe(41)
  for (const logo of [wide, tall, turenLogo(false, 58), turenLogo(false, 40)]) {
    const lines = rows(logo)
    expect(lines).toHaveLength(logo.height)
    for (const line of lines) expect(line.length).toBe(logo.width)
  }
})

test("the welcome anvil is the largest that fits the rows it is given", () => {
  expect([20, 19, 16, 15, 9, 8, 4, 1].map((room) => welcomeMark(room).height)).toEqual([20, 16, 16, 9, 9, 4, 4, 4])
  for (const room of [20, 16, 9, 4]) {
    const mark = welcomeMark(room)
    const lines = rows(mark)
    expect(lines).toHaveLength(mark.height)
    for (const line of lines) expect(line.length).toBe(mark.width)
    expect(lines[0]!.trim()).not.toBe("")
  }
})

test("the welcome anvil grows and shrinks with the terminal", async () => {
  const server = turen({ routes: { "GET /api/session": () => ({ data: [], cursor: {} }) } })
  const { view, screen } = await terminal(120, 36)
  const app = mountDashboard(view.renderer, connect({ url: server.url }), server.url)
  cleanup.push(app.dispose)
  await app.ready
  /** The rows of the anvil the frame shows whole. */
  const shown = (frame: string) =>
    [20, 16, 9, 4].find((room) => rows(welcomeMark(room)).every((line) => frame.includes(line)))
  await screen("No session selected")
  // The anvil fits the terminal first, then the pane once it is laid out.
  for (let frame = 0; frame < 3; frame++) await view.renderOnce()
  const large = shown(view.captureCharFrame())
  view.resize(80, 24)
  for (let frame = 0; frame < 5; frame++) await view.renderOnce()
  const small = view.captureCharFrame()
  expect(large).toBeGreaterThanOrEqual(16)
  expect(shown(small)).toBeLessThan(large!)
  expect(small).toContain("No session selected")
})
