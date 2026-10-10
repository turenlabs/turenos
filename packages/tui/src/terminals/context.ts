import type { CliRenderer } from "@opentui/core"
import type { AttachTarget } from "../attach"
import type { Dialogs } from "../dialogs"
import type { Connection, Snapshot } from "../server"
import type { DashboardState } from "../state"

export type Terminal = Snapshot["terminals"][number]

/** What every terminal action needs from the dashboard. */
export type Context = {
  renderer: CliRenderer
  state: DashboardState
  connection: Connection
  dialogs: Dialogs
  say: (message: string, error?: boolean) => void
  refresh: () => Promise<void>
}

export function selected(ctx: Context) {
  const terminal =
    ctx.state.tab === "terminals"
      ? ctx.state.snapshot?.terminals.find((item) => item.id === ctx.state.selected)
      : undefined
  if (!terminal) ctx.say("Select a terminal first.")
  return terminal
}

export function target(terminal: Terminal): AttachTarget {
  return {
    id: terminal.id,
    title: terminal.title,
    directory: terminal.location.directory,
    workspace: terminal.location.workspaceID,
  }
}

/** PTYs are location-scoped: every call names the folder and workspace the PTY was opened in. */
export function where(pty: AttachTarget) {
  return { directory: pty.directory, workspace: pty.workspace }
}
