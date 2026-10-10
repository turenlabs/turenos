import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import type { Connection, Session } from "./server"
import type { DashboardState } from "./state"
import { archiveSession } from "./session-actions/archive"
import type { SessionActionsContext } from "./session-actions/context"
import { deleteSession } from "./session-actions/delete"
import { openParentSession } from "./session-actions/parent"
import { renameSession } from "./session-actions/rename"
import { openTasks } from "./session-actions/tasks"

export { todoProgress } from "./session-actions/todos"

export function createSessionActions(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
  openSession: (id: string, inspect?: boolean, session?: Session) => void,
  onUpdate: (session: Session) => void = () => {},
  onDelete: (sessionID: string) => void = () => {},
) {
  const ctx: SessionActionsContext = { renderer, state, connection, dialogs, say, openSession, onUpdate, onDelete }
  return {
    rename: () => renameSession(ctx),
    archive: () => archiveSession(ctx),
    remove: () => deleteSession(ctx),
    tasks: () => openTasks(ctx),
    parent: () => openParentSession(ctx),
  }
}
