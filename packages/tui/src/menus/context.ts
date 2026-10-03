import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "../dialogs"
import type { Connection, Session } from "../server"
import type { DashboardState } from "../state"

export type MenuActions = {
  launch: () => void
  openSession: (id: string, inspect?: boolean, session?: Session) => void
  hasDraft: (id: string) => boolean
}

/** What every menu dialog needs from the dashboard. */
export type MenuContext = {
  renderer: CliRenderer
  state: DashboardState
  dialogs: Dialogs
  connection: Connection
  actions: MenuActions
}
