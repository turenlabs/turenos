import { afterEach, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { footerShortcuts, scheduleText, statusline } from "../src/chrome"
import { identifying } from "../src/dashboard/status"
import { createLayout } from "../src/layout"
import { fitActions } from "../src/layout/fit"
import { meterText } from "../src/context-meter"
import type { Snapshot } from "../src/server"
import { createDashboardState } from "../src/state"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose()
})

const row = [
  { text: "x Stop", rank: 100 },
  { text: "h History", rank: 50 },
  { text: "i Details", rank: 40 },
  { text: "d Changes", rank: 30 },
  { text: "e Files", rank: 20 },
  { text: "t Tasks · 1/3 to-dos", short: "t Tasks", rank: 60 },
  { text: "u 3 queued", short: "u 3", rank: 90 },
  { text: "H Harness", rank: 10 },
  { text: "Context 45% · 90k/200k", short: "Ctx 45%", rank: 80 },
]

test.each([120, 80, 60, 40])("action row keeps whole entries, Stop, queued and the meter at %d columns", (width) => {
  const fitted = fitActions(row, width - 9 - (width > 90 ? 34 : 0))
  const shown = fitted.filter((text) => text !== undefined)
  expect(shown.join("  ").length).toBeLessThanOrEqual(width - 9 - (width > 90 ? 34 : 0))
  expect(shown).toContain("x Stop")
  expect(shown.some((text) => text.startsWith("u 3"))).toBe(true)
  expect(shown.some((text) => text.startsWith("C"))).toBe(true)
  for (const text of shown) expect(row.some((entry) => entry.text === text || entry.short === text)).toBe(true)
})

test("action row drops the lowest-ranked entry first and compacts the meter before dropping it", () => {
  const fitted = fitActions(row, 100)
  expect(fitted[7]).toBeUndefined()
  expect(fitted[8]).toBe("Context 45% · 90k/200k")
  expect(fitActions(row, 50)[8]).toBe("Ctx 45%")
})

test("short context meter keeps the percentage", () => {
  expect(meterText({ model: { providerID: "p", id: "m" }, total: 90000 }, 200000, true)).toBe("Ctx 45%")
})

test("long server addresses keep host:port, then the port", () => {
  expect(identifying("http://127.0.0.1:43079", 40)).toBe("http://127.0.0.1:43079")
  expect(identifying("http://127.0.0.1:43079", 16)).toBe("127.0.0.1:43079")
  expect(identifying("http://127.0.0.1:43079", 8)).toBe(":43079")
})

test("schedules show the largest whole unit", () => {
  expect(scheduleText({ type: "interval", seconds: 1800, timezone: "UTC" })).toBe("Every 30m")
  expect(scheduleText({ type: "interval", seconds: 86400, timezone: "UTC" })).toBe("Every 1d")
  expect(scheduleText({ type: "interval", seconds: 90, timezone: "UTC" })).toBe("Every 90s")
})

test("narrow footer names the tab and how to reach the hidden sidebar; wide footer names the focus", () => {
  const state = createDashboardState()
  state.tab = "terminals"
  expect(statusline(state, undefined, 80)).toStartWith("2/3 Terminals")
  expect(footerShortcuts(80, false)).toContain("b sidebar")
  expect(footerShortcuts(60, false)).toContain("b sidebar")
  expect(footerShortcuts(120, true)).toContain("Tab pane")
  state.tab = "sessions"
  expect(statusline(state, undefined, 120)).toContain("Focus: sessions")
  state.detailFocused = true
  expect(statusline(state, undefined, 120)).toContain("Focus: transcript")
})

test("the action panel hides when it has no composer line, and the size notice mentions drafts only with a modal", async () => {
  const view = await createTestRenderer({ width: 100, height: 30 })
  cleanup.push(() => view.renderer.destroy())
  const state = createDashboardState()
  state.connected = true
  const ui = createLayout(view.renderer, state)
  ui.composer.visible = false
  ui.resize()
  expect(ui.actions.visible).toBe(false)
  ui.composer.visible = true
  ui.resize()
  expect(ui.actions.visible).toBe(true)
  view.resize(50, 20)
  ui.resize()
  expect(ui.sizeNotice.visible).toBe(true)
  const text = ui.sizeNotice.getChildren()[0] as unknown as { plainText: string }
  expect(text.plainText).not.toContain("Your draft stays open")
})

test.each([
  [120, true],
  [100, false],
  [80, false],
  [60, false],
])("the footer names the session's agent and model only where it fits (%d columns)", (width, shown) => {
  const state = createDashboardState()
  state.connected = true
  state.selected = "ses_a"
  const snapshot = {
    sessions: [{ id: "ses_a", agent: "build", model: { providerID: "sandbox", id: "scripted" } }],
  } as unknown as Snapshot
  const footer = statusline(state, snapshot, width)
  expect(footer.includes("build · sandbox/scripted")).toBe(shown)
  if (shown) expect(footer.length + footerShortcuts(width, true).length + 6).toBeLessThanOrEqual(width)
})

test("without a session model the footer falls back to the latest reply, then the server default", () => {
  const state = createDashboardState()
  state.selected = "ses_a"
  const snapshot = { sessions: [{ id: "ses_a" }], active: {} } as unknown as Snapshot
  expect(statusline(state, snapshot, 120)).toContain("server default · server default")
  state.detail = {
    sessionID: "ses_a",
    permissions: [],
    questions: [],
    messages: [{ type: "assistant", agent: "plan", model: { providerID: "p", id: "m", variant: "fast" } }],
  } as unknown as NonNullable<typeof state.detail>
  expect(statusline(state, snapshot, 120)).toContain("plan · p/m (fast)")
})
