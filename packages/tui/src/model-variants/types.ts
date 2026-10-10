import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "../dialogs"
import type { Connection, Session } from "../server"
import type { DashboardState } from "../state"

export type Target = {
  directory: string
  model: { providerID: string; id: string }
  current?: string
  choose: (variant: string | undefined, currentOnly?: boolean) => void | Promise<void>
  cancel?: () => void
}

export type VariantsContext = {
  renderer: CliRenderer
  state: DashboardState
  connection: Connection
  dialogs: Dialogs
  say: (message: string, error?: boolean) => void
  onUpdate: (session: Session) => void
  blocked: (id: string) => boolean
}
