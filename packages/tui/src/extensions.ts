import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import { openExtensions } from "./extensions/list"
import type { Connection } from "./server"
import type { DashboardState } from "./state"

/**
 * The desktop's Extend page: skills, MCP servers, and data sources from the catalog or your
 * configuration. Enter turns one on or off; s and c fill in its secrets and settings; o starts an
 * MCP sign-in, which the server opens in a browser on its own computer.
 */
export function createExtensions(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  directory: () => string,
) {
  const ctx = { renderer, state, connection, dialogs, directory }
  return { open: (back?: () => void) => openExtensions(ctx, back) }
}

export type Extensions = ReturnType<typeof createExtensions>
