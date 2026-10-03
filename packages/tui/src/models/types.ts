import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "../dialogs"
import type { Connection, Session } from "../server"
import type { DashboardState } from "../state"

export type ModelTarget = {
  directory: string
  current: string
  recipient?: Session
  choose: (model: string) => Promise<void> | void
  cancel?: () => void
}

/** What the model picker and its session actions share. */
export type ModelsContext = {
  renderer: CliRenderer
  state: DashboardState
  connection: Connection
  dialogs: Dialogs
  say: (message: string, error?: boolean) => void
  onUpdate: (session: Session) => void
  blocked: (sessionID: string) => boolean
  /** Opens provider setup for a directory, returning to `back` when it closes. */
  connectProvider: (directory: string, back: () => void) => void
}
