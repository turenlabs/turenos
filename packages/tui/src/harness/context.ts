import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "../dialogs"
import type { Connection } from "../server"
import type { DashboardState } from "../state"

export type HarnessContext = {
  renderer: CliRenderer
  state: DashboardState
  connection: Connection
  dialogs: Dialogs
  say: (message: string, error?: boolean) => void
  blocked: (id: string) => boolean
}
