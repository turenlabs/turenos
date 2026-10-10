import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "../dialogs"
import type { Connection, Session } from "../server"
import type { DashboardState } from "../state"

export type ModelTarget = {
  directory: string
  current: string
  recipient?: Session
  /** What the choice is for, when it is not a launch draft's model. */
  note?: string
  choose: (model: string) => Promise<void> | void
  cancel?: () => void
}

export type ModelRef = { providerID: string; modelID: string }

/** What the picker remembers for the life of this process; nothing here is stored. */
export type ModelMemory = {
  /** Most recently chosen first. */
  recent: ModelRef[]
  /** Whether the picker also lists models outside the latest set. */
  showAll: boolean
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
  memory: ModelMemory
  /** Opens provider setup for a directory, returning to `back` when it closes. */
  connectProvider: (directory: string, back: () => void) => void
}
