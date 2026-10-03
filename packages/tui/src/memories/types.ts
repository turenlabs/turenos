import type { CliRenderer } from "@opentui/core"
import type { MemoriesListOutput } from "@turenlabs/client"
import type { Dialogs } from "../dialogs"
import type { Connection } from "../server"
import type { DashboardState } from "../state"

export type Memory = MemoriesListOutput[number]
export type Place = { wingID: string; roomID?: string; name: string }

export type MemoriesContext = {
  renderer: CliRenderer
  state: DashboardState
  connection: Connection
  dialogs: Dialogs
  say: (message: string, error?: boolean) => void
}

export const KINDS = ["note", "fact", "decision", "observation"] as const
