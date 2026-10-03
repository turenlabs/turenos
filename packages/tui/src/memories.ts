import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import { openWings } from "./memories/wings"
import type { Connection } from "./server"
import type { DashboardState } from "./state"

/**
 * The desktop's memory manager: durable notes agents recall across sessions, grouped into wings
 * (a project or a person) and rooms (a topic). Add, edit, and delete are yours; agents write too.
 */
export function createMemories(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
) {
  const ctx = { renderer, state, connection, dialogs, say }
  return { open: (back?: () => void) => openWings(ctx, back) }
}
