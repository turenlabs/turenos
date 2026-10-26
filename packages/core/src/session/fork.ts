export * as SessionFork from "./fork"

import { and, asc, eq, lt, ne } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import type { Database } from "../database/database"
import { SessionContextEpoch } from "./context-epoch"
import { SessionInput } from "./input"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionMessageTable } from "./sql"
import { SessionTranscriptAdoption } from "./transcript-adoption"

type DatabaseService = Database.Interface["db"]

export class MessageNotFoundError extends Schema.TaggedErrorClass<MessageNotFoundError>()(
  "SessionFork.MessageNotFoundError",
  {
    sessionID: SessionSchema.ID,
    messageID: SessionMessage.ID,
  },
) {}

/**
 * Selects the rows a fork of `sourceID` would carry, newest last.
 *
 * Resolving the cut is separate from writing it so a caller can validate the
 * request before creating the Session that would receive the copy — a rejected
 * cutoff must not leave an empty Session behind.
 *
 * `system` messages are deliberately excluded. They are deltas against the source
 * Session's system-context epoch; the fork starts from a cleared epoch and
 * regenerates its own baseline on first run, so carrying them over would replay
 * another session's environment history.
 */
export const plan = Effect.fn("SessionFork.plan")(function* (
  db: DatabaseService,
  input: {
    readonly sourceID: SessionSchema.ID
    /** Exclusive upper bound: everything strictly before this message is copied. */
    readonly messageID?: SessionMessage.ID
  },
) {
  const boundary = input.messageID
    ? yield* db
        .select({ seq: SessionMessageTable.seq })
        .from(SessionMessageTable)
        .where(and(eq(SessionMessageTable.session_id, input.sourceID), eq(SessionMessageTable.id, input.messageID)))
        .get()
        .pipe(Effect.orDie)
    : undefined
  if (input.messageID !== undefined && boundary === undefined)
    return yield* new MessageNotFoundError({ sessionID: input.sourceID, messageID: input.messageID })

  return yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, input.sourceID),
        ne(SessionMessageTable.type, "system"),
        boundary === undefined ? undefined : lt(SessionMessageTable.seq, boundary.seq),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
})

/**
 * Writes a planned transcript onto a freshly created Session.
 *
 * V2 has no `part` rows, so this is a row copy with one pointer to remap: a
 * `compaction` message's `throughSeq`, the V2 analogue of V1's
 * `compaction.tail_start_id`. History assembly keeps the rows after it as the
 * checkpoint's structured tail (see history.ts), but it names a seq in the source
 * Session, so each copy points at the new seq of the last copied row at or before
 * it. A checkpoint without `throughSeq` cuts at its own seq, which preserving
 * relative order already keeps.
 *
 * Copied rows take negative `seq` values, exactly as transcript adoption does for
 * a converted legacy transcript. The new Session's own durable event log starts at
 * 0, so nothing the fork does later can collide with the transcript it was born
 * holding — `session_message_session_seq_idx` is UNIQUE on (session_id, seq) and a
 * collision would be an unrecoverable defect on the projector's write path.
 *
 * Negative sequences are also why the fork is marked adopted: a V2-native
 * transcript has no legacy predecessor to convert, and an unmarked session would
 * later fail `SessionTranscriptAdoption.ensure` on its own copied rows, which
 * rejects pre-existing negative sequences as an unorderable overlap.
 */
export const apply = Effect.fn("SessionFork.apply")(function* (
  db: DatabaseService,
  input: {
    readonly targetID: SessionSchema.ID
    readonly rows: ReadonlyArray<typeof SessionMessageTable.$inferSelect>
  },
) {
  const { rows } = input
  yield* db
    .transaction(() =>
      Effect.gen(function* () {
        for (const [index, row] of rows.entries()) {
          const id = SessionMessage.ID.create()
          const seq = index - rows.length
          // `synthetic` embeds its own sessionID in `data`, and `compaction` names a
          // source row by its seq in `throughSeq`; every other field is position
          // independent. When no copied row is at or before `throughSeq`,
          // `findLastIndex` gives -1 and the cut still lands below every copied row.
          // The column type is a union that `type` cannot narrow, hence the assertion.
          const throughSeq =
            "throughSeq" in row.data && typeof row.data.throughSeq === "number" ? row.data.throughSeq : undefined
          const data = (
            row.type === "synthetic"
              ? { ...(row.data as Record<string, unknown>), sessionID: input.targetID }
              : throughSeq === undefined
                ? row.data
                : { ...row.data, throughSeq: rows.findLastIndex((source) => source.seq <= throughSeq) - rows.length }
          ) as typeof SessionMessageTable.$inferInsert.data
          yield* SessionInput.projectMessageIdentity(db, {
            id,
            sessionID: input.targetID,
            // Mirrors the projector's own classification on the insert path: the
            // fork owns these rows outright, they did not arrive through the
            // durable inbox, so none of them carry an `input` identity.
            kind: row.type === "shell" ? "shell" : "message",
            creatorSeq: seq,
            timeCreated: DateTime.makeUnsafe(row.time_created),
          })
          yield* db
            .insert(SessionMessageTable)
            .values({
              id,
              session_id: input.targetID,
              type: row.type,
              seq,
              time_created: row.time_created,
              data,
            })
            .run()
            .pipe(Effect.orDie)
        }
        yield* SessionTranscriptAdoption.markCurrent(db, input.targetID)
        yield* SessionContextEpoch.reset(db, input.targetID)
      }),
    )
    .pipe(Effect.orDie)

  return rows.length
})
