import type { Session } from "@turenlabs/sdk/v2/client"
import type { SessionNavStatus } from "./layout/session-nav-state"

/**
 * Sessions an Automation started, rather than ones you opened yourself.
 *
 * The scheduler names them: a run with no session yet gets
 * `ses_loop_<runID>` (packages/forge/src/loop/scheduler.ts), and records that
 * id so later runs of the same Automation reuse it. The prefix is ours, not a
 * convention borrowed from anything outside the app, so classifying on it is
 * safe — but it is a classification, not an identity, and the session's own id
 * remains whatever the scheduler assigned.
 */
export const AUTOMATION_SESSION_PREFIX = "ses_loop_"

export type HomeSessionOrigin = "manual" | "automation"
export type HomeSessionFocusStatus = "attention" | "working" | "unread"

export function sessionOrigin(session: Pick<Session, "id">): HomeSessionOrigin {
  if (session.id.startsWith(AUTOMATION_SESSION_PREFIX)) return "automation"
  return "manual"
}

export function sessionOriginLabel(origin: HomeSessionOrigin) {
  switch (origin) {
    case "automation":
      return "Workflow"
    case "manual":
      return "Manual"
  }
}

export function homeSessionFocusGroup(input: {
  origin: HomeSessionOrigin
  status: HomeSessionFocusStatus
  selectedProject: boolean
  pinned: boolean
}) {
  if (input.pinned) return
  if (input.status === "attention") return "attention" as const
  if (input.origin !== "manual") return
  if (input.status === "working") return "working" as const
  if (!input.selectedProject && input.status === "unread") return "unread" as const
}

export function prioritizeHomeSessionRecords<T>(records: readonly T[], priority: (record: T) => number, limit: number) {
  return records
    .map((record, index) => ({ record, index, priority: priority(record) }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .slice(0, limit)
    .map((item) => item.record)
}

export function recentHomeSessionRecords<T extends { session: Pick<Session, "time"> }>(
  records: readonly T[],
  limit: number,
) {
  return records
    .slice()
    .sort(
      (a, b) => (b.session.time.updated ?? b.session.time.created) - (a.session.time.updated ?? a.session.time.created),
    )
    .slice(0, limit)
}

export function isAutomationSession(session: Pick<Session, "id">) {
  return sessionOrigin(session) === "automation"
}

export function recentlyFinishedHomeSessions<T extends { session: Pick<Session, "id" | "parentID" | "time"> }>(
  records: readonly T[],
  statuses: ReadonlyMap<string, SessionNavStatus>,
  now: number,
  windowMs = 7 * 24 * 60 * 60 * 1000,
) {
  return records.filter((record) => {
    const session = record.session
    if (session.parentID || sessionOrigin(session) !== "manual") return false
    if (statuses.get(session.id) !== "settled") return false
    const updated = session.time.updated ?? session.time.created
    return now - updated >= 0 && now - updated < windowMs
  })
}

/** Splits a project's sessions into personal work and workflows. */
export function partitionBySessionOrigin<T extends { session: Pick<Session, "id"> }>(records: readonly T[]) {
  const manual: T[] = []
  const automation: T[] = []
  for (const record of records) {
    const origin = sessionOrigin(record.session)
    if (origin === "manual") manual.push(record)
    else automation.push(record)
  }
  return { manual, automation }
}
