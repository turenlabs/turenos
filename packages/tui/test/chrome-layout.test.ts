import { afterEach, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { headerLeft, promptBoxText, scheduleText, statusline, welcomeBody } from "../src/chrome"
import { mountDashboard } from "../src/index"
import { createLayout } from "../src/layout"
import { connect } from "../src/server"
import { turen, terminal, cleanup as supportCleanup } from "./support"
import { createDashboardState } from "../src/state"
import { color } from "../src/theme"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose()
})

async function fixture(width: number) {
  const view = await createTestRenderer({ width, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  const state = createDashboardState()
  state.connected = true
  state.selected = "ses_layout"
  state.snapshot = {
    location: { directory: "/remote/project", project: { id: "project", directory: "/remote/project" } },
    sessions: [],
    active: {},
    terminals: [],
    terminalsAvailable: true,
    loops: [],
    inventoryErrors: { terminals: "", automations: "" },
    terminalFolderErrors: [],
    updated: 1,
    more: false,
  }
  const ui = createLayout(view.renderer, state)
  ui.heading.content = headerLeft(state.snapshot)
  ui.footer.content = statusline(state, state.snapshot, width)
  ui.context.content = state.snapshot.location.directory
  ui.renderContent("Conversation stays visible")
  ui.tasks.visible = true
  for (const [index, { button, name }] of ui.tabButtons.entries())
    button.content = width < 90 ? name : ["1 Ses", "2 Ter", "3 Aut", "4 Tea"][index]!
  ui.resize()
  await view.renderOnce()
  return { ...view, ui, state }
}

for (const width of [60, 160]) {
  test.each([false, true])(
    `transcript text stays clear of its scrollbar at ${width} columns (rich=%s)`,
    async (rich) => {
      const view = await fixture(width)
      view.ui.renderContent(
        ("Wrapped words should never disappear beneath the scrollbar. ".repeat(3) + "\n").repeat(30),
        rich,
      )
      await view.renderOnce()
      await view.renderOnce()
      const bar = view.ui.detail.verticalScrollBar
      expect(view.ui.detail.scrollHeight).toBeGreaterThan(view.ui.detail.viewport.height)
      for (const child of view.ui.detail.getChildren().filter((child) => child.visible))
        expect(child.x + child.width).toBeLessThanOrEqual(bar.x)
    },
  )

  test(`primary and secondary actions remain complete at ${width}x24`, async () => {
    const view = await fixture(width)
    const { ui, state } = view
    for (const primary of [
      promptBoxText(state, undefined, { hasDraft: false, agentModel: "A very long provider and model name" }),
      promptBoxText(state, undefined, { hasDraft: true }),
      "p Review permission (2) · needs input",
      "o Answer question (2) · needs input",
    ]) {
      ui.composer.content = primary
      await view.renderOnce()
      const rows = view.captureCharFrame().split("\n")
      const primaryRow = rows.findIndex((row) => row.includes(primary))
      expect(primaryRow).toBeGreaterThanOrEqual(0)
      // The row leads with the state-relevant entries; History and Details are last and the first to give way.
      expect(rows[primaryRow + 1]).toContain("t Tasks")
      expect(rows[primaryRow + 1]).toContain("d Changes")
      expect(rows[primaryRow + 1]).toContain("e Files")
      expect(ui.actions.height).toBe(2)
      expect(ui.composer.width).toBeGreaterThanOrEqual(primary.length)
      expect(view.captureCharFrame()).toContain("Conversation stays visible")
      expect(ui.sizeNotice.visible).toBe(false)
    }
    expect(ui.composer.y).toBeLessThan(ui.history.y)
    expect(ui.history.y).toBe(ui.information.y)
    expect(ui.tasks.y).toBe(ui.history.y)
    expect(view.captureCharFrame().split("/remote/project")).toHaveLength(2)
    expect(ui.sidebar.visible).toBe(width >= 90)
  })
}

for (const width of [60]) {
  test.each([
    { connected: true, connectionError: "", status: "Connected" },
    { connected: false, connectionError: "", status: "Connecting…" },
    { connected: false, connectionError: "Connection failed", status: "Disconnected" },
  ])(`compact welcome remains complete at ${width} columns (%s)`, async (connection) => {
    const view = await fixture(width)
    view.state.selected = ""
    view.state.connected = connection.connected
    view.state.connectionError = connection.connectionError
    view.ui.context.visible = false
    const body = welcomeBody("sessions", view.state)
    view.ui.renderContent(body)
    await view.renderOnce()
    await view.renderOnce()
    const frame = view.captureCharFrame()
    const lines = body.split("\n")
    expect(lines).toHaveLength(8)
    for (const line of lines.filter(Boolean)) {
      expect(line.length).toBeLessThanOrEqual(54)
      expect(frame).toContain(line)
    }
    expect(frame).toContain("[ Turen ]")
    expect(frame).toContain(`${connection.status} · No session selected.`)
    for (const shortcut of [
      "n or Enter start a session",
      "Ctrl+K sessions · b session list",
      "1-4 tabs · 4 Team · ? help · Ctrl+P commands",
      "m model · , settings · I intel",
    ])
      expect(frame).toContain(shortcut)
    expect(body).not.toContain("No agent sessions yet")
    expect(view.ui.detail.scrollHeight).toBeLessThanOrEqual(view.ui.detail.viewport.height)
    expect(view.ui.sizeNotice.visible).toBe(false)
  })
}

test("welcome without connection state makes no connectivity claim", () => {
  const body = welcomeBody("sessions")
  expect(body).toContain("No session selected.")
  expect(body).not.toMatch(/Connected|Connecting|Disconnected/)
})

test("desktop tabs share one row and list starts beneath compact controls", async () => {
  const { ui, captureCharFrame } = await fixture(160)
  const [chat, terminal, automation] = ui.tabButtons.map(({ button }) => button)
  expect(chat!.y).toBe(terminal!.y)
  expect(chat!.y).toBe(automation!.y)
  expect(ui.folders.visible).toBe(true)
  expect(ui.list.y - ui.sidebar.y).toBeLessThanOrEqual(5)
  for (const text of ["1 Ses", "2 Ter", "3 Aut", "4 Tea", "+ New session", "/ Find a session"])
    expect(captureCharFrame()).toContain(text)
})

test("focus retains the existing high-contrast pane cues", async () => {
  const { ui, state, renderOnce } = await fixture(160)
  state.detailFocused = true
  ui.focus()
  await renderOnce()
  expect(ui.detail.focused).toBe(true)
  expect(ui.actions.borderColor).toEqual(RGBA.fromHex(color.accent))
  expect(ui.sidebarHeading.fg).toEqual(RGBA.fromHex(color.muted))
  state.detailFocused = false
  ui.focus()
  await renderOnce()
  expect(ui.list.focused).toBe(true)
  expect(ui.actions.borderColor).toEqual(RGBA.fromHex(color.border))
  expect(ui.sidebarHeading.fg).toEqual(RGBA.fromHex(color.accent))
})

test("notice wraps recovery instructions without hiding actions at minimum size", async () => {
  const { ui, renderOnce, captureCharFrame } = await fixture(60)
  ui.composer.content = "Enter type"
  const notice =
    "Clipboard copy was attempted, not confirmed. Press F6 for native terminal selection, then try copying again."
  ui.notice.content = notice
  ui.notice.visible = true
  await renderOnce()
  const noticeRows = captureCharFrame()
    .split("\n")
    .slice(ui.notice.y, ui.notice.y + ui.notice.height)
  expect(ui.notice.height).toBeGreaterThanOrEqual(2)
  expect(ui.notice.height).toBeLessThanOrEqual(3)
  expect(noticeRows.join(" ").replace(/\s+/g, " ")).toContain(notice)
  for (const text of ["Enter type", "d Changes", "e Files", "t Tasks", "? help"])
    expect(captureCharFrame()).toContain(text)
  ui.notice.content = "Recovery instruction ".repeat(30)
  await renderOnce()
  expect(ui.notice.height).toBe(3)
  expect(captureCharFrame()).toContain("Enter type")
  ui.notice.content = "Ready"
  await renderOnce()
  expect(ui.notice.height).toBe(1)
})

test("narrow sidebar keeps full tab labels when explicitly opened", async () => {
  const { ui, state, renderOnce, captureCharFrame } = await fixture(60)
  state.sidebarHidden = false
  ui.resize()
  await renderOnce()
  for (const text of ["1 Sessions", "2 Terminals", "3 Automations", "4 Team"])
    expect(captureCharFrame()).toContain(text)
  expect(ui.sidebar.visible).toBe(true)
  expect(ui.sizeNotice.visible).toBe(false)
})

test("scheduleText formats intervals, cron expressions, file changes, and session end triggers", () => {
  const interval = { type: "interval" as const, seconds: 60, timezone: "UTC" }
  expect(scheduleText(interval)).toBe("Every 1m")

  const cron = { type: "cron" as const, seconds: 3600, expression: "0 2 * * *", timezone: "America/New_York" }
  expect(scheduleText(cron)).toBe("Cron 0 2 * * * (America/New_York)")

  // File change event trigger
  const fileTrigger = { type: "file-change" as const, paths: ["src/**/*.ts", "docs/*.md"], debounceMs: 500 }
  expect(scheduleText(interval, fileTrigger)).toBe("File change (src/**/*.ts, docs/*.md) · debounce 500ms")

  const fileTriggerNoDebounce = { type: "file-change" as const, paths: ["packages/core/**"] }
  expect(scheduleText(interval, fileTriggerNoDebounce)).toBe("File change (packages/core/**)")

  // Session end event trigger
  const sessionTrigger = {
    type: "session-end" as const,
    agent: "builder",
    sessionID: "ses_review",
    outcomes: ["failure" as const],
  }
  expect(scheduleText(interval, sessionTrigger)).toBe(
    "Session end (agent: builder, session: ses_review, outcome: failure)",
  )

  const genericSessionTrigger = { type: "session-end" as const }
  expect(scheduleText(interval, genericSessionTrigger)).toBe("Session end (any)")
})

test.each([60, 66])(
  "at %i columns the footer names the way back to typing and the top bar keeps the port, without buttons",
  async (width) => {
    const server = turen()
    const { view, screen } = await terminal(width, 24)
    const app = mountDashboard(view.renderer, connect({ url: server.url }), server.url, () => {}, {
      server: "http://x.lan:4096",
      servers() {},
    })
    supportCleanup.push(app.dispose)
    await app.ready
    await screen("main says hello")
    // Typing keeps the palette in the footer; Esc swaps it for the key back to typing and help.
    expect((await screen("Ctrl+P commands")).trimEnd().split("\n").at(-1)).toContain("Typing")
    view.mockInput.pressKey("ESCAPE")
    const lines = (await screen("Enter type")).trimEnd().split("\n")
    expect(lines.at(-1)).toContain("Enter type · ? help")
    // Below 70 columns the buttons are gone and the address keeps its port.
    expect(lines[1]).toContain("4096")
    expect(lines[1]).not.toContain("Servers")
  },
)
