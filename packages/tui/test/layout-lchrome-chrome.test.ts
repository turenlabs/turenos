import { afterEach, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { fitPath, headerRight, sidebarTitle, statusline } from "../src/chrome"
import { renderSidebarTitle, renderStatus, renderTabs } from "../src/dashboard/status"
import { toggleSidebar } from "../src/dashboard/toggles"
import type { DashboardContext } from "../src/dashboard/context"
import { createLayout } from "../src/layout"
import { createDashboardState } from "../src/state"
import type { Snapshot } from "../src/server"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose()
})

const snapshot = (terminals: number, active = 0) =>
  ({
    sessions: [],
    active: Object.fromEntries(Array.from({ length: active }, (_, index) => [`ses_${index}`, true])),
    terminals: Array.from({ length: terminals }, (_, index) => ({ id: `pty_${index}` })),
    terminalsAvailable: true,
    loops: [],
    inventoryErrors: { terminals: "", automations: "" },
  }) as unknown as Snapshot

async function dashboard(width: number, height = 24) {
  const view = await createTestRenderer({ width, height })
  cleanup.push(() => view.renderer.destroy())
  const state = createDashboardState()
  state.connected = true
  state.snapshot = snapshot(1, 1)
  const ui = createLayout(view.renderer, state)
  const d = {
    state,
    ui,
    renderer: view.renderer,
    run: { activityStep: 0 },
    c: { team: { openedSession: () => "" } },
    options: { server: "http://127.0.0.1:43623", servers: () => {} },
  }
  return { ...view, state, ui, d: d as unknown as DashboardContext }
}

async function header(width: number) {
  const view = await dashboard(width)
  view.ui.resize()
  renderStatus(view.d)
  await view.renderOnce()
  return view.captureCharFrame().split("\n")[1]!
}

test("the footer does not repeat the transcript line and names the pane that has the keys", () => {
  const state = createDashboardState()
  state.connected = true
  state.selected = "ses_a"
  state.detailFocused = true
  const footer = statusline(state, { sessions: [{ id: "ses_a" }], active: { ses_a: true } } as unknown as Snapshot, 120)
  expect(footer).not.toMatch(/Transcript|Working|Needs input/)
  expect(footer).toContain("Focus: transcript")
  state.tab = "terminals"
  expect(statusline(state, undefined, 120)).toBe("Terminals · Focus: detail")
  state.detailFocused = false
  expect(statusline(state, undefined, 120)).toBe("Terminals · Focus: sidebar")
})

test("the narrow footer explains its tab number and reports the drawer as the focus", () => {
  const state = createDashboardState()
  state.tab = "automations"
  expect(statusline(state, undefined, 80)).toBe("View 3/4 Automations")
  state.sidebarHidden = false
  expect(statusline(state, undefined, 80)).toBe("View 3/4 · Focus: sidebar")
})

test("counts are singular for one item and say where the selection is when a sidebar may be hidden", () => {
  const state = createDashboardState()
  state.tab = "terminals"
  state.connected = true
  expect(headerRight(state, snapshot(1))).toBe("1 terminal")
  expect(headerRight(state, snapshot(3))).toBe("3 terminals")
  state.rows = [{ id: "a" }, { id: "b" }, { id: "c" }] as typeof state.rows
  state.selected = "b"
  expect(headerRight(state, snapshot(3))).toBe("2 of 3 terminals")
})

test("fitPath drops whole leading folders", () => {
  expect(fitPath("/run/user/1000/turen-tui-sandbox/shots/project", 60)).toBe(
    "/run/user/1000/turen-tui-sandbox/shots/project",
  )
  expect(fitPath("/run/user/1000/turen-tui-sandbox/shots/project", 36)).toBe("…/turen-tui-sandbox/shots/project")
  expect(fitPath("/run/user/1000/turen-tui-sandbox/shots/project", 14)).toBe("…/project")
})

test("the top bar keeps the running state and shows less as the terminal narrows", async () => {
  const [wide, mid, narrow] = [await header(120), await header(80), await header(60)]
  for (const row of [wide, mid, narrow]) expect(row).toContain("● 1 running")
  expect(wide).toContain("127.0.0.1:43623")
  // The host:port stays ahead of the Servers and Sessions buttons; only the port is left when even that does not fit.
  expect(mid).toContain("127.0.0.1:43623")
  expect(narrow).toContain("127.0.0.1:43623")
  const items = (row: string) =>
    ["Models m", "Sessions Ctrl+K", "Servers s"].filter((item) => row.includes(item)).length
  expect(items(mid)).toBeGreaterThanOrEqual(items(narrow))
  expect(items(wide)).toBeGreaterThanOrEqual(items(mid))
})

test("the open view is bracketed so the list keeps `>` for its selection, and full names show when they fit", async () => {
  const wide = await dashboard(180, 48)
  wide.ui.resize()
  renderTabs(wide.d)
  expect(wide.ui.tabButtons.map(({ button }) => button.plainText)).toEqual([
    "[1 Sessions]",
    " 2 Terminals ",
    " 3 Automations ",
    " 4 Team ",
  ])
  const mid = await dashboard(120, 36)
  mid.ui.resize()
  renderTabs(mid.d)
  expect(mid.ui.tabButtons.map(({ button }) => button.plainText)).toEqual(["[1 Sess]", " 2 Term ", " 3 Auto ", " 4 Team "])
  const compact = await dashboard(100, 36)
  compact.ui.resize()
  renderTabs(compact.d)
  expect(compact.ui.tabButtons.map(({ button }) => button.plainText)).toEqual(["[1 Sess]", " 2 ", " 3 ", " 4 "])
  const narrow = await dashboard(60)
  narrow.ui.resize()
  toggleSidebar(narrow.d)
  renderTabs(narrow.d)
  expect(narrow.ui.tabButtons.map(({ button }) => button.plainText)).toEqual([
    "[1 Sessions]",
    " 2 Terminals ",
    " 3 Automations ",
    " 4 Team ",
  ])
})

test("the narrow drawer lines up with the composer box, has a heading with its close key, and takes the focus", async () => {
  for (const width of [80, 60]) {
    const view = await dashboard(width)
    view.ui.resize()
    view.state.selected = "ses_a"
    view.ui.composer.visible = true
    view.state.detailFocused = true
    toggleSidebar(view.d)
    renderSidebarTitle(view.d)
    await view.renderOnce()
    expect(view.ui.sidebar.visible).toBe(true)
    expect(view.state.detailFocused).toBe(false)
    expect(view.ui.sidebar.x).toBe(view.ui.actions.x)
    expect(view.ui.sidebar.x + view.ui.sidebar.width).toBeLessThanOrEqual(width - 2)
    expect(view.ui.sidebarHeading.visible).toBe(true)
    expect(view.ui.sidebarHeading.plainText).toBe(sidebarTitle(view.state, 0, true))
    expect(view.ui.sidebarHeading.plainText).toContain("b close")
  }
})
