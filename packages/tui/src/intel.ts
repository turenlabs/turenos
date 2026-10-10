import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import { openIntel } from "./intel/open"
import type { Connection } from "./server"
import type { DashboardState } from "./state"

/**
 * The desktop Home's threat intelligence: advisories, CISA's known-exploited list, and security
 * news that the server polls from its feeds. m switches lists, [ and ] page, f manages feeds.
 */
export function createIntel(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
) {
  const ctx = { renderer, state, connection, dialogs, say, memory: new Map<string, number>() }
  return { open: () => openIntel(ctx) }
}
