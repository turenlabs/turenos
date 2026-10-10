import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import type { Mentions } from "./mentions"
import type { ModelVariants } from "./model-variants"
import type { Models } from "./models"
import type { Connection, Session } from "./server"
import type { SlashCommands } from "./slash"
import type { DashboardState } from "./state"
import type { LaunchStore } from "./launch/context"
import { openLaunch } from "./launch/open"

export function createLaunch(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
  openSession: (id: string, inspect?: boolean, session?: Session) => void,
  models: Models,
  slash: SlashCommands,
  variants: ModelVariants,
  mentions: Mentions,
) {
  const store: LaunchStore = {}
  const deps = { renderer, state, connection, dialogs, say, openSession, models, slash, variants, mentions }

  function open() {
    openLaunch(deps, store, open)
  }

  return {
    open,
    get hasDraft() {
      return !!store.draft
    },
  }
}
