// Persistent 52px navigation rail — the thin shell between product surfaces
// (Agents and Analysis) decided in .interface-design/system.md. The rail never
// collapses; per-surface panels do. It reads feature status only through the
// narrow Agents accessor on `status` and owns no feature internals.

import { batch, createEffect, createMemo, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { useLocation, useNavigate } from "@solidjs/router"
import { createSimpleContext } from "@turenlabs/ui/context"
import { Icon as IconV2 } from "@turenlabs/ui/v2/icon"
import { TooltipV2 } from "@turenlabs/ui/v2/tooltip-v2"
import { useCommand } from "@/context/command"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ServerConnection, useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { useSettingsDialog } from "@/components/settings-dialog"
import { useSettings } from "@/context/settings"
import { ServerHealthIndicator } from "@/components/server/server-row"
import { Persist, persisted } from "@/utils/persist"
import { onTerminalFocusRequest } from "@/context/terminal"
import {
  collapseForTerminalFocus,
  countRunningAgents,
  DEFAULT_PANEL_COLLAPSE,
  DEFAULT_PANEL_PIN,
  expandForHomeEntry,
  focusZone,
  nextTerminalFocusTenure,
  panelShortcutAvailable,
  railClick,
  releasePanelPin,
  migrateNavRailState,
  surfaceFromLocation,
  surfaceEnabled,
  surfaceHref,
  togglePanelWithPin,
  type RailLocation,
  type PanelSurface,
  type Surface,
} from "@/components/nav-rail-state"
import { ProductLinks } from "@/product-links"


const RAIL_ITEM =
  "relative flex size-9 shrink-0 cursor-default items-center justify-center rounded-[8px] border-0 bg-transparent text-v2-icon-icon-muted outline-none transition-[background-color,color,box-shadow] duration-[120ms] ease-in-out hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:[box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-focus)]"
const RAIL_ITEM_ACTIVE =
  "bg-v2-background-bg-layer-02 text-v2-text-text-base [box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)] hover:bg-v2-background-bg-layer-02"

export const { use: useNavRail, provider: NavRailProvider } = createSimpleContext({
  name: "NavRail",
  gate: false,
  init: () => {
    const command = useCommand()
    const global = useGlobal()
    const settings = useSettings()
    const language = useLanguage()
    const location = useLocation()
    const navigate = useNavigate()
    const tabs = useTabs()

    // The migration keeps only the durable panel collapse bits. Session-local
    // pins reset on launch, and obsolete surface fields must not rehydrate.
    const [store, setStore, _init, storeReady] = persisted(
      { ...Persist.global("nav.rail.v1"), migrate: migrateNavRailState },
      createStore({ collapsed: { ...DEFAULT_PANEL_COLLAPSE } }),
    )
    const [pinned, setPinned] = createStore({ ...DEFAULT_PANEL_PIN })

    const loc = createMemo<RailLocation>(() => ({ pathname: location.pathname }))
    const surface = createMemo(() => surfaceFromLocation(loc()))

    // Home always presents the Agents panel (rule in expandForHomeEntry):
    // entering "/" clears a persisted agents collapse — e.g. one left behind
    // by terminal-focus auto-collapse on a session route — while collapsing
    // ON home sticks until the next entry, and other routes keep the
    // persisted state. Gated on hydration: the desktop store resolves
    // asynchronously and the entry decision must judge the persisted
    // collapse, not the pre-hydration default. Expansion writes `collapsed`
    // only — it is shell presentation, never a user pin.
    let homeEntryFrom: RailLocation | undefined
    createEffect(() => {
      if (!storeReady()) return
      const to = loc()
      const next = expandForHomeEntry(store.collapsed, homeEntryFrom, to)
      homeEntryFrom = to
      if (next) setStore("collapsed", next)
    })

    const status = {
      agents: createMemo(() => ({
        // The status map joins against the session-info cache in the SAME
        // sync store so terminal-owned and sub-agent sessions (which the
        // Agents panel never lists) stay out of the badge. Both reads happen
        // inside this memo, so late-resolving info re-runs the count.
        running: countRunningAgents(
          global.servers.list().flatMap((conn) => {
            if (global.servers.health[ServerConnection.key(conn)]?.healthy !== true) return []
            const session = global.ensureServerCtx(conn).sync.session
            return [
              {
                status: session.data.session_status,
                info: (sessionID: string) => session.data.info[sessionID],
              },
            ]
          }),
        ),
      })),
    }

    // Terminal-focus tenure (Wave 2 auto-collapse): true from the moment a
    // terminal pane takes focus until focus lands outside both the terminal
    // and shell chrome. Manual expands during a tenure pin the panel; the pin
    // is released when the tenure ends so the next focus transition may
    // auto-collapse again. Deliberately not reactive state — it only feeds
    // event handlers.
    let terminalFocusTenure = false

    onCleanup(
      onTerminalFocusRequest(() => {
        terminalFocusTenure = true
        const next = collapseForTerminalFocus({ collapsed: store.collapsed, pinned })
        if (next) setStore("collapsed", next)
      }),
    )

    if (typeof document !== "undefined") {
      makeEventListener(document, "focusin", (event) => {
        const held = nextTerminalFocusTenure(terminalFocusTenure, focusZone(event.target))
        if (terminalFocusTenure && !held) setPinned((prev) => releasePanelPin(prev, "agents"))
        terminalFocusTenure = held
      })
    }

    const toggle = (target?: PanelSurface) => {
      const next = togglePanelWithPin({ collapsed: store.collapsed, pinned }, target ?? "agents", terminalFocusTenure)
      batch(() => {
        setStore("collapsed", next.collapsed)
        setPinned(next.pinned)
      })
    }

    const open = (target: Surface) => {
      if (target === "agents") {
        tabs.toggleHome({ home: true })
        return
      }
      // Entering Automations always presents its left navigation. A collapsed
      // panel remains collapsed while staying on the surface, but an inactive
      // rail click is an explicit request to enter and show it.
      if (target === "automations" && store.collapsed.automations) setStore("collapsed", "automations", false)
      navigate(surfaceHref(target))
    }

    // Whether the target panel is actually presented at the current size,
    // read from the live DOM at click time rather than duplicating its CSS
    // breakpoint. Only consulted inside the click handler. Automations uses
    // its list panel selector because its narrow layout keeps that panel in
    // the document as a stacked column.
    const panelPresented = (target: Surface): boolean => {
      if (typeof document === "undefined") return true
      const selector =
        target === "agents" ? '[data-component="home-left-nav"]' : '[data-component="automations-left-nav"]'
      const panel = document.querySelector(selector)
      return !!panel && getComputedStyle(panel).display !== "none"
    }

    const click = (target: Surface) => {
      const result = railClick(target, loc(), panelPresented)
      if (result.type === "toggle") {
        if (target === "agents" || target === "automations") toggle(target)
        return
      }
      // On narrow Agents layouts the panel is hidden, so the active-surface
      // click must open the stacked navigation at "/" rather than restore the
      // session the user is already viewing.
      if (target === "agents" && surface() === "agents") {
        navigate(result.href)
        return
      }
      open(target)
    }

    command.register("nav.rail", () => [
      {
        id: "nav.surface.home",
        title: "Go to Home",
        category: language.t("command.category.view"),
        keybind: "mod+1",
        when: () => true,
        onSelect: () => open("home"),
      },
      {
        id: "nav.surface.agents",
        title: language.t("command.nav.agents"),
        category: language.t("command.category.view"),
        keybind: "mod+2",
        // The rail owns mod+1 through mod+7 in its visible top-to-bottom order;
        // `when` wins keybind resolution over the numbered tab-switch bindings.
        when: () => true,
        onSelect: () => open("agents"),
      },
      {
        id: "nav.surface.automations",
        title: "Go to Automations",
        category: language.t("command.category.view"),
        keybind: "mod+3",
        when: () => true,
        onSelect: () => open("automations"),
      },
      {
        id: "nav.surface.extend",
        title: "Go to Extend",
        category: language.t("command.category.view"),
        keybind: "mod+4",
        when: () => true,
        onSelect: () => open("extend"),
      },
      {
        id: "nav.surface.analysis",
        title: language.t("command.nav.analysis"),
        category: language.t("command.category.view"),
        keybind: "mod+5",
        when: () => true,
        onSelect: () => open("analysis"),
      },
      {
        id: "nav.surface.replay",
        title: "Go to Traces",
        category: language.t("command.category.view"),
        keybind: "mod+6",
        when: () => true,
        onSelect: () => open("replay"),
      },
      {
        id: "nav.surface.lobby",
        title: "Go to Lobby",
        category: language.t("command.category.view"),
        keybind: "mod+7",
        when: () => surfaceEnabled("lobby", settings.general.lobbyBetaEnabled()),
        onSelect: () => open("lobby"),
      },
      {
        id: "nav.analysis.appSec",
        title: language.t("command.nav.analysis.appSec"),
        category: language.t("command.category.view"),
        onSelect: () => navigate("/analysis/appsec"),
      },
      {
        id: "nav.analysis.penTesting",
        title: language.t("command.nav.analysis.penTesting"),
        category: language.t("command.category.view"),
        onSelect: () => navigate("/analysis/pen-testing"),
      },
      {
        id: "nav.panel.toggle",
        title: language.t("command.nav.panel.toggle"),
        category: language.t("command.category.view"),
        keybind: "mod+\\",
        // The Agents panel exists on every Agents-surface route now, but
        // session routes keep their file-tree mod+\ binding — the shell only
        // claims the shortcut where no route-owned binding competes.
        disabled: !panelShortcutAvailable(surface(), loc()),
        onSelect: () => {
          const current = surface()
          if (current === "agents" || current === "automations") toggle(current)
        },
      },
    ])

    return {
      surface,
      status,
      collapsed: (target: PanelSurface) => !!store.collapsed[target],
      toggle,
      open,
      click,
    }
  },
})

export function NavRail() {
  const nav = useNavRail()
  const command = useCommand()
  const global = useGlobal()
  const language = useLanguage()
  const platform = usePlatform()
  const settings = useSettings()
  const server = useServer()
  const showSettings = useSettingsDialog()
  const showServers = useSettingsDialog("servers")

  const running = () => nav.status.agents().running
  const serverHealth = () => global.servers.health[server.key]
  const serverLabel = () => language.t("nav.rail.server", { server: server.name || server.key })

  const tooltip = (label: string, commandId?: string) => {
    if (!commandId) return label
    const keybind = command.keybind(commandId)
    return keybind ? `${label} ${keybind}` : label
  }

  // On the Agents surface the rail icon toggles the panel, so the tooltip
  // says so — a collapsed panel (terminal-focus auto-collapse) would
  // otherwise leave no visible affordance beyond an unexplained icon. No
  // keybind suffix here: mod+2 navigates rather than toggles, and mod+\ is
  // route-dependent (session routes keep it for the file tree).
  const agentsTooltip = () => {
    if (nav.surface() !== "agents") return tooltip(language.t("nav.rail.agents"), "nav.surface.agents")
    return nav.collapsed("agents") ? language.t("nav.rail.agents.showPanel") : language.t("nav.rail.agents.hidePanel")
  }

  const agentsLabel = () => {
    if (nav.surface() === "agents") return agentsTooltip()
    if (running() > 0)
      return `${language.t("nav.rail.agents")} — ${language.t("nav.rail.agents.running", { count: running() })}`
    return language.t("nav.rail.agents")
  }

  return (
    <nav
      data-component="nav-rail"
      aria-label={language.t("nav.rail.label")}
      class="flex h-full w-[52px] shrink-0 flex-col items-center justify-between gap-2 py-2 select-none"
    >
      <div class="flex min-h-0 flex-col items-center gap-1">
        <TooltipV2 placement="right" value={tooltip("Home", "nav.surface.home")}>
          <button
            type="button"
            data-action="nav-rail-home"
            class={RAIL_ITEM}
            classList={{ [RAIL_ITEM_ACTIVE]: nav.surface() === "home" }}
            aria-current={nav.surface() === "home" ? "page" : undefined}
            aria-label="Home"
            onClick={() => nav.click("home")}
          >
            <IconV2 name="home" />
          </button>
        </TooltipV2>
        <TooltipV2 placement="right" value={agentsTooltip()}>
          <button
            type="button"
            data-action="nav-rail-agents"
            class={RAIL_ITEM}
            classList={{ [RAIL_ITEM_ACTIVE]: nav.surface() === "agents" }}
            aria-current={nav.surface() === "agents" ? "page" : undefined}
            aria-label={agentsLabel()}
            aria-expanded={nav.surface() === "agents" ? !nav.collapsed("agents") : undefined}
            onClick={() => nav.click("agents")}
          >
            <IconV2 name="terminal" />
            <Show when={running() > 0}>
              <span
                data-slot="nav-rail-agents-running"
                aria-hidden="true"
                class="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-v2-state-bg-success px-1 text-[9px] leading-none text-v2-state-fg-success [font-weight:650] [box-shadow:inset_0_0_0_0.5px_var(--v2-state-border-success)]"
              >
                {running() > 9 ? "9+" : running()}
              </span>
            </Show>
          </button>
        </TooltipV2>
        <TooltipV2 placement="right" value={tooltip("Automations", "nav.surface.automations")}>
          <button
            type="button"
            data-action="nav-rail-automations"
            class={RAIL_ITEM}
            classList={{ [RAIL_ITEM_ACTIVE]: nav.surface() === "automations" }}
            aria-current={nav.surface() === "automations" ? "page" : undefined}
            aria-label={
              nav.surface() === "automations"
                ? `Automations — ${nav.collapsed("automations") ? "show panel" : "hide panel"}`
                : "Automations"
            }
            aria-expanded={nav.surface() === "automations" ? !nav.collapsed("automations") : undefined}
            onClick={() => nav.click("automations")}
          >
            <IconV2 name="branch" />
          </button>
        </TooltipV2>
        <TooltipV2 placement="right" value={tooltip("Extend", "nav.surface.extend")}>
          <button
            type="button"
            data-action="nav-rail-extend"
            class={RAIL_ITEM}
            classList={{ [RAIL_ITEM_ACTIVE]: nav.surface() === "extend" }}
            aria-current={nav.surface() === "extend" ? "page" : undefined}
            aria-label="Extend"
            onClick={() => nav.click("extend")}
          >
            <IconV2 name="grid-plus" />
          </button>
        </TooltipV2>
        <TooltipV2 placement="right" value={tooltip("Traces", "nav.surface.replay")}>
          <button
            type="button"
            data-action="nav-rail-replay"
            class={RAIL_ITEM}
            classList={{ [RAIL_ITEM_ACTIVE]: nav.surface() === "replay" }}
            aria-current={nav.surface() === "replay" ? "page" : undefined}
            aria-label="Traces"
            onClick={() => nav.click("replay")}
          >
            <IconV2 name="review" />
          </button>
        </TooltipV2>
        <Show when={surfaceEnabled("lobby", settings.general.lobbyBetaEnabled())}>
          <TooltipV2 placement="right" value={tooltip("Lobby (Beta)", "nav.surface.lobby")}>
            <button
              type="button"
              data-action="nav-rail-lobby"
              class={RAIL_ITEM}
              classList={{ [RAIL_ITEM_ACTIVE]: nav.surface() === "lobby" }}
              aria-current={nav.surface() === "lobby" ? "page" : undefined}
              aria-label="Lobby (Beta)"
              onClick={() => nav.click("lobby")}
            >
              <IconV2 name="outline-share" />
            </button>
          </TooltipV2>
        </Show>
      </div>
      <div class="flex shrink-0 flex-col items-center gap-1">
        <TooltipV2 placement="right" value={language.t("nav.rail.help")}>
          <button
            type="button"
            data-action="nav-rail-help"
            class={RAIL_ITEM}
            aria-label={language.t("nav.rail.help")}
            onClick={() => platform.openLink(ProductLinks.feedback)}
          >
            <IconV2 name="help" />
          </button>
        </TooltipV2>
        <TooltipV2 placement="right" value={tooltip(language.t("nav.rail.settings"), "settings.open")}>
          <button
            type="button"
            data-action="nav-rail-settings"
            class={RAIL_ITEM}
            aria-label={language.t("nav.rail.settings")}
            onClick={showSettings}
          >
            <IconV2 name="settings-gear" />
          </button>
        </TooltipV2>
        {/* Supersedes the pre-revamp home-left-nav workspace footer button:
            the focused server's identity lives in this tooltip, its health in
            the badge, and the click opens the same Settings surface (servers
            pane) the old button led to. Multi-server identity stays visible
            in the Agents panel's server rows. */}
        <TooltipV2 placement="right" value={serverLabel()}>
          <button
            type="button"
            data-action="nav-rail-server"
            class={RAIL_ITEM}
            aria-label={serverLabel()}
            onClick={showServers}
          >
            <IconV2 name="connections" />
            <span class="absolute bottom-1 right-1 flex items-center justify-center rounded-full bg-v2-background-bg-deep p-px">
              <ServerHealthIndicator health={serverHealth()} />
            </span>
          </button>
        </TooltipV2>
      </div>
    </nav>
  )
}
