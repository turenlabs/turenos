import { describe, expect, test } from "bun:test"
import {
  collapseForTerminalFocus,
  countRunningAgents,
  DEFAULT_PANEL_COLLAPSE,
  DEFAULT_PANEL_PIN,
  expandForHomeEntry,
  focusZone,
  isAgentsHome,
  nextTerminalFocusTenure,
  panelAvailable,
  panelShortcutAvailable,
  railClick,
  releasePanelPin,
  SHELL_CHROME_SELECTOR,
  migrateNavRailState,
  surfaceFromLocation,
  surfaceEnabled,
  surfaceHref,
  TERMINAL_PANE_SELECTOR,
  togglePanelCollapse,
  togglePanelWithPin,
  type Surface,
} from "./nav-rail-state"

describe("surfaceFromLocation", () => {
  test("gates the Lobby surface behind its beta setting", () => {
    expect(surfaceEnabled("lobby", false)).toBe(false)
    expect(surfaceEnabled("lobby", true)).toBe(true)
    expect(surfaceEnabled("agents", false)).toBe(true)
  })

  test("Home and Extend routes own their surfaces", () => {
    expect(surfaceFromLocation({ pathname: "/home" })).toBe("home")
    expect(surfaceFromLocation({ pathname: "/extend" })).toBe("extend")
    expect(surfaceFromLocation({ pathname: "/extend/installed" })).toBe("extend")
    expect(surfaceFromLocation({ pathname: "/lobby" })).toBe("lobby")
    expect(surfaceFromLocation({ pathname: "/lobby/room_1" })).toBe("lobby")
    expect(surfaceFromLocation({ pathname: "/replay" })).toBe("replay")
    expect(surfaceFromLocation({ pathname: "/replay/ses_1" })).toBe("replay")
  })

  test("home is the Agents surface", () => {
    expect(surfaceFromLocation({ pathname: "/" })).toBe("agents")
  })

  test("session, draft, and unmatched routes belong to the Agents surface", () => {
    expect(surfaceFromLocation({ pathname: "/server/local/session/ses_1" })).toBe("agents")
    expect(surfaceFromLocation({ pathname: "/unmatched" })).toBe("agents")
    expect(surfaceFromLocation({ pathname: "/new-session" })).toBe("agents")
    expect(surfaceFromLocation({ pathname: `/${["rever", "sing"].join("")}` })).toBe("agents")
  })

  test("analysis routes belong to the Analysis surface", () => {
    expect(surfaceFromLocation({ pathname: "/analysis" })).toBe("analysis")
    expect(surfaceFromLocation({ pathname: "/analysis/unknown-workspace" })).toBe("analysis")
    expect(surfaceFromLocation({ pathname: "/analysis/pen-testing" })).toBe("analysis")
  })

  test("top-level pentest routes and an active run keep the Workbench surface", () => {
    // A run page that falls through to "agents" swaps the Workbench rail for the session nav
    // while the user is watching a live run.
    expect(surfaceFromLocation({ pathname: "/pentest" })).toBe("analysis")
    expect(surfaceFromLocation({ pathname: "/pentest/pent_f9ee2854954b" })).toBe("analysis")
  })

  test("automation routes and legacy Loop links belong to Automations", () => {
    expect(surfaceFromLocation({ pathname: "/automations" })).toBe("automations")
    expect(surfaceFromLocation({ pathname: "/automations/auto_1" })).toBe("automations")
    expect(surfaceFromLocation({ pathname: "/loops/lop_1" })).toBe("automations")
  })
})

describe("surfaceHref", () => {
  test("reuses the existing destinations for deep links", () => {
    expect(surfaceHref("home")).toBe("/home")
    expect(surfaceHref("agents")).toBe("/")
    // "/analysis" is the Workbench entry point: it restores whichever tab was
    // last active (see AnalysisIndexRedirect in app.tsx) instead of hardcoding
    // one destination here.
    expect(surfaceHref("analysis")).toBe("/analysis")
    expect(surfaceHref("lobby")).toBe("/lobby")
    expect(surfaceHref("replay")).toBe("/replay")
    expect(surfaceHref("automations")).toBe("/automations")
    expect(surfaceHref("extend")).toBe("/extend/catalog")
  })
})

describe("panelAvailable", () => {
  test("the Agents panel is shell chrome: present on every Agents-surface route", () => {
    expect(panelAvailable("agents", { pathname: "/" })).toBe(true)
    expect(panelAvailable("agents", { pathname: "/server/local/session/ses_1" })).toBe(true)
    expect(panelAvailable("agents", { pathname: "/unmatched" })).toBe(true)
    expect(panelAvailable("agents", { pathname: "/new-session" })).toBe(true)
  })

  test("Automations has a left panel on every automation route", () => {
    expect(panelAvailable("automations", { pathname: "/automations" })).toBe(true)
    expect(panelAvailable("automations", { pathname: "/automations/auto_1" })).toBe(true)
  })

  test("Analysis is a panel-free product workspace", () => {
    expect(panelAvailable("analysis", { pathname: "/analysis/appsec" })).toBe(false)
    expect(panelAvailable("analysis", { pathname: "/analysis/unknown-workspace" })).toBe(false)
  })

  test("Replay is a panel-free product workspace", () => {
    expect(panelAvailable("replay", { pathname: "/replay" })).toBe(false)
  })

  test("Lobby owns its room list rather than a shell panel", () => {
    expect(panelAvailable("lobby", { pathname: "/lobby/room_1" })).toBe(false)
  })
})

describe("panelShortcutAvailable", () => {
  test("the shell claims mod+\\ on panel routes without a competing binding", () => {
    expect(panelShortcutAvailable("agents", { pathname: "/" })).toBe(true)
    expect(panelShortcutAvailable("agents", { pathname: "/unmatched" })).toBe(true)
    expect(panelShortcutAvailable("agents", { pathname: "/new-session" })).toBe(true)
  })

  test("session routes keep their file-tree mod+\\ binding", () => {
    expect(panelShortcutAvailable("agents", { pathname: "/server/local/session/ses_1" })).toBe(false)
    expect(panelShortcutAvailable("agents", { pathname: "/my-dir/session/ses_1" })).toBe(false)
  })

  test("never claims the shortcut where the panel itself is absent", () => {
    expect(panelShortcutAvailable("analysis", { pathname: "/analysis/appsec" })).toBe(false)
  })
})

describe("railClick", () => {
  test("clicking the active surface with its panel present toggles the panel", () => {
    expect(railClick("agents", { pathname: "/" })).toEqual({ type: "toggle" })
  })

  test("clicking an inactive surface navigates to it", () => {
    expect(railClick("analysis", { pathname: "/" })).toEqual({ type: "navigate", href: "/analysis" })
    expect(railClick("lobby", { pathname: "/" })).toEqual({ type: "navigate", href: "/lobby" })
    expect(railClick("automations", { pathname: "/" })).toEqual({ type: "navigate", href: "/automations" })
    expect(railClick("replay", { pathname: "/" })).toEqual({ type: "navigate", href: "/replay" })
  })

  test("clicking active Automations toggles its left panel", () => {
    expect(railClick("automations", { pathname: "/automations" })).toEqual({ type: "toggle" })
    expect(railClick("automations", { pathname: "/automations/auto_1" })).toEqual({ type: "toggle" })
  })

  test("an unpresented Automations panel opens through its surface route", () => {
    expect(railClick("automations", { pathname: "/automations/auto_1" }, () => false)).toEqual({
      type: "navigate",
      href: "/automations",
    })
  })

  test("clicking Agents from a session route toggles the shell panel (Wave 2)", () => {
    expect(railClick("agents", { pathname: "/server/local/session/ses_1" })).toEqual({ type: "toggle" })
    expect(railClick("agents", { pathname: "/unmatched" })).toEqual({ type: "toggle" })
  })

  test("below the panel's presentation breakpoint the click navigates instead of silently toggling", () => {
    const hidden = () => false
    // Session/unmatched routes below lg: the desktop Agents column is
    // display:none, so the click goes to "/" where the stacked column lives.
    expect(railClick("agents", { pathname: "/server/local/session/ses_1" }, hidden)).toEqual({
      type: "navigate",
      href: "/",
    })
    expect(railClick("agents", { pathname: "/unmatched" }, hidden)).toEqual({ type: "navigate", href: "/" })
    expect(railClick("agents", { pathname: "/" }, hidden)).toEqual({ type: "navigate", href: "/" })
  })

  test("a presented panel keeps the toggle", () => {
    const only = (visible: Surface) => (surface: Surface) => surface === visible
    expect(railClick("agents", { pathname: "/" }, only("agents"))).toEqual({ type: "toggle" })
  })

  test("an off-surface click never consults presentation: it always navigates", () => {
    let consulted = 0
    const spy = () => {
      consulted++
      return true
    }
    expect(railClick("analysis", { pathname: "/" }, spy)).toEqual({ type: "navigate", href: "/analysis" })
    expect(consulted).toBe(0)
  })
})

describe("togglePanelCollapse", () => {
  test("toggles the Agents panel", () => {
    const first = togglePanelCollapse(DEFAULT_PANEL_COLLAPSE, "agents")
    expect(first).toEqual({ agents: true, automations: false })
    expect(togglePanelCollapse(first, "agents")).toEqual({ agents: false, automations: false })
  })

  test("toggles the Automations panel", () => {
    const first = togglePanelCollapse(DEFAULT_PANEL_COLLAPSE, "automations")
    expect(first.automations).toBe(true)
    expect(togglePanelCollapse(first, "automations").automations).toBe(false)
  })

  test("returns a new object so persisted stores observe the write", () => {
    const next = togglePanelCollapse(DEFAULT_PANEL_COLLAPSE, "agents")
    expect(next).not.toBe(DEFAULT_PANEL_COLLAPSE)
    expect(DEFAULT_PANEL_COLLAPSE).toEqual({ agents: false, automations: false })
  })
})

describe("isAgentsHome", () => {
  test("home is the route and other routes are not", () => {
    expect(isAgentsHome({ pathname: "/" })).toBe(true)
    expect(isAgentsHome({ pathname: "/server/local/session/ses_1" })).toBe(false)
    expect(isAgentsHome({ pathname: "/unmatched" })).toBe(false)
  })
})

describe("expandForHomeEntry", () => {
  const collapsed = { agents: true }

  test("launch landing on home clears a persisted agents collapse (from === undefined is an entry)", () => {
    expect(expandForHomeEntry(collapsed, undefined, { pathname: "/" })).toEqual({ agents: false })
  })

  test("navigating home from a session or unmatched route expands", () => {
    expect(expandForHomeEntry(collapsed, { pathname: "/server/local/session/ses_1" }, { pathname: "/" })).toEqual({
      agents: false,
    })
    expect(expandForHomeEntry(collapsed, { pathname: "/unmatched" }, { pathname: "/" })).toEqual({
      agents: false,
    })
  })

  test("collapsing while already on home sticks until the next entry", () => {
    expect(expandForHomeEntry(collapsed, { pathname: "/" }, { pathname: "/" })).toBeNull()
  })

  test("non-home destinations keep the persisted collapse untouched", () => {
    expect(expandForHomeEntry(collapsed, { pathname: "/" }, { pathname: "/server/local/session/ses_1" })).toBeNull()
    expect(expandForHomeEntry(collapsed, undefined, { pathname: "/unmatched" })).toBeNull()
  })

  test("an already-expanded panel skips the write", () => {
    expect(expandForHomeEntry(DEFAULT_PANEL_COLLAPSE, undefined, { pathname: "/" })).toBeNull()
    expect(expandForHomeEntry({ agents: false }, { pathname: "/unmatched" }, { pathname: "/" })).toBeNull()
  })

  test("expansion returns a new object", () => {
    const state = { agents: true }
    const next = expandForHomeEntry(state, { pathname: "/unmatched" }, { pathname: "/" })
    expect(next).toEqual({ agents: false })
    expect(next).not.toBe(state)
    expect(state).toEqual({ agents: true })
  })
})

describe("togglePanelWithPin", () => {
  test("expanding while a terminal holds focus pins the surface", () => {
    const next = togglePanelWithPin({ collapsed: { agents: true }, pinned: { ...DEFAULT_PANEL_PIN } }, "agents", true)
    expect(next.collapsed).toEqual({ agents: false })
    expect(next.pinned).toEqual({ agents: true, automations: false })
  })

  test("expanding without terminal focus leaves the surface unpinned", () => {
    const next = togglePanelWithPin({ collapsed: { agents: true }, pinned: { ...DEFAULT_PANEL_PIN } }, "agents", false)
    expect(next.collapsed.agents).toBe(false)
    expect(next.pinned.agents).toBe(false)
  })

  test("tracks Automations pin state independently", () => {
    const next = togglePanelWithPin(
      { collapsed: { automations: true }, pinned: { ...DEFAULT_PANEL_PIN } },
      "automations",
      true,
    )
    expect(next.collapsed.automations).toBe(false)
    expect(next.pinned).toEqual({ agents: false, automations: true })
  })

  test("collapsing clears the pin even during a terminal tenure", () => {
    const next = togglePanelWithPin({ collapsed: { agents: false }, pinned: { agents: true } }, "agents", true)
    expect(next.collapsed.agents).toBe(true)
    expect(next.pinned.agents).toBe(false)
  })
})

describe("collapseForTerminalFocus", () => {
  test("collapses an expanded, unpinned Agents panel", () => {
    const next = collapseForTerminalFocus({
      collapsed: { agents: false },
      pinned: { ...DEFAULT_PANEL_PIN },
    })
    expect(next).toEqual({ agents: true })
  })

  test("is a no-op once per focus transition: an already-collapsed panel returns null", () => {
    expect(collapseForTerminalFocus({ collapsed: { agents: true }, pinned: { ...DEFAULT_PANEL_PIN } })).toBeNull()
  })

  test("never fights a user pin", () => {
    expect(collapseForTerminalFocus({ collapsed: { agents: false }, pinned: { agents: true } })).toBeNull()
  })
})

describe("releasePanelPin", () => {
  test("clears a set pin", () => {
    expect(releasePanelPin({ agents: true }, "agents")).toEqual({ agents: false })
  })

  test("returns the same reference when nothing is pinned so writes can be skipped", () => {
    const pinned = { agents: false }
    expect(releasePanelPin(pinned, "agents")).toBe(pinned)
  })
})

describe("migrateNavRailState", () => {
  test("strips retired surface state while retaining Agents collapse", () => {
    expect(
      migrateNavRailState({
        collapsed: { agents: true, retired: false },
        pinned: { agents: true, retired: false },
        retiredSeenAt: 42,
      }),
    ).toEqual({ collapsed: { agents: true } })
  })

  test("normalizes missing and non-boolean collapse values", () => {
    expect(migrateNavRailState({})).toEqual({})
    expect(migrateNavRailState({ collapsed: { agents: "yes" } })).toEqual({ collapsed: { agents: false } })
  })

  test("passes non-record values through for the persisted merge to handle", () => {
    expect(migrateNavRailState(undefined)).toBeUndefined()
    expect(migrateNavRailState(null)).toBeNull()
    expect(migrateNavRailState("corrupt")).toBe("corrupt")
    const list = [1, 2]
    expect(migrateNavRailState(list)).toBe(list)
  })
})

describe("terminal focus tenure", () => {
  test("focus in a terminal starts (or keeps) the tenure", () => {
    expect(nextTerminalFocusTenure(false, "terminal")).toBe(true)
    expect(nextTerminalFocusTenure(true, "terminal")).toBe(true)
  })

  test("focus excursions into shell chrome preserve the tenure", () => {
    expect(nextTerminalFocusTenure(true, "chrome")).toBe(true)
    expect(nextTerminalFocusTenure(false, "chrome")).toBe(false)
  })

  test("focus anywhere else ends the tenure", () => {
    expect(nextTerminalFocusTenure(true, "outside")).toBe(false)
    expect(nextTerminalFocusTenure(false, "outside")).toBe(false)
  })

  test("focusZone classifies targets by the terminal and chrome selectors", () => {
    const stub = (matches: string[]) => ({
      closest: (selector: string) => (matches.includes(selector) ? {} : null),
    })
    expect(focusZone(stub([TERMINAL_PANE_SELECTOR]))).toBe("terminal")
    expect(focusZone(stub([SHELL_CHROME_SELECTOR]))).toBe("chrome")
    // A terminal pane nested in shell chrome counts as terminal.
    expect(focusZone(stub([TERMINAL_PANE_SELECTOR, SHELL_CHROME_SELECTOR]))).toBe("terminal")
    expect(focusZone(stub([]))).toBe("outside")
    expect(focusZone(null)).toBe("outside")
    expect(focusZone(undefined)).toBe("outside")
  })

  test("terminal panel chrome (tab strip, + button) is the terminal zone, not outside", () => {
    // Real-DOM shape of pages/session/unmatched-panel-v2.tsx: the xterm pane
    // carries data-component="terminal", but the tab strip and the "+" button
    // live inside #terminal-panel OUTSIDE the xterm element. Clicking them
    // must hold the tenure — otherwise "+" would release the user's pin and
    // the follow-up terminal.new focus request would collapse a pinned panel.
    const panel = document.createElement("aside")
    panel.id = "terminal-panel"
    const strip = document.createElement("div")
    const tabTrigger = document.createElement("button")
    tabTrigger.setAttribute("data-slot", "tabs-trigger")
    const addButton = document.createElement("button")
    addButton.setAttribute("data-action", "terminal-new")
    strip.append(tabTrigger, addButton)
    const pane = document.createElement("div")
    pane.setAttribute("data-component", "terminal")
    panel.append(strip, pane)
    document.body.append(panel)
    try {
      expect(focusZone(tabTrigger)).toBe("terminal")
      expect(focusZone(addButton)).toBe("terminal")
      expect(focusZone(panel)).toBe("terminal")
      expect(focusZone(pane)).toBe("terminal")
      expect(focusZone(document.body)).toBe("outside")
      // A "+" click mid-tenure keeps the tenure held.
      expect(nextTerminalFocusTenure(true, focusZone(addButton))).toBe(true)
    } finally {
      panel.remove()
    }
  })
})

describe("countRunningAgents", () => {
  test("counts non-idle sessions across every server", () => {
    expect(
      countRunningAgents([
        { status: { a: { type: "working" }, b: { type: "idle" }, c: undefined } },
        { status: { d: { type: "compacting" }, e: { type: "idle" } } },
        { status: {} },
      ]),
    ).toBe(2)
  })

  test("is zero when every session is idle or absent", () => {
    expect(countRunningAgents([])).toBe(0)
    expect(countRunningAgents([{ status: { a: { type: "idle" } } }, { status: {} }])).toBe(0)
  })

  test("excludes child sessions: sub-agent work surfaces through its root", () => {
    const info = {
      root: {},
      child: { parentID: "root" },
    } as const
    expect(
      countRunningAgents([
        {
          status: { root: { type: "working" }, child: { type: "working" } },
          info: (id) => info[id as keyof typeof info],
        },
      ]),
    ).toBe(1)
  })

  test("still counts sessions whose info has not resolved yet", () => {
    // Cold info cache (e.g. statuses hydrated at bootstrap before any session
    // detail arrives) must not make running work vanish from the spine.
    expect(countRunningAgents([{ status: { a: { type: "working" } }, info: () => undefined }])).toBe(1)
    expect(countRunningAgents([{ status: { a: { type: "working" } } }])).toBe(1)
  })
})
