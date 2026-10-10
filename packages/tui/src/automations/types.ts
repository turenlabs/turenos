import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "../dialogs"
import type { Connection, Session, Snapshot } from "../server"
import type { DashboardState } from "../state"

export type Loop = Snapshot["loops"][number]

export type AutomationsContext = {
  renderer: CliRenderer
  state: DashboardState
  connection: Connection
  dialogs: Dialogs
  say: (message: string, error?: boolean) => void
  openSession: (id: string, inspect?: boolean, session?: Session) => void
}
