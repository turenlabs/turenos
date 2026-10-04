import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import type { Connection } from "./server"
import type { DashboardState } from "./state"
import type { GoalEnv } from "./goal-controls/context"
import { overview } from "./goal-controls/overview"

export function createGoalControls(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
  blocked: (id: string) => boolean,
) {
  const env: GoalEnv = { renderer, state, connection, dialogs, say, blocked, drafts: new Map() }
  return {
    open() {
      const selected =
        state.tab === "sessions" ? state.snapshot?.sessions.find((item) => item.id === state.selected) : undefined
      if (!selected) return say("Select a created session first.", true)
      if (state.closed || !dialogs.navigate()) return
      if (!state.connected) return say("Reconnect before opening Goal.", true)
      overview(env, structuredClone(selected))
    },
  }
}
