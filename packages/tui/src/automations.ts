import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import { form, remove } from "./automations/form"
import { manage } from "./automations/manage"
import type { AutomationsContext } from "./automations/types"
import type { Connection, Session } from "./server"
import type { DashboardState } from "./state"

export { parseSchedule } from "./automations/schedule"

/**
 * The desktop's Automations page: scheduled agent prompts that run on the server. Enter manages
 * the selected automation (run now, pause or resume, edit, runs, delete); `a` adds one.
 */
export function createAutomations(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
  openSession: (id: string, inspect?: boolean, session?: Session) => void,
) {
  const ctx: AutomationsContext = { renderer, state, connection, dialogs, say, openSession }

  function selected() {
    const loop =
      state.tab === "automations" ? state.snapshot?.loops.find((item) => item.id === state.selected) : undefined
    if (!loop) say("Select an automation first.")
    return loop
  }

  return {
    manage: () => {
      const loop = selected()
      if (!loop || !dialogs.navigate()) return
      manage(ctx, loop)
    },
    create: () => form(ctx),
    edit: () => {
      const loop = selected()
      if (loop) form(ctx, loop)
    },
    remove: () => {
      const loop = selected()
      if (loop) remove(ctx, loop)
    },
  }
}
