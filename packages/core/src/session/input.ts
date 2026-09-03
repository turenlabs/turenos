export * as SessionInput from "./input"

import { and, asc, desc, eq, gt, isNotNull, isNull, lte } from "drizzle-orm"
import { Cause, DateTime, Effect, Schema } from "effect"
import { Admitted, CommandIntent, Delivery, OutboxItem, Source, Status } from "@turenlabs/schema/session-input"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import type { Location } from "../location"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { Prompt } from "./prompt"
import { SessionSchema } from "./schema"
import { SessionInputTable, SessionMessageIdentityTable, SessionMessageTable, SessionTable } from "./sql"

type DatabaseService = Database.Interface["db"]

export { Admitted, CommandIntent, Delivery, OutboxItem, Source, Status }
export type IdentityKind = "prompt" | "command" | "goal"
export type Identity = {
  readonly sessionID: SessionSchema.ID
  readonly owner: "input" | "message"
  readonly kind: IdentityKind | "shell" | "message"
  readonly state: "active" | "reverted"
  readonly creatorSeq?: number
  readonly admitted?: Admitted
  readonly command?: CommandIntent
  readonly source?: Source
}

const decodePrompt = Schema.decodeUnknownSync(Prompt)
const encodePrompt = Schema.encodeSync(Prompt)

const fromRow = (row: typeof SessionInputTable.$inferSelect): Admitted =>
  Admitted.make({
    admittedSeq: row.admitted_seq,
    id: SessionMessage.ID.make(row.id),
    sessionID: SessionSchema.ID.make(row.session_id),
    prompt: decodePrompt(row.prompt),
    delivery: row.delivery,
    ...(row.agent === null ? {} : { agent: row.agent }),
    ...(row.model === null ? {} : { model: row.model }),
    timeCreated: DateTime.makeUnsafe(row.time_created),
    ...(row.promoted_seq === null ? {} : { promotedSeq: row.promoted_seq }),
  })

const outboxFromRow = (row: typeof SessionInputTable.$inferSelect): OutboxItem =>
  OutboxItem.make({
    ...fromRow(row),
    status: row.time_cancelled !== null ? "cancelled" : row.promoted_seq !== null ? "promoted" : "admitted",
    ...(row.time_cancelled === null ? {} : { timeCancelled: DateTime.makeUnsafe(row.time_cancelled) }),
  })

export const find = Effect.fn("SessionInput.find")(function* (db: DatabaseService, id: SessionMessage.ID) {
  const row = yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, id)).get().pipe(Effect.orDie)
  return row === undefined ? undefined : fromRow(row)
})

export const inputStatus = Effect.fn("SessionInput.inputStatus")(function* (
  db: DatabaseService,
  input: { readonly sessionID: SessionSchema.ID; readonly messageID: SessionMessage.ID },
) {
  const row = yield* db
    .select()
    .from(SessionInputTable)
    .where(and(eq(SessionInputTable.id, input.messageID), eq(SessionInputTable.session_id, input.sessionID)))
    .get()
    .pipe(Effect.orDie)
  return row === undefined ? undefined : outboxFromRow(row)
})

export const outbox = Effect.fn("SessionInput.outbox")(function* (
  db: DatabaseService,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly limit: number
    readonly cursor?: number
    readonly status?: Status
  },
) {
  const status =
    input.status === "admitted"
      ? and(isNull(SessionInputTable.promoted_seq), isNull(SessionInputTable.time_cancelled))
      : input.status === "promoted"
        ? isNotNull(SessionInputTable.promoted_seq)
        : input.status === "cancelled"
          ? isNotNull(SessionInputTable.time_cancelled)
          : undefined
  const rows = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, input.sessionID),
        input.cursor === undefined ? undefined : gt(SessionInputTable.admitted_seq, input.cursor),
        status,
      ),
    )
    .orderBy(asc(SessionInputTable.admitted_seq))
    .limit(input.limit + 1)
    .all()
    .pipe(Effect.orDie)
  const items = rows.slice(0, input.limit).map(outboxFromRow)
  return {
    items,
    ...(rows.length <= input.limit || items.length === 0 ? {} : { next: items.at(-1)!.admittedSeq }),
  }
})

export const cancelPending = Effect.fn("SessionInput.cancelPending")(function* (
  db: DatabaseService,
  input: { readonly sessionID: SessionSchema.ID; readonly id: SessionMessage.ID },
) {
  const cancelled = yield* db
    .update(SessionInputTable)
    .set({ time_cancelled: Date.now() })
    .where(
      and(
        eq(SessionInputTable.id, input.id),
        eq(SessionInputTable.session_id, input.sessionID),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.time_cancelled),
      ),
    )
    .returning({ id: SessionInputTable.id })
    .get()
    .pipe(Effect.orDie)
  return cancelled !== undefined
})

export const findCommand = Effect.fn("SessionInput.findCommand")(function* (
  db: DatabaseService,
  id: SessionMessage.ID,
) {
  const row = yield* db
    .select({ command: SessionInputTable.command })
    .from(SessionInputTable)
    .where(eq(SessionInputTable.id, id))
    .get()
    .pipe(Effect.orDie)
  return row?.command ?? undefined
})

export const findIdentity = Effect.fn("SessionInput.findIdentity")(function* (
  db: DatabaseService,
  id: SessionMessage.ID,
) {
  const row = yield* db
    .select()
    .from(SessionMessageIdentityTable)
    .where(eq(SessionMessageIdentityTable.id, id))
    .get()
    .pipe(Effect.orDie)
  if (!row) return
  return {
    sessionID: SessionSchema.ID.make(row.session_id),
    owner: row.owner,
    kind: row.kind,
    state: row.state,
    ...(row.creator_seq === null ? {} : { creatorSeq: row.creator_seq }),
    ...(row.input
      ? {
          admitted: Admitted.make({
            ...row.input.admitted,
            timeCreated: DateTime.makeUnsafe(row.input.admitted.timeCreated),
          }),
          command: row.input.command,
          source: row.input.source,
        }
      : {}),
  } satisfies Identity
})

export class LifecycleConflict extends Schema.TaggedErrorClass<LifecycleConflict>()("SessionInput.LifecycleConflict", {
  id: SessionMessage.ID,
}) {}

export const admit = Effect.fn("SessionInput.admit")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly source?: Source
    readonly agent?: Admitted["agent"]
    readonly model?: Admitted["model"]
    readonly command?: CommandIntent
    readonly kind: IdentityKind
    readonly revert?: { readonly messageID: SessionMessage.ID }
    /**
     * Placement of the Session being admitted into. Every caller reaches this
     * from a global-node service with no `Location.Service` in context, so the
     * event would otherwise publish unlocated and be dropped by every
     * per-instance stream. Optional only so callers that genuinely run inside a
     * located scope may keep falling back to ambient.
     */
    readonly location?: Location.Ref
  },
) {
  const existing = yield* find(db, input.id)
  if (existing !== undefined) return existing
  const timestamp = yield* DateTime.now
  return yield* events
    .publish(
      SessionEvent.PromptAdmitted,
      {
        messageID: input.id,
        sessionID: input.sessionID,
        timestamp,
        prompt: input.prompt,
        delivery: input.delivery,
        source: input.source,
        agent: input.agent,
        model: input.model,
        command: input.command,
        revert: input.revert,
      },
      input.location ? { location: input.location } : undefined,
    )
    .pipe(
      Effect.flatMap((event) =>
        event.durable === undefined
          ? Effect.die("Prompt admission event is missing aggregate sequence")
          : Effect.succeed(
              Admitted.make({
                admittedSeq: event.durable.seq,
                id: input.id,
                sessionID: input.sessionID,
                prompt: input.prompt,
                delivery: input.delivery,
                agent: input.agent,
                model: input.model,
                timeCreated: timestamp,
              }),
            ),
      ),
      Effect.catchDefect((defect) =>
        find(db, input.id).pipe(Effect.flatMap((stored) => (stored ? Effect.succeed(stored) : Effect.die(defect)))),
      ),
    )
})

export const projectAdmitted = Effect.fn("SessionInput.projectAdmitted")(function* (
  db: DatabaseService,
  input: {
    readonly admittedSeq: number
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly source?: Source
    readonly agent?: Admitted["agent"]
    readonly model?: Admitted["model"]
    readonly command?: CommandIntent
    readonly kind: IdentityKind
    readonly timeCreated: DateTime.Utc
  },
) {
  const identity = yield* findIdentity(db, input.id)
  if (identity) {
    if (
      identity.state !== "active" ||
      !equivalentIdentity(identity, {
        kind: input.kind,
        sessionID: input.sessionID,
        prompt: input.prompt,
        delivery: input.delivery,
        agent: input.agent,
        model: input.model,
        command: input.command,
        source: input.source,
      }) ||
      (yield* find(db, input.id))
    )
      return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  } else {
    const claimed = yield* db
      .insert(SessionMessageIdentityTable)
      .values({
        id: input.id,
        session_id: input.sessionID,
        owner: "input",
        kind: input.kind,
        input: {
          admitted: {
            admittedSeq: input.admittedSeq,
            id: input.id,
            sessionID: input.sessionID,
            prompt: input.prompt,
            delivery: input.delivery,
            agent: input.agent,
            model: input.model,
            timeCreated: DateTime.toEpochMillis(input.timeCreated),
          },
          command: input.command,
          source: input.source,
        },
        state: "active",
        time_created: DateTime.toEpochMillis(input.timeCreated),
      })
      .onConflictDoNothing()
      .returning({ id: SessionMessageIdentityTable.id })
      .get()
      .pipe(Effect.orDie)
    if (!claimed) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  }
  const message = yield* db
    .select({ id: SessionMessageTable.id })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, input.id))
    .get()
    .pipe(Effect.orDie)
  if (message !== undefined) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  const stored = yield* db
    .insert(SessionInputTable)
    .values({
      id: input.id,
      session_id: input.sessionID,
      admitted_seq: input.admittedSeq,
      prompt: encodePrompt(input.prompt),
      delivery: input.delivery,
      source: input.source,
      agent: input.agent,
      model: input.model,
      command: input.command,
      time_created: DateTime.toEpochMillis(input.timeCreated),
    })
    .onConflictDoNothing()
    .returning({ id: SessionInputTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!stored) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  if (input.agent || input.model)
    yield* db
      .update(SessionTable)
      .set({
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.model ? { model: input.model } : {}),
        time_updated: DateTime.toEpochMillis(input.timeCreated),
      })
      .where(eq(SessionTable.id, input.sessionID))
      .run()
      .pipe(Effect.orDie)
})

export const projectPrompted = Effect.fn("SessionInput.projectPrompted")(function* (
  db: DatabaseService,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly timeCreated: DateTime.Utc
    readonly promotedSeq: number
  },
) {
  const identity = yield* findIdentity(db, input.id)
  if (identity) {
    if (
      identity.owner !== "input" ||
      identity.state !== "active" ||
      !identity.admitted ||
      !matchesProjection(identity.admitted, input)
    )
      return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  } else {
    const claimed = yield* db
      .insert(SessionMessageIdentityTable)
      .values({
        id: input.id,
        session_id: input.sessionID,
        owner: "input",
        kind: "prompt",
        input: {
          admitted: {
            admittedSeq: input.promotedSeq,
            id: input.id,
            sessionID: input.sessionID,
            prompt: input.prompt,
            delivery: input.delivery,
            timeCreated: DateTime.toEpochMillis(input.timeCreated),
            promotedSeq: input.promotedSeq,
          },
        },
        state: "active",
        time_created: DateTime.toEpochMillis(input.timeCreated),
      })
      .onConflictDoNothing()
      .returning({ id: SessionMessageIdentityTable.id })
      .get()
      .pipe(Effect.orDie)
    if (!claimed) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  }
  const updated = yield* db
    .update(SessionInputTable)
    .set({ promoted_seq: input.promotedSeq })
    .where(
      and(
        eq(SessionInputTable.id, input.id),
        eq(SessionInputTable.session_id, input.sessionID),
        isNull(SessionInputTable.promoted_seq),
      ),
    )
    .returning()
    .get()
    .pipe(Effect.orDie)
  if (updated) {
    const stored = fromRow(updated)
    if (!matchesProjection(stored, input)) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
    return
  }

  const stored = yield* find(db, input.id)
  if (stored) {
    if (!matchesProjection(stored, input) || stored.promotedSeq !== input.promotedSeq)
      return yield* Effect.die(new LifecycleConflict({ id: input.id }))
    return
  }

  yield* db
    .insert(SessionInputTable)
    .values({
      id: input.id,
      session_id: input.sessionID,
      prompt: encodePrompt(input.prompt),
      delivery: input.delivery,
      source: "user",
      admitted_seq: input.promotedSeq,
      promoted_seq: input.promotedSeq,
      time_created: DateTime.toEpochMillis(input.timeCreated),
    })
    .run()
    .pipe(Effect.orDie)
})

export const hasPending = Effect.fn("SessionInput.hasPending")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  delivery: Delivery,
) {
  const row = yield* db
    .select({ id: SessionInputTable.id })
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.time_cancelled),
        eq(SessionInputTable.delivery, delivery),
      ),
    )
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row !== undefined
})

export const hasPendingSource = Effect.fn("SessionInput.hasPendingSource")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  source: Source,
) {
  const row = yield* db
    .select({ id: SessionInputTable.id })
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.time_cancelled),
        eq(SessionInputTable.source, source),
      ),
    )
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row !== undefined
})

export const pending = Effect.fn("SessionInput.pending")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const rows = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.time_cancelled),
      ),
    )
    .orderBy(asc(SessionInputTable.admitted_seq))
    .all()
    .pipe(Effect.orDie)
  return rows.map(fromRow)
})

export const latestPromoted = Effect.fn("SessionInput.latestPromoted")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  source: Source,
) {
  const row = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        eq(SessionInputTable.source, source),
        isNotNull(SessionInputTable.promoted_seq),
      ),
    )
    .orderBy(desc(SessionInputTable.promoted_seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row === undefined ? undefined : fromRow(row)
})

export const equivalent = (
  input: Admitted,
  expected: {
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly agent?: Admitted["agent"]
    readonly model?: Admitted["model"]
  },
) =>
  input.delivery === expected.delivery &&
  input.agent === expected.agent &&
  input.model?.providerID === expected.model?.providerID &&
  input.model?.id === expected.model?.id &&
  (input.model?.variant ?? "default") === (expected.model?.variant ?? "default") &&
  matchesPrompt(input, expected)

export const equivalentCommand = (actual: CommandIntent | undefined, expected: CommandIntent | undefined) => {
  if (!actual || !expected) return actual === expected
  return (
    actual.command === expected.command &&
    actual.arguments === expected.arguments &&
    actual.agent === expected.agent &&
    actual.model?.providerID === expected.model?.providerID &&
    actual.model?.id === expected.model?.id &&
    (actual.model?.variant ?? "default") === (expected.model?.variant ?? "default") &&
    JSON.stringify(actual.files ?? []) === JSON.stringify(expected.files ?? [])
  )
}

export const equivalentIdentity = (
  identity: Identity,
  expected: {
    readonly kind: IdentityKind
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly agent?: Admitted["agent"]
    readonly model?: Admitted["model"]
    readonly command?: CommandIntent
    readonly source?: Source
  },
) =>
  identity.owner === "input" &&
  identity.kind === expected.kind &&
  identity.admitted !== undefined &&
  equivalent(identity.admitted, expected) &&
  equivalentCommand(identity.command, expected.command) &&
  (identity.source ?? "user") === (expected.source ?? "user")

export const projectMessageIdentity = Effect.fn("SessionInput.projectMessageIdentity")(function* (
  db: DatabaseService,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly kind: "shell" | "message"
    readonly creatorSeq: number
    readonly timeCreated: DateTime.Utc
  },
) {
  const claimed = yield* db
    .insert(SessionMessageIdentityTable)
    .values({
      id: input.id,
      session_id: input.sessionID,
      owner: "message",
      kind: input.kind,
      state: "active",
      creator_seq: input.creatorSeq,
      time_created: DateTime.toEpochMillis(input.timeCreated),
    })
    .onConflictDoNothing()
    .returning({ id: SessionMessageIdentityTable.id })
    .get()
    .pipe(Effect.orDie)
  if (claimed) return
  const existing = yield* findIdentity(db, input.id)
  if (
    existing?.owner === "message" &&
    existing.sessionID === input.sessionID &&
    existing.kind === input.kind &&
    existing.state === "active" &&
    existing.creatorSeq === input.creatorSeq
  )
    return
  return yield* Effect.die(new LifecycleConflict({ id: input.id }))
})

const matchesPrompt = (input: Admitted, expected: { readonly sessionID: SessionSchema.ID; readonly prompt: Prompt }) =>
  input.sessionID === expected.sessionID &&
  JSON.stringify(encodePrompt(input.prompt)) === JSON.stringify(encodePrompt(expected.prompt))

const matchesProjection = (
  input: Admitted,
  expected: {
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly agent?: Admitted["agent"]
    readonly model?: Admitted["model"]
    readonly timeCreated: DateTime.Utc
  },
) =>
  input.delivery === expected.delivery &&
  matchesPrompt(input, expected) &&
  DateTime.toEpochMillis(input.timeCreated) === DateTime.toEpochMillis(expected.timeCreated)

const publish = Effect.fn("SessionInput.publish")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  rows: ReadonlyArray<typeof SessionInputTable.$inferSelect>,
  onPromoted?: () => void,
) {
  for (const row of rows) {
    const id = SessionMessage.ID.make(row.id)
    const markPromoted = Effect.sync(() => onPromoted?.())
    yield* events
      .publish(
        SessionEvent.Prompted,
        {
          sessionID,
          timestamp: DateTime.makeUnsafe(row.time_created),
          messageID: id,
          prompt: decodePrompt(row.prompt),
          delivery: row.delivery,
        },
        { commit: () => markPromoted },
      )
      .pipe(
        Effect.catchDefect((defect) =>
          defect instanceof LifecycleConflict
            ? find(db, id).pipe(
                Effect.flatMap((stored) => (stored?.promotedSeq === undefined ? Effect.die(defect) : markPromoted)),
              )
            : Effect.die(defect),
        ),
        Effect.catchCauseIf(Cause.hasInterruptsOnly, (cause) =>
          Effect.uninterruptible(
            find(db, id).pipe(
              Effect.flatMap((stored) => (stored?.promotedSeq === undefined ? Effect.failCause(cause) : markPromoted)),
            ),
          ),
        ),
      )
  }
  return rows.length
})

export const promoteSteers = Effect.fn("SessionInput.promoteSteers")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  cutoff: number,
  onPromoted?: () => void,
) {
  const rows = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.time_cancelled),
        eq(SessionInputTable.delivery, "steer"),
        lte(SessionInputTable.admitted_seq, cutoff),
      ),
    )
    .orderBy(asc(SessionInputTable.admitted_seq))
    .all()
    .pipe(Effect.orDie)
  return yield* publish(db, events, sessionID, rows, onPromoted)
})

export const promoteNextQueued = Effect.fn("SessionInput.promoteNextQueued")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  onPromoted?: () => void,
) {
  const row = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.time_cancelled),
        eq(SessionInputTable.delivery, "queue"),
      ),
    )
    .orderBy(asc(SessionInputTable.admitted_seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row === undefined ? false : yield* publish(db, events, sessionID, [row], onPromoted).pipe(Effect.as(true))
})
