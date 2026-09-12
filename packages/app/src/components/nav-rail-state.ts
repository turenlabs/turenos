// Headless logic for the persistent navigation rail (see .interface-design/system.md).
//
// The rail is a thin shell over separate product surfaces. This
// module owns the shell's decisions only: which surface a location belongs to,
// what a rail click should do, and the collapse-state shape that gets
// persisted. It deliberately imports nothing from either feature.

export type Surface = "home" | "agents" | "lobby" | "replay" | "automations" | "extend"

export function surfaceEnabled(surface: Surface, lobbyBetaEnabled: boolean, automationsEnabled = false) {
  if (surface === "lobby") return lobbyBetaEnabled
  if (surface === "automations") return automationsEnabled
  return true
}

export function navRailSurfaces(automationsEnabled: boolean, lobbyBetaEnabled: boolean): Surface[] {
  const surfaces: Surface[] = ["home", "agents"]
  if (automationsEnabled) surfaces.push("automations")
  surfaces.push("extend", "replay")
  if (lobbyBetaEnabled) surfaces.push("lobby")
  return surfaces
}

export function navRailKeybind(surface: Surface, automationsEnabled: boolean, lobbyBetaEnabled: boolean) {
  const index = navRailSurfaces(automationsEnabled, lobbyBetaEnabled).indexOf(surface)
  return index < 0 ? undefined : `mod+${index + 1}`
}
export type PanelSurface = Extract<Surface, "agents" | "automations">

export type RailLocation = {
  pathname: string
}

export type PanelCollapseState = Partial<Record<PanelSurface, boolean>>

export const DEFAULT_PANEL_COLLAPSE: PanelCollapseState = { agents: false, automations: false }

// Per-surface "user pinned" bit: set when the user manually expands a panel
// while a terminal pane holds focus. A pinned panel is exempt from
// terminal-focus auto-collapse until focus leaves the terminal and returns
// (see releasePanelPin). Deliberately session-local, NOT persisted: the pin's
// releasing tenure (terminalFocusTenure in nav-rail.tsx) is a module-level
// flag that resets on every launch, so a persisted pin would survive restart
// with no tenure left to release it and suppress the first auto-collapse.
export type PanelPinState = Partial<Record<PanelSurface, boolean>>

export const DEFAULT_PANEL_PIN: PanelPinState = { agents: false, automations: false }

// Earlier builds persisted session-local and retired surface state. Retain
// only the durable collapse bits so obsolete data cannot survive hydration.
export function migrateNavRailState(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const collapsed = (value as { collapsed?: unknown }).collapsed
  if (!collapsed || typeof collapsed !== "object" || Array.isArray(collapsed)) return {}
  const automations = (collapsed as { automations?: unknown }).automations
  return {
    collapsed: {
      agents: (collapsed as { agents?: unknown }).agents === true,
      ...(typeof automations === "boolean" ? { automations } : {}),
    },
  }
}

export type PanelState = {
  collapsed: PanelCollapseState
  pinned: PanelPinState
}

export function surfaceHref(surface: Surface): string {
  if (surface === "lobby") return "/lobby"
  if (surface === "replay") return "/replay"
  if (surface === "automations") return "/automations"
  if (surface === "home") return "/home"
  if (surface === "extend") return "/extend/catalog"
  return "/"
}

export function surfaceFromLocation(location: RailLocation): Surface {
  if (location.pathname === "/home" || location.pathname.startsWith("/home/")) return "home"
  if (location.pathname === "/extend" || location.pathname.startsWith("/extend/")) return "extend"
  if (location.pathname === "/lobby" || location.pathname.startsWith("/lobby/")) return "lobby"
  if (location.pathname === "/replay" || location.pathname.startsWith("/replay/")) return "replay"
  if (
    location.pathname === "/automations" ||
    location.pathname.startsWith("/automations/") ||
    location.pathname === "/loops" ||
    location.pathname.startsWith("/loops/")
  )
    return "automations"
  return "agents"
}

// A surface's panel is present wherever its surface is shown. Since Wave 2 the
// Agents panel is shell chrome: it renders on every Agents-surface route
// (home, session, and draft), not just home.
export function panelAvailable(surface: Surface, location: RailLocation): boolean {
  if (surface !== "agents" && surface !== "automations") return false
  return surfaceFromLocation(location) === surface
}

// Session routes bind mod+\ to their own file-tree toggle (see
// use-session-commands). The shell only claims the panel shortcut where no
// route-owned panel binding competes; everywhere else on a surface the
// keybind toggles that surface's panel.
export function panelShortcutAvailable(surface: Surface, location: RailLocation): boolean {
  if (!panelAvailable(surface, location)) return false
  if (surface === "agents" && location.pathname.includes("/session/")) return false
  return true
}

export type RailClickResult = { type: "toggle" } | { type: "navigate"; href: string }

// Clicking the rail icon of the surface you are already on (with its panel
// present) toggles that panel; anything else navigates to the surface.
//
// `panelPresented` reports whether the surface's panel is actually shown at
// the current size: the Agents column is display:none below the lg viewport
// breakpoint. Below that threshold a toggle would be a silent no-op on a
// visible control, so the click navigates to the surface's home destination
// instead (Agents → "/", where the stacked narrow column lives).
export function railClick(
  target: Surface,
  location: RailLocation,
  panelPresented?: (surface: Surface) => boolean,
): RailClickResult {
  if (panelAvailable(target, location) && (panelPresented?.(target) ?? true)) return { type: "toggle" }
  return { type: "navigate", href: surfaceHref(target) }
}

export function togglePanelCollapse(state: PanelCollapseState, surface: PanelSurface): PanelCollapseState {
  return { ...state, [surface]: !state[surface] }
}

export function isAgentsHome(location: RailLocation): boolean {
  return location.pathname === "/"
}

// Home always presents the Agents panel. The panel IS most of Home's content
// (projects, search, new session); a collapse persisted from a terminal-focus
// tenure on a non-home route must not leave Home nearly empty. The
// rule: ENTERING home (launch landing on "/", or navigating there from any
// other location expands the panel; collapsing while already on home is
// respected until the next entry; every other route keeps the persisted
// collapse untouched. `from === undefined` is first
// evaluation after hydration and counts as an entry. Returns null when
// nothing should change so callers can skip the persisted write.
export function expandForHomeEntry(
  collapsed: PanelCollapseState,
  from: RailLocation | undefined,
  to: RailLocation,
): PanelCollapseState | null {
  if (!isAgentsHome(to)) return null
  if (from && isAgentsHome(from)) return null
  if (!collapsed.agents) return null
  return { ...collapsed, agents: false }
}

// Manual toggle with pin bookkeeping. Expanding a panel while a terminal pane
// holds focus pins it (auto-collapse must not fight the user); expanding
// without terminal focus, or collapsing, leaves the surface unpinned.
export function togglePanelWithPin(state: PanelState, surface: PanelSurface, terminalFocusHeld: boolean): PanelState {
  const collapsed = togglePanelCollapse(state.collapsed, surface)
  const expanded = !collapsed[surface]
  return {
    collapsed,
    pinned: { ...state.pinned, [surface]: expanded && terminalFocusHeld },
  }
}

// A terminal pane taking focus collapses the Agents panel — once per focus
// transition (an already-collapsed panel is a no-op) and never against a pin.
// Returns null when nothing should change so callers can skip the persisted
// write.
export function collapseForTerminalFocus(state: PanelState): PanelCollapseState | null {
  if (state.pinned.agents) return null
  if (state.collapsed.agents) return null
  return { ...state.collapsed, agents: true }
}

// Focus left the terminal: the pin has served its purpose. The next focus
// transition may auto-collapse again. Returns the same reference when the
// surface was not pinned so callers can skip the persisted write.
export function releasePanelPin(pinned: PanelPinState, surface: PanelSurface): PanelPinState {
  if (!pinned[surface]) return pinned
  return { ...pinned, [surface]: false }
}

// Focus-tenure tracking for the pin. A tenure begins when focus enters a
// terminal pane, survives excursions into shell chrome (rail clicks, panel
// rows — clicking chrome is part of operating the panel, not moving away to
// work elsewhere), and ends when focus lands anywhere else.
export type TerminalFocusZone = "terminal" | "chrome" | "outside"

// The whole terminal panel counts as the terminal zone — the xterm pane
// ([data-component="terminal"]) plus the panel's own chrome (#terminal-panel:
// tab strip, "+" button, resize handle in pages/session/terminal-panel-v2).
// Clicking panel chrome is operating the terminal, not moving away to work
// elsewhere; if chrome classified as "outside", a "+" click would end the
// tenure, release the user's pin, and let the follow-up terminal.new focus
// request collapse a panel the user explicitly pinned.
export const TERMINAL_PANE_SELECTOR = '[data-component="terminal"], #terminal-panel'
export const SHELL_CHROME_SELECTOR = '[data-component="nav-rail"], [data-component="home-left-nav"]'

export function focusZone(target: unknown): TerminalFocusZone {
  const el = target as Element | null
  if (!el || typeof el.closest !== "function") return "outside"
  if (el.closest(TERMINAL_PANE_SELECTOR)) return "terminal"
  if (el.closest(SHELL_CHROME_SELECTOR)) return "chrome"
  return "outside"
}

export function nextTerminalFocusTenure(held: boolean, zone: TerminalFocusZone): boolean {
  if (zone === "terminal") return true
  if (zone === "chrome") return held
  return false
}

// Status spine: number of agent sessions currently doing work, summed across
// every connected server, matching what the Agents panel actually lists
// (pages/home.tsx): root sessions only, never the hidden CLI sessions owned
// by embedded terminal panels. `info` joins a status entry against the session
// info in the same sync store; entries whose info has not been resolved yet
// are still counted — running work must not vanish from the spine just
// because the info cache is cold.
export type RunningAgentSessionInfo = {
  parentID?: string
  metadata?: Record<string, unknown>
}

export type RunningAgentServer = {
  status: Record<string, { type: string } | undefined>
  info?: (sessionID: string) => RunningAgentSessionInfo | undefined
}

export function countRunningAgents(servers: ReadonlyArray<RunningAgentServer>): number {
  let running = 0
  for (const server of servers) {
    for (const [sessionID, status] of Object.entries(server.status)) {
      if (!status || status.type === "idle") continue
      const info = server.info?.(sessionID)
      // Sub-agent work surfaces through its root session in the panel.
      if (info?.parentID) continue
      running++
    }
  }
  return running
}
