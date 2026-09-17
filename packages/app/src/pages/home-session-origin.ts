import type { Session } from "@turenlabs/sdk/v2/client"

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
