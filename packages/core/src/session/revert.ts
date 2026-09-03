export * as SessionRevert from "./revert"

import { and, asc, eq, gt, inArray, or } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { RelativePath } from "../schema"
import { Snapshot } from "../snapshot"
import { SessionGoal } from "@turenlabs/schema/session-goal"
import { SessionEvent } from "./event"
import { SessionContextEpoch } from "./context-epoch"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import {
  SessionGoalIdentityTable,
  SessionGoalTable,
  SessionInputTable,
  SessionMessageIdentityTable,
  SessionMessageTable,
  SessionTable,
} from "./sql"
import { isWithReplicas } from "@turenlabs/effect-drizzle-sqlite"

export class MessageNotFoundError extends Schema.TaggedErrorClass<MessageNotFoundError>()(
  "Session.MessageNotFoundError",
  {
    sessionID: SessionSchema.ID,
    messageID: SessionMessage.ID,
  },
) {}

export class GoalBoundaryError extends Schema.TaggedErrorClass<GoalBoundaryError>()("SessionRevert.GoalBoundaryError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
  goalID: SessionGoal.ID,
}) {}

interface BoundaryInput {
  readonly sessionID: SessionSchema.ID
  readonly messageID: SessionMessage.ID
}

const plan = Effect.fn("SessionRevert.plan")(function* (input: BoundaryInput) {
  const database = yield* Database.Service
  const db = isWithReplicas(database.db) ? database.db.$primary : database.db
  const boundary = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.messageID)))
    .get()
    .pipe(Effect.orDie)
  if (!boundary) return yield* new MessageNotFoundError(input)
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, input.sessionID),
        eq(SessionMessageTable.type, "assistant"),
        gt(SessionMessageTable.seq, boundary.seq),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  const decode = Schema.decodeUnknownEffect(SessionMessage.Message)
  const files = new Map<RelativePath, Snapshot.ID>()
  for (const row of rows) {
    const message = yield* decode({ ...row.data, id: row.id, type: row.type }).pipe(Effect.orDie)
    if (message.type !== "assistant" || !message.snapshot?.start) continue
    for (const file of message.snapshot.files ?? [])
      if (!files.has(file)) files.set(file, Snapshot.ID.make(message.snapshot.start))
  }
  return files
})

export const assertGoalPreserved = Effect.fn("SessionRevert.assertGoalPreserved")(function* (
  db: Database.Interface["db"],
  input: BoundaryInput,
) {
  const boundary = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.messageID)))
    .get()
    .pipe(Effect.orDie)
  if (!boundary) return yield* new MessageNotFoundError(input)
  const goal = yield* db
    .select({ id: SessionGoalTable.goal_id })
    .from(SessionGoalTable)
    .where(eq(SessionGoalTable.session_id, input.sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!goal) return
  const identity = yield* db
    .select({ messageID: SessionGoalIdentityTable.message_id })
    .from(SessionGoalIdentityTable)
    .where(eq(SessionGoalIdentityTable.goal_id, goal.id))
    .get()
    .pipe(Effect.orDie)
  if (!identity?.messageID) return
  const admission = yield* db
    .select({
      admittedSeq: SessionInputTable.admitted_seq,
      promotedSeq: SessionInputTable.promoted_seq,
    })
    .from(SessionInputTable)
    .where(and(eq(SessionInputTable.session_id, input.sessionID), eq(SessionInputTable.id, identity.messageID)))
    .get()
    .pipe(Effect.orDie)
  if (
    admission &&
    admission.admittedSeq <= boundary.seq &&
    (admission.promotedSeq === null || admission.promotedSeq <= boundary.seq)
  )
    return
  return yield* new GoalBoundaryError({
    sessionID: input.sessionID,
    messageID: input.messageID,
    goalID: goal.id,
  })
})

export const projectCommit = Effect.fn("SessionRevert.projectCommit")(function* (
  db: Database.Interface["db"],
  input: BoundaryInput & { readonly timestamp?: DateTime.Utc },
) {
  const session = yield* db
    .select({ revert: SessionTable.revert })
    .from(SessionTable)
    .where(eq(SessionTable.id, input.sessionID))
    .get()
    .pipe(Effect.orDie)
  if (session?.revert?.messageID !== input.messageID)
    return yield* Effect.die(`Staged revert boundary changed before commit: ${input.messageID}`)
  yield* assertGoalPreserved(db, input)
  const boundary = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.messageID)))
    .get()
    .pipe(Effect.orDie)
  if (!boundary) return yield* Effect.die(`Revert boundary message not found: ${input.messageID}`)
  const messageIDs = yield* db
    .select({ id: SessionMessageTable.id })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, input.sessionID), gt(SessionMessageTable.seq, boundary.seq)))
    .all()
    .pipe(Effect.orDie)
  const inputIDs = yield* db
    .select({ id: SessionInputTable.id })
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, input.sessionID),
        or(gt(SessionInputTable.admitted_seq, boundary.seq), gt(SessionInputTable.promoted_seq, boundary.seq)),
      ),
    )
    .all()
    .pipe(Effect.orDie)
  const identities = Array.from(new Set([...messageIDs, ...inputIDs].map((row) => row.id)))
  if (identities.length)
    yield* db
      .update(SessionMessageIdentityTable)
      .set({ state: "reverted" })
      .where(inArray(SessionMessageIdentityTable.id, identities))
      .run()
      .pipe(Effect.orDie)
  yield* db
    .delete(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, input.sessionID), gt(SessionMessageTable.seq, boundary.seq)))
    .run()
    .pipe(Effect.orDie)
  yield* db
    .delete(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, input.sessionID),
        or(gt(SessionInputTable.admitted_seq, boundary.seq), gt(SessionInputTable.promoted_seq, boundary.seq)),
      ),
    )
    .run()
    .pipe(Effect.orDie)
  yield* db
    .update(SessionTable)
    .set({
      revert: null,
      ...(input.timestamp ? { time_updated: DateTime.toEpochMillis(input.timestamp) } : {}),
    })
    .where(eq(SessionTable.id, input.sessionID))
    .run()
    .pipe(Effect.orDie)
  yield* SessionContextEpoch.reset(db, input.sessionID)
})

export const stage = Effect.fn("SessionRevert.stage")(function* (input: {
  readonly session: SessionSchema.Info
  readonly messageID: SessionMessage.ID
  readonly files?: boolean
}) {
  const snapshot = yield* Snapshot.Service
  const events = yield* EventV2.Service
  const original = input.session.revert?.snapshot
    ? Snapshot.ID.make(input.session.revert.snapshot)
    : yield* snapshot.capture()
  const next = yield* plan({ sessionID: input.session.id, messageID: input.messageID })
  const restore = new Map<RelativePath, Snapshot.ID>()
  if (original) {
    for (const file of input.session.revert?.files ?? []) restore.set(file.path, original)
  }
  if (input.files !== false) for (const [file, tree] of next) restore.set(file, tree)
  if (restore.size) yield* snapshot.restore({ files: restore })
  const paths = input.files === false ? [] : Array.from(next.keys())
  const files = original
    ? yield* snapshot.diff({ from: original, to: (yield* snapshot.capture()) ?? original, paths })
    : []
  const revert = {
    messageID: input.messageID,
    snapshot: original,
    diff: files
      .map((file) => file.patch)
      .join("")
      .trim(),
    files,
  } satisfies SessionSchema.Info["revert"]
  yield* events.publish(SessionEvent.RevertEvent.Staged, {
    sessionID: input.session.id,
    timestamp: yield* DateTime.now,
    revert,
  })
  return revert
})

export const clear = Effect.fn("SessionRevert.clear")(function* (session: SessionSchema.Info) {
  if (!session.revert) return
  const snapshot = yield* Snapshot.Service
  const original = session.revert.snapshot ? Snapshot.ID.make(session.revert.snapshot) : undefined
  if (original)
    yield* snapshot.restore({
      files: new Map((session.revert.files ?? []).map((file) => [file.path, original])),
    })
  const events = yield* EventV2.Service
  yield* events.publish(SessionEvent.RevertEvent.Cleared, {
    sessionID: session.id,
    timestamp: yield* DateTime.now,
  })
})

export const commit = Effect.fn("SessionRevert.commit")(function* (session: SessionSchema.Info) {
  if (!session.revert) return
  const database = yield* Database.Service
  const db = isWithReplicas(database.db) ? database.db.$primary : database.db
  yield* assertGoalPreserved(db, {
    sessionID: session.id,
    messageID: session.revert.messageID,
  }).pipe(Effect.catchTag("Session.MessageNotFoundError", Effect.die))
  const events = yield* EventV2.Service
  // Unlike stage and clear, commit needs no Location-scoped service, so its
  // caller runs it on the Session service's global fiber with no
  // Location.Service in context. Pass the placement explicitly rather than
  // building the Location layers purely to make the event routable.
  yield* events.publish(
    SessionEvent.RevertEvent.Committed,
    {
      sessionID: session.id,
      messageID: session.revert.messageID,
      timestamp: yield* DateTime.now,
    },
    { location: session.location },
  )
})
