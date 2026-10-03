import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "../dialogs"
import type { Connection } from "../server"
import type { DashboardState } from "../state"

export type Field = { id: string; label: string; required: boolean }

export type Contribution = {
  type: string
  id: string
  name: string
  description: string
  secrets: Field[]
  configuration: Field[]
  authentication?: string
}

export type Extension = {
  id: string
  name: string
  description: string
  enabled: boolean
  mutable: boolean
  status: string
  detail?: string
  contributions: Contribution[]
  secretsSet: Record<string, boolean>
  configurationSet: Record<string, boolean>
}

export type ExtensionsContext = {
  renderer: CliRenderer
  state: DashboardState
  connection: Connection
  dialogs: Dialogs
  directory: () => string
}
