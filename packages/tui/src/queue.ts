import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import { type Drafts } from "./queue/dock"
import { openQueue } from "./queue/open"
import type { Connection } from "./server"
import type { DashboardState } from "./state"

export { waiting } from "./queue/inputs"

/**
 * The desktop's queued follow-up dock: a queued message can be delivered now, taken back into the
 * reply editor, or discarded before the agent reads it.
 */
export function createQueueControls(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
  drafts: Drafts,
) {
  const ctx = { renderer, state, connection, dialogs, say, drafts }
  return { open: () => openQueue(ctx) }
}
