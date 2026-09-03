export * as SessionStatus from "./status"

import { randomUUID } from "crypto"
import { Effect } from "effect"
import { and, eq, sql } from "drizzle-orm"
import type { Database } from "../database/database"
import type { SessionEvent } from "./event"
import type { SessionSchema } from "./schema"
import { SessionTable } from "./sql"

/**
 * Durable Session run status.
 *
 * The run coordinator's `Map` answers "is a drain running in *this* process
 * right now", which is a different question from "what is this Session doing" --
 * it is empty one millisecond after a restart, and it is invisible to anybody
 * who is not inside the process. Shared sessions need the second question
 * answered from storage, so the projector maintains these columns off the same
 * durable events the transcript is built from, and every reader gets the same
 * answer.
 *
 * `retry` is the state this exists for: a turn waiting on a rate limit has no
 * transcript output at all, so without a durable mark a second viewer sees a
 * session that looks stalled.
 */
export type Type = "idle" | "busy" | "retry" | "interrupted" | "failed"

export type Info =
  | { readonly type: "idle" }
  | { readonly type: "busy" }
  | { readonly type: "interrupted"; readonly message?: string }
  | { readonly type: "failed"; readonly message?: string }
  | {
      readonly type: "retry"
      readonly attempt: number
      readonly message: string
      /** Absolute epoch-millisecond deadline, matching V1's `SessionStatusEvent` retry shape. */
      readonly next: number
      readonly action?: SessionEvent.RetryAction
    }

/**
 * Identity of this TurenOS process.
 *
 * A `busy` or `retry` row stamped with a different owner was written by a
 * process that is no longer running: its drain died with it, so the row records
 * what happened but must not be reported as live work. Recovery clears it; until
 * then it is readable history rather than a stuck spinner.
 */
export const owner = `proc_${randomUUID()}`

type DatabaseService = Database.Interface["db"]

const clearedRetry = {
  status_attempt: null,
  status_message: null,
  status_next: null,
  status_action: null,
} as const

/**
 * `time_compacting` is the "this session is summarising itself right now" mark, set by the
 * `Compaction.Started` projection and cleared by `Compaction.Ended`/`Compaction.Failed` or the next
 * `Step.Started`. None of those fire when a turn is interrupted *inside* the summarization request:
 * the compaction never ends, no further step starts, and the session is left durably pinned as
 * compacting until a restart runs `V2Session.recover`. Any terminal status is the end of the turn
 * the compaction belonged to, so it is also the honest moment to drop the mark -- same reasoning as
 * `clearedRetry`, which exists because a countdown must not outlive the attempt that scheduled it.
 *
 * Only spread on a terminal status: `Compaction.Started` sets the mark and immediately writes
 * `busy` through this function, so an unconditional null would erase it one statement later.
 */
const clearedCompaction = { time_compacting: null } as const

export const set = (db: DatabaseService, sessionID: SessionSchema.ID, status: Info) => {
  const terminal = status.type === "idle" || status.type === "interrupted" || status.type === "failed"
  return db
    .update(SessionTable)
    .set({
      status: status.type,
      // Ownership only means something while work is outstanding. Clearing it on a terminal status
      // keeps `status_owner === SessionStatus.owner` a reliable test for "this process still owes
      // an answer" rather than a fact about who happened to write last.
      status_owner: terminal ? null : owner,
      // Explicit nulls, not undefined: drizzle drops undefined columns from an UPDATE SET, so
      // leaving them out would strand the previous attempt's countdown on an idle session.
      ...clearedRetry,
      ...(terminal ? clearedCompaction : {}),
      ...(status.type === "retry"
        ? {
            status_attempt: status.attempt,
            status_message: status.message,
            status_next: status.next,
            status_action: status.action ?? null,
          }
        : {}),
      ...(status.type === "interrupted" || status.type === "failed" ? { status_message: status.message ?? null } : {}),
      // Written back to itself so the column's `$onUpdate` default cannot fire: a status change is
      // agent bookkeeping, not a session edit, and must not reorder the session list -- the same
      // reason `setCompacting` and `applyUsage` do it.
      time_updated: sql`${SessionTable.time_updated}`,
    })
    .where(eq(SessionTable.id, sessionID))
    .run()
    .pipe(Effect.orDie, Effect.asVoid)
}

/** Clears only the retry claim still owned by this process. */
export const clearOwnedRetry = (db: DatabaseService, sessionID: SessionSchema.ID) =>
  db
    .update(SessionTable)
    .set({
      status: "idle",
      status_owner: null,
      ...clearedRetry,
      // Idle is terminal here too: a summarization request abandoned mid-backoff would otherwise
      // leave the same orphaned compaction mark `set` clears above.
      ...clearedCompaction,
      time_updated: sql`${SessionTable.time_updated}`,
    })
    .where(and(eq(SessionTable.id, sessionID), eq(SessionTable.status, "retry"), eq(SessionTable.status_owner, owner)))
    .run()
    .pipe(Effect.orDie, Effect.asVoid)

export const fromRow = (row: {
  readonly status: string | null
  readonly status_owner: string | null
  readonly status_attempt: number | null
  readonly status_message: string | null
  readonly status_next: number | null
  readonly status_action: SessionEvent.RetryAction | null
}): Info => {
  switch (row.status) {
    case "busy":
      return { type: "busy" }
    case "retry":
      return {
        type: "retry",
        attempt: row.status_attempt ?? 1,
        message: row.status_message ?? "",
        next: row.status_next ?? 0,
        ...(row.status_action ? { action: row.status_action } : {}),
      }
    case "interrupted":
      return { type: "interrupted", ...(row.status_message ? { message: row.status_message } : {}) }
    case "failed":
      return { type: "failed", ...(row.status_message ? { message: row.status_message } : {}) }
    default:
      return { type: "idle" }
  }
}

/** True when this process wrote the status and still owes it a settlement. */
export const isOwned = (row: { readonly status: string | null; readonly status_owner: string | null }) =>
  row.status_owner === owner && (row.status === "busy" || row.status === "retry")
