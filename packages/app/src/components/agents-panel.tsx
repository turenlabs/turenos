// Shell mount for the Agents panel (Wave 2 of the nav revamp, see
// .interface-design/system.md). The panel itself — markup, data attributes,
// collapse behavior — is AgentsProjectColumn in pages/home.tsx; this wrapper
// only decides where it exists: on every Agents-surface route (home, session,
// and draft). Collapse state stays in the
// nav rail's persisted `nav.rail.v1` store and auto-collapse on terminal
// focus is wired in components/nav-rail.tsx.

import { Show, Suspense } from "solid-js"
import { useNavRail } from "@/components/nav-rail"
import { AgentsProjectColumn } from "@/pages/home"

export function AgentsPanel() {
  const nav = useNavRail()

  return (
    <Show when={nav.surface() === "agents"}>
      <Suspense>
        <AgentsProjectColumn desktop />
      </Suspense>
    </Show>
  )
}
