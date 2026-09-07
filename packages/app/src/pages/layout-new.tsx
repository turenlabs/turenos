import { createEffect, onMount, type ParentProps } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import { AgentsPanel } from "@/components/agents-panel"
import { AgentsPanelProvider } from "@/components/agents-panel-state"
import { DebugBar } from "@/components/debug-bar"
import { shouldShowDebugBar } from "@/components/debug-bar-visibility"
import { NavRail, NavRailProvider } from "@/components/nav-rail"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { setNavigate } from "@/utils/notification-click"
import { setV2Toast, ToastRegion } from "@/utils/toast"

export default function NewLayout(props: ParentProps) {
  const platform = usePlatform()
  const settings = useSettings()
  const navigate = useNavigate()
  const location = useLocation()
  setNavigate(navigate)

  // Only the initial entry redirects; returning to Agents at "/" stays there.
  onMount(() => {
    if (location.pathname === "/" && !location.search && !location.hash) navigate("/home", { replace: true })
  })

  createEffect(() => setV2Toast(true))

  const update: TitlebarUpdate = {
    version: () => {
      const state = platform.updater?.state()
      if (state?.status !== "ready") return
      return state.version
    },
    installing: () => platform.updater?.state().status === "installing",
    install: () => void platform.updater?.install(),
  }

  return (
    <NavRailProvider>
      <AgentsPanelProvider>
        <div
          class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
          style={{
            "padding-top": "env(safe-area-inset-top, 0px)",
            "padding-bottom": "env(safe-area-inset-bottom, 0px)",
          }}
        >
          <Titlebar update={update} />
          <div class="flex-1 min-h-0 min-w-0 flex flex-row items-stretch">
            <NavRail />
            {/* Agents panel as shell chrome (Wave 2): renders on every
                Agents-surface route so session views keep the
                project/session column; collapse state lives in nav.rail.v1. */}
            <AgentsPanel />
            <main class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-strict">
              {/* Route surfaces own their loading boundaries. A shell-wide Suspense lets
                  session work join Router's transition and retain the outgoing draft. */}
              {props.children}
            </main>
          </div>
          {shouldShowDebugBar(settings.general.showPerformanceDiagnostics()) && <DebugBar inline />}
          <ToastRegion v2 />
        </div>
      </AgentsPanelProvider>
    </NavRailProvider>
  )
}
