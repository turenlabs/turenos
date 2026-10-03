import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import type { Connection, Session } from "./server"
import { agent } from "./session-controls/agent"
import { compact } from "./session-controls/compact"
import type { DashboardState } from "./state"

export function createSessionControls(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
  updateRecipient: (session: Session) => void,
  replyBlocked: (sessionID: string) => boolean,
) {
  const ctx = { renderer, state, connection, dialogs, say, updateRecipient, replyBlocked }
  return { compact: () => compact(ctx), agent: () => agent(ctx) }
}

export type SessionControls = ReturnType<typeof createSessionControls>
