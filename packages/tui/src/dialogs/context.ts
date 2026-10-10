import type { CliRenderer } from "@opentui/core"
import type { DashboardState } from "../state"
import type { DashboardLayout } from "../layout"

export type DialogHooks = {
  rememberPosition: () => void
  cancelPosition: () => void
  changed: (reload: boolean) => void
  submitted: () => Promise<void>
  say: (message: string, error?: boolean) => void
  /** The session's own prompts, newest first. */
  recall?: () => string[]
}

export type DialogContext = {
  renderer: CliRenderer
  state: DashboardState
  ui: DashboardLayout
  hooks: DialogHooks
}
