import type { SessionGoalInfo } from "@turenlabs/sdk/v2/client"

export const SESSION_GOAL_OBJECTIVE_MAX_LENGTH = 4_000

export type { SessionGoalInfo }
export type SessionGoalStatus = SessionGoalInfo["status"]

export type SessionGoalCommand =
  | { type: "toggle" }
  | { type: "edit" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "clear" }
  | { type: "set"; objective: string }

export function parseSessionGoalCommand(text: string): SessionGoalCommand | undefined {
  const match = text.match(/^\s*\/goal(?:\s+([\s\S]*))?\s*$/i)
  if (!match) return
  const value = match[1]?.trim() ?? ""
  if (!value) return { type: "toggle" }
  if (value === "edit") return { type: "edit" }
  if (value === "pause") return { type: "pause" }
  if (value === "resume") return { type: "resume" }
  if (value === "clear") return { type: "clear" }
  return { type: "set", objective: value }
}

export function resolveSessionGoalSubmission(text: string, goalMode: boolean) {
  const command = parseSessionGoalCommand(text)
  if (command) return command
  if (!goalMode) return
  return { type: "set", objective: text.trim() } as const
}

export function sessionGoalSubmissionMutation(goal: SessionGoalInfo | undefined) {
  if (goal && goal.status !== "complete") return "edit" as const
  return "start" as const
}

export function sessionGoalObjectiveError(objective: string) {
  const value = objective.trim()
  if (!value) return "required" as const
  if (value.length > SESSION_GOAL_OBJECTIVE_MAX_LENGTH) return "tooLong" as const
}

export function sessionGoalStatusLabel(status: SessionGoalStatus) {
  if (status === "active") return "session.goal.status.active" as const
  if (status === "paused") return "session.goal.status.paused" as const
  if (status === "blocked") return "session.goal.status.blocked" as const
  if (status === "usageLimited") return "session.goal.status.usageLimited" as const
  return "session.goal.status.complete" as const
}

/**
 * Tone for the dock's left rule (see packages/ui/src/components/rule.css).
 * A goal that is running reads as live; one that has stopped for a reason the
 * user has to resolve reads as a warning; anything else stays structural.
 */
export function sessionGoalRuleTone(status: SessionGoalStatus) {
  if (status === "active") return "info" as const
  if (status === "blocked") return "error" as const
  if (status === "usageLimited") return "warning" as const
  if (status === "complete") return "success" as const
  return "muted" as const
}

export function sessionGoalElapsedSeconds(goal: SessionGoalInfo) {
  return goal.timeUsedSeconds
}

/**
 * The server only checkpoints `timeUsedSeconds` periodically, so rendering it directly leaves the
 * counter frozen for ~30s at a time. While the goal is actively running we add the wall-clock time
 * since we last saw the value change, which keeps the display moving without inventing accounting:
 * the moment the server checkpoints, `timeUsedSeconds` jumps to the authoritative figure and the
 * local offset resets. Only `active` ticks — a paused or finished goal is not accruing time.
 */
export function sessionGoalIsAccruing(goal: SessionGoalInfo) {
  return goal.status === "active"
}

export function sessionGoalDisplayedSeconds(goal: SessionGoalInfo, observedAtMillis: number, nowMillis: number) {
  const base = sessionGoalElapsedSeconds(goal)
  if (!sessionGoalIsAccruing(goal)) return base
  return base + Math.max(0, (nowMillis - observedAtMillis) / 1000)
}

export function formatSessionGoalDuration(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds))
  if (whole < 60) return `${whole}s`
  const minutes = Math.floor(whole / 60)
  if (minutes < 60) return `${minutes}m ${whole % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export function applySessionGoalSnapshot(current: SessionGoalInfo | undefined, next: SessionGoalInfo | undefined) {
  if (!next) return undefined
  if (!current || current.id !== next.id) return next
  if (next.revision < current.revision) return current
  return next
}

export function clearSessionGoalSnapshot(
  current: SessionGoalInfo | undefined,
  input: { goalID: string; revision: number },
) {
  if (!current) return
  if (current.id !== input.goalID) return current
  if (current.revision > input.revision) return current
}
