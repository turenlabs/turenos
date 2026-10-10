import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import { openMenu } from "./settings/menu"
import type { SettingsContext, SettingsHooks } from "./settings/shared"
import type { Connection } from "./server"
import type { DashboardState } from "./state"

/**
 * The desktop's Settings, for what a terminal client can change on the server: providers and their
 * usage, extensions, memories, agent default models, permission checks and saved rules. Every
 * section is server-global unless it says otherwise.
 */
export function createSettings(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
  hooks: SettingsHooks,
) {
  const ctx: SettingsContext = {
    renderer,
    state,
    connection,
    dialogs,
    say: (message, error) => {
      ctx.notice = error ? "" : message
      say(message, error)
    },
    hooks,
    open: () => openMenu(ctx),
    memory: new Map(),
    removed: new Set(),
    notice: "",
  }
  return {
    open() {
      // A fresh visit starts at the top; actions inside Settings reopen through ctx.open and keep the cursor.
      ctx.memory.clear()
      ctx.notice = ""
      ctx.open()
    },
  }
}
