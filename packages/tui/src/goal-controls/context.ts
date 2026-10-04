import type { CliRenderer } from "@opentui/core"
import type { SessionsGoalGetOutput } from "@turenlabs/client"
import type { Dialogs } from "../dialogs"
import type { Connection, Session } from "../server"
import type { DashboardState, ModalState } from "../state"

export type Goal = SessionsGoalGetOutput
export type Action = "Set" | "Edit" | "Pause" | "Resume" | "Clear"

export type GoalEnv = {
  renderer: CliRenderer
  state: DashboardState
  connection: Connection
  dialogs: Dialogs
  say: (message: string, error?: boolean) => void
  blocked: (id: string) => boolean
  /** Objective text typed into a Set or Edit confirmation, kept per session so going back does not lose it. */
  drafts: Map<string, string>
}

export function current(env: GoalEnv, session: Session, dialog?: ModalState) {
  const selected = env.state.snapshot?.sessions.find((item) => item.id === env.state.selected)
  if (env.state.closed || env.state.tab !== "sessions" || !selected || !sameSession(session, selected))
    throw new Error("Session target changed. Close and reopen Goal.")
  if (dialog && env.state.modal !== dialog) throw new Error("Goal control is no longer open.")
  if (!env.state.connected) throw new Error("Reconnect before using Goal.")
}

export async function fresh(env: GoalEnv, session: Session, dialog: ModalState) {
  current(env, session, dialog)
  const remote = await env.connection.client.sessions.get({ sessionID: session.id })
  current(env, session, dialog)
  if (!sameSession(session, remote)) throw new Error("Session identity changed. Close and reopen Goal.")
  const goal = await env.connection.client.sessions.goalGet({ sessionID: session.id })
  current(env, session, dialog)
  return { goal, remote }
}

export function sameGoal(left: Goal, right: Goal) {
  return left === null ? right === null : right !== null && left.id === right.id && left.revision === right.revision
}

function sameSession(left: Session, right: Session) {
  return (
    left.id === right.id &&
    left.projectID === right.projectID &&
    left.parentID === right.parentID &&
    left.subpath === right.subpath &&
    left.time.created === right.time.created &&
    left.location.directory === right.location.directory &&
    left.location.workspaceID === right.location.workspaceID
  )
}
