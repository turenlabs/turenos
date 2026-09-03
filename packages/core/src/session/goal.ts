export * as SessionGoal from "./goal"

import { isWithReplicas } from "@turenlabs/effect-drizzle-sqlite"
import { SessionGoal as Contract } from "@turenlabs/schema/session-goal"
import { and, eq } from "drizzle-orm"
import { Context, DateTime, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { AgentV2 } from "../agent"
import { Location } from "../location"
import { ModelV2 } from "../model"
import { SessionEvent } from "./event"
import { SessionInput } from "./input"
import { SessionMessage } from "./message"
import { Prompt } from "./prompt"
import { SessionRevert } from "./revert"
import { SessionSchema } from "./schema"
import { SessionGoalIdentityTable, SessionGoalTable, SessionGoalTurnTable, SessionInputTable } from "./sql"
import { SessionStore } from "./store"

export const ID = Contract.ID
export type ID = Contract.ID
export const Revision = Contract.Revision
export type Revision = Contract.Revision
export const Status = Contract.Status
export type Status = Contract.Status
export const Objective = Contract.Objective
export type Objective = Contract.Objective
export const Info = Contract.Info
export type Info = Contract.Info
export const NotFoundError = Contract.NotFoundError
export type NotFoundError = Contract.NotFoundError
export const ConflictError = Contract.ConflictError
export type ConflictError = Contract.ConflictError
export const InvalidStateError = Contract.InvalidStateError
export type InvalidStateError = Contract.InvalidStateError

export type CreateInput = {
  readonly sessionID: SessionSchema.ID
  readonly id?: ID
  readonly messageID?: SessionMessage.ID
  readonly objective: Objective
  readonly agent?: AgentV2.ID
  readonly model?: ModelV2.Ref
  readonly revert?: { readonly messageID: SessionMessage.ID }
}

export type EditInput = {
  readonly sessionID: SessionSchema.ID
  readonly goalID: ID
  readonly expectedRevision: Revision
  readonly objective: Objective
}

export type StatusInput = {
  readonly sessionID: SessionSchema.ID
  readonly goalID: ID
  readonly expectedRevision: Revision
  readonly status: Status
}

export type ClearInput = {
  readonly sessionID: SessionSchema.ID
  readonly goalID: ID
  readonly expectedRevision: Revision
}

export type AccountInput = {
  readonly sessionID: SessionSchema.ID
  readonly goalID: ID
  readonly expectedRevision: Revision
  readonly checkpointID?: SessionMessage.ID
  readonly tokenDelta: number
  readonly activeTimeMsDelta: number
  readonly mode?: "ActiveOnly" | "ActiveOrComplete" | "ActiveOrStopped"
}

export type CreatePreflight =
  | { readonly type: "new" }
  | { readonly type: "exact"; readonly goal: Info; readonly wake: boolean }

export interface Interface {
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<Info | undefined, NotFoundError>
  readonly preflightCreate: (input: CreateInput) => Effect.Effect<CreatePreflight, NotFoundError | ConflictError>
  readonly create: (input: CreateInput) => Effect.Effect<Info, NotFoundError | ConflictError>
  readonly edit: (input: EditInput) => Effect.Effect<Info, NotFoundError | ConflictError | InvalidStateError>
  readonly status: (input: StatusInput) => Effect.Effect<Info, NotFoundError | ConflictError | InvalidStateError>
  readonly clear: (input: ClearInput) => Effect.Effect<void, NotFoundError | ConflictError>
  readonly account: (input: AccountInput) => Effect.Effect<Info, NotFoundError | ConflictError | InvalidStateError>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/SessionGoal") {}

class ProjectionConflict extends Error {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const primary = isWithReplicas(db) ? db.$primary : db
    const events = yield* EventV2.Service
    const sessions = yield* SessionStore.Service

    yield* events.project(SessionEvent.Goal.Updated, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session goal event is missing sequence")
        if (event.data.admission?.revert)
          yield* SessionRevert.projectCommit(primary, {
            sessionID: event.data.sessionID,
            messageID: event.data.admission.revert.messageID,
            timestamp: event.data.timestamp,
          }).pipe(Effect.orDie)
        const current = yield* primary
          .select()
          .from(SessionGoalTable)
          .where(eq(SessionGoalTable.session_id, event.data.sessionID))
          .get()
          .pipe(Effect.orDie)
        const values = toRow(event.data.goal, event.data.activeTimeMs)
        if (event.data.goal.revision === 1) {
          yield* primary
            .insert(SessionGoalIdentityTable)
            .values({
              goal_id: event.data.goal.id,
              session_id: event.data.sessionID,
              message_id: event.data.admission?.messageID,
              objective: event.data.goal.objective,
              state: "current",
              time_created: DateTime.toEpochMillis(event.data.goal.time.created),
            })
            .run()
            .pipe(Effect.orDie)
        }
        if (!current) {
          if (event.data.goal.revision !== 1) return yield* Effect.die(new ProjectionConflict("Invalid first revision"))
          yield* primary.insert(SessionGoalTable).values(values).run().pipe(Effect.orDie)
        } else if (current.goal_id === event.data.goal.id) {
          if (event.data.goal.revision !== current.revision + 1)
            return yield* Effect.die(new ProjectionConflict("Goal revision changed"))
          const updated = yield* primary
            .update(SessionGoalTable)
            .set(values)
            .where(
              and(
                eq(SessionGoalTable.session_id, event.data.sessionID),
                eq(SessionGoalTable.goal_id, current.goal_id),
                eq(SessionGoalTable.revision, current.revision),
              ),
            )
            .returning({ sessionID: SessionGoalTable.session_id })
            .get()
            .pipe(Effect.orDie)
          if (!updated) return yield* Effect.die(new ProjectionConflict("Goal changed during update"))
        } else {
          if (current.status !== "complete" || event.data.goal.revision !== 1)
            return yield* Effect.die(new ProjectionConflict("An unfinished goal cannot be replaced"))
          const terminal = yield* primary
            .update(SessionGoalIdentityTable)
            .set({
              state: "replaced",
              final_revision: current.revision,
              time_terminal: DateTime.toEpochMillis(event.data.timestamp),
            })
            .where(
              and(
                eq(SessionGoalIdentityTable.goal_id, current.goal_id),
                eq(SessionGoalIdentityTable.session_id, event.data.sessionID),
                eq(SessionGoalIdentityTable.state, "current"),
              ),
            )
            .returning({ goalID: SessionGoalIdentityTable.goal_id })
            .get()
            .pipe(Effect.orDie)
          if (!terminal) return yield* Effect.die(new ProjectionConflict("Previous goal identity changed"))
          const updated = yield* primary
            .update(SessionGoalTable)
            .set(values)
            .where(
              and(
                eq(SessionGoalTable.session_id, event.data.sessionID),
                eq(SessionGoalTable.goal_id, current.goal_id),
                eq(SessionGoalTable.revision, current.revision),
                eq(SessionGoalTable.status, "complete"),
              ),
            )
            .returning({ sessionID: SessionGoalTable.session_id })
            .get()
            .pipe(Effect.orDie)
          if (!updated) return yield* Effect.die(new ProjectionConflict("Goal changed during replacement"))
        }
        if (!event.data.admission) return
        yield* SessionInput.projectAdmitted(primary, {
          admittedSeq: event.durable.seq,
          id: event.data.admission.messageID,
          sessionID: event.data.sessionID,
          prompt: event.data.admission.prompt,
          delivery: event.data.admission.delivery,
          agent: event.data.admission.agent,
          model: event.data.admission.model,
          kind: "goal",
          timeCreated: event.data.timestamp,
        })
      }),
    )
    yield* events.project(SessionEvent.Goal.Cleared, (event) =>
      Effect.gen(function* () {
        const terminal = yield* primary
          .update(SessionGoalIdentityTable)
          .set({
            state: "cleared",
            final_revision: event.data.revision,
            time_terminal: DateTime.toEpochMillis(event.data.timestamp),
          })
          .where(
            and(
              eq(SessionGoalIdentityTable.goal_id, event.data.goalID),
              eq(SessionGoalIdentityTable.session_id, event.data.sessionID),
              eq(SessionGoalIdentityTable.state, "current"),
            ),
          )
          .returning({ goalID: SessionGoalIdentityTable.goal_id })
          .get()
          .pipe(Effect.orDie)
        if (!terminal) return yield* Effect.die(new ProjectionConflict("Goal identity changed during clear"))
        const removed = yield* primary
          .delete(SessionGoalTable)
          .where(
            and(
              eq(SessionGoalTable.session_id, event.data.sessionID),
              eq(SessionGoalTable.goal_id, event.data.goalID),
              eq(SessionGoalTable.revision, event.data.revision),
            ),
          )
          .returning({ sessionID: SessionGoalTable.session_id })
          .get()
          .pipe(Effect.orDie)
        if (!removed) return yield* Effect.die(new ProjectionConflict("Goal changed during clear"))
      }),
    )

    const requireSession = Effect.fn("SessionGoal.requireSession")(function* (sessionID: SessionSchema.ID) {
      if (yield* sessions.get(sessionID)) return
      return yield* new NotFoundError({ sessionID })
    })

    /**
     * Resolves the placement a goal event belongs to.
     *
     * This service is global, so it publishes from whatever fiber reached it,
     * and most of them have no `Location.Service` in context: crash recovery
     * pauses an active goal from the recovery fiber, and every `SessionV2.goal`
     * entry point runs on the Session service's global fiber. An event published
     * without a location is dropped by every per-instance subscriber, so the UI
     * keeps rendering a stale goal until it refetches. The placement of a goal
     * is a property of its Session rather than of the publishing scope, so read
     * it from the Session instead of from ambient context. A missing Session
     * leaves the location unset and falls back to ambient.
     */
    const locate = Effect.fn("SessionGoal.locate")(function* (sessionID: SessionSchema.ID) {
      return (yield* sessions.get(sessionID))?.location
    })

    const read = Effect.fn("SessionGoal.read")(function* (sessionID: SessionSchema.ID) {
      return yield* primary
        .select()
        .from(SessionGoalTable)
        .where(eq(SessionGoalTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
    })
    const readIdentityByID = Effect.fn("SessionGoal.readIdentityByID")(function* (goalID: ID) {
      return yield* primary
        .select()
        .from(SessionGoalIdentityTable)
        .where(eq(SessionGoalIdentityTable.goal_id, goalID))
        .get()
        .pipe(Effect.orDie)
    })
    const readTurn = Effect.fn("SessionGoal.readTurn")(function* (checkpointID: SessionMessage.ID) {
      return yield* primary
        .select()
        .from(SessionGoalTurnTable)
        .where(eq(SessionGoalTurnTable.assistant_message_id, checkpointID))
        .get()
        .pipe(Effect.orDie)
    })
    const readIdentityByMessage = Effect.fn("SessionGoal.readIdentityByMessage")(function* (
      messageID: SessionMessage.ID,
    ) {
      return yield* primary
        .select()
        .from(SessionGoalIdentityTable)
        .where(eq(SessionGoalIdentityTable.message_id, messageID))
        .get()
        .pipe(Effect.orDie)
    })
    const readAdmission = Effect.fn("SessionGoal.readAdmission")(function* (messageID: SessionMessage.ID) {
      return yield* primary
        .select()
        .from(SessionInputTable)
        .where(eq(SessionInputTable.id, messageID))
        .get()
        .pipe(Effect.orDie)
    })

    const get = Effect.fn("SessionGoal.get")(function* (sessionID: SessionSchema.ID) {
      yield* requireSession(sessionID)
      const row = yield* read(sessionID)
      return row ? fromRow(row) : undefined
    })

    const preflightCreate = Effect.fn("SessionGoal.preflightCreate")(function* (input: CreateInput) {
      yield* requireSession(input.sessionID)
      const existing = yield* read(input.sessionID)
      const identity = input.id ? yield* readIdentityByID(input.id) : undefined
      const messageIdentity = input.messageID ? yield* readIdentityByMessage(input.messageID) : undefined
      const admissionIdentity = input.messageID ? yield* SessionInput.findIdentity(primary, input.messageID) : undefined
      if (identity && identity.session_id !== input.sessionID)
        return yield* createConflict(
          input,
          identity.goal_id,
          identity.final_revision,
          "Goal ID is already owned by another Session",
        )
      if (messageIdentity && messageIdentity.session_id !== input.sessionID)
        return yield* createConflict(
          input,
          messageIdentity.goal_id,
          messageIdentity.final_revision,
          "Goal message ID is already owned by another Session",
        )
      if (
        admissionIdentity &&
        !SessionInput.equivalentIdentity(admissionIdentity, {
          kind: "goal",
          sessionID: input.sessionID,
          prompt: Prompt.make({ text: input.objective }),
          delivery: "steer",
          agent: input.agent,
          model: input.model,
        })
      )
        return yield* createConflict(input, undefined, undefined, "Goal message ID is already owned by another record")
      const admission = input.messageID ? yield* readAdmission(input.messageID) : undefined
      if (admission && admission.session_id !== input.sessionID)
        return yield* createConflict(input, undefined, undefined, "Goal message ID is already owned by another Session")
      if (existing) {
        const reconciled = yield* reconcileCreate(primary, existing, input)
        if (reconciled)
          return {
            type: "exact",
            goal: reconciled,
            wake: admissionIdentity?.state !== "reverted",
          } as const
      }
      if (identity || messageIdentity)
        return yield* createConflict(
          input,
          (identity ?? messageIdentity)?.goal_id,
          (identity ?? messageIdentity)?.final_revision,
          (identity ?? messageIdentity)?.state === "current"
            ? "Goal identity is already in use"
            : "Goal identity is terminal and cannot be reused or resurrected",
        )
      if (admission && !existing)
        return yield* createConflict(
          input,
          undefined,
          undefined,
          "Goal message ID was already admitted and cannot create a goal",
        )
      if (!existing) return { type: "new" } as const
      if (admission)
        return yield* conflict(
          input.sessionID,
          input.id,
          undefined,
          existing,
          "Goal message ID conflicts with the current goal",
        )
      if (existing.status === "complete" && input.id !== existing.goal_id) return { type: "new" } as const
      return yield* conflict(
        input.sessionID,
        input.id,
        undefined,
        existing,
        "An unfinished or reused goal already exists",
      )
    })

    const create = Effect.fn("SessionGoal.create")(function* (input: CreateInput) {
      yield* requireSession(input.sessionID)
      const preflight = yield* preflightCreate(input)
      if (preflight.type === "exact") return preflight.goal
      const existing = yield* read(input.sessionID)
      const goalID = input.id ?? ID.create()
      const now = yield* DateTime.now
      const goal = Info.make({
        id: goalID,
        sessionID: input.sessionID,
        revision: Revision.make(1),
        objective: input.objective,
        status: "active",
        tokensUsed: 0,
        timeUsedSeconds: 0,
        time: { created: now, updated: now, statusChanged: now },
      })
      const admission = input.messageID
        ? {
            messageID: input.messageID,
            prompt: Prompt.make({ text: input.objective }),
            delivery: "steer" as const,
            agent: input.agent,
            model: input.model,
            revert: input.revert,
          }
        : undefined
      const location = yield* locate(input.sessionID)
      const published = yield* events
        .publish(
          SessionEvent.Goal.Updated,
          {
            sessionID: input.sessionID,
            timestamp: now,
            goal,
            activeTimeMs: 0,
            ...(admission ? { admission } : {}),
          },
          location ? { location } : undefined,
        )
        .pipe(Effect.exit)
      if (published._tag === "Success") return goal
      const current = yield* read(input.sessionID)
      if (current) {
        const reconciled = yield* reconcileCreate(primary, current, input)
        if (reconciled) return reconciled
        return yield* conflict(input.sessionID, goalID, undefined, current, "Goal changed during creation")
      }
      const identity = yield* readIdentityByID(goalID)
      if (identity)
        return yield* createConflict(
          input,
          identity.goal_id,
          identity.final_revision,
          "Goal ID changed ownership during creation",
        )
      const messageIdentity = input.messageID ? yield* readIdentityByMessage(input.messageID) : undefined
      if (messageIdentity)
        return yield* createConflict(
          input,
          messageIdentity.goal_id,
          messageIdentity.final_revision,
          "Goal message ID changed ownership during creation",
        )
      const collidedAdmission = input.messageID ? yield* readAdmission(input.messageID) : undefined
      if (collidedAdmission)
        return yield* createConflict(input, undefined, undefined, "Goal message ID changed ownership during creation")
      return yield* Effect.failCause(published.cause)
    })

    const edit = Effect.fn("SessionGoal.edit")(function* (input: EditInput) {
      yield* requireSession(input.sessionID)
      const current = yield* requireCurrent(read, input.sessionID, input.goalID)
      if (current.goal_id === input.goalID && current.revision === input.expectedRevision + 1) {
        if (current.objective === input.objective) return fromRow(current)
      }
      yield* requireGuard(input, current)
      if (current.objective === input.objective) return fromRow(current)
      if (current.status === "complete")
        return yield* new InvalidStateError({
          sessionID: input.sessionID,
          goalID: input.goalID,
          status: current.status,
          message: "Completed goals are immutable",
        })
      const now = yield* DateTime.now
      return yield* publishUpdate(primary, events, {
        current,
        location: yield* locate(input.sessionID),
        goal: Info.make({
          ...fromRow(current),
          revision: Revision.make(current.revision + 1),
          objective: input.objective,
          time: {
            ...fromRow(current).time,
            updated: now,
          },
        }),
        activeTimeMs: current.active_time_ms,
        timestamp: now,
      })
    })

    const status = Effect.fn("SessionGoal.status")(function* (input: StatusInput) {
      yield* requireSession(input.sessionID)
      const current = yield* requireCurrent(read, input.sessionID, input.goalID)
      if (
        current.goal_id === input.goalID &&
        current.revision === input.expectedRevision + 1 &&
        current.status === input.status
      )
        return fromRow(current)
      yield* requireGuard(input, current)
      if (current.status === input.status) return fromRow(current)
      if (current.status === "complete")
        return yield* new InvalidStateError({
          sessionID: input.sessionID,
          goalID: input.goalID,
          status: current.status,
          message: "Completed goals cannot be resumed",
        })
      const now = yield* DateTime.now
      return yield* publishUpdate(primary, events, {
        current,
        location: yield* locate(input.sessionID),
        goal: Info.make({
          ...fromRow(current),
          revision: Revision.make(current.revision + 1),
          status: input.status,
          time: {
            ...fromRow(current).time,
            updated: now,
            statusChanged: now,
            ...(input.status === "complete" ? { completed: now } : {}),
          },
        }),
        activeTimeMs: current.active_time_ms,
        timestamp: now,
      })
    })

    const clear = Effect.fn("SessionGoal.clear")(function* (input: ClearInput) {
      yield* requireSession(input.sessionID)
      const current = yield* read(input.sessionID)
      if (!current) return
      yield* requireGuard(input, current)
      const location = yield* locate(input.sessionID)
      const published = yield* events
        .publish(
          SessionEvent.Goal.Cleared,
          {
            sessionID: input.sessionID,
            timestamp: yield* DateTime.now,
            goalID: input.goalID,
            revision: input.expectedRevision,
          },
          location ? { location } : undefined,
        )
        .pipe(Effect.exit)
      if (published._tag === "Success") return
      const after = yield* read(input.sessionID)
      if (!after) return
      return yield* conflict(input.sessionID, input.goalID, input.expectedRevision, after, "Goal changed during clear")
    })

    const account = Effect.fn("SessionGoal.account")(function* (input: AccountInput) {
      yield* requireSession(input.sessionID)
      const current = yield* requireCurrent(read, input.sessionID, input.goalID)
      if (
        !Number.isSafeInteger(input.tokenDelta) ||
        input.tokenDelta < 0 ||
        !Number.isSafeInteger(input.activeTimeMsDelta) ||
        input.activeTimeMsDelta < 0
      )
        return yield* new InvalidStateError({
          sessionID: input.sessionID,
          goalID: input.goalID,
          status: current.status,
          message: "Goal usage deltas must be non-negative safe integers",
        })
      const checkpoint = input.checkpointID ? { ...input, checkpointID: input.checkpointID } : undefined
      const recorded = checkpoint ? yield* readTurn(checkpoint.checkpointID) : undefined
      if (recorded && checkpoint) return yield* reconcileTurn(checkpoint, current, recorded)
      const mode = input.mode ?? "ActiveOnly"
      const allowed =
        current.status === "active" ||
        (mode === "ActiveOrComplete" && current.status === "complete") ||
        mode === "ActiveOrStopped"
      const exact = current.goal_id === input.goalID && current.revision === input.expectedRevision
      const stoppedAfterGuard =
        current.goal_id === input.goalID &&
        current.status !== "active" &&
        current.revision === input.expectedRevision + 1 &&
        mode !== "ActiveOnly"
      if (!exact && !stoppedAfterGuard)
        return yield* conflict(
          input.sessionID,
          input.goalID,
          input.expectedRevision,
          current,
          "Goal identity or accounting checkpoint is stale",
        )
      if (!allowed)
        return yield* new InvalidStateError({
          sessionID: input.sessionID,
          goalID: input.goalID,
          status: current.status,
          message: `Accounting mode ${mode} does not include ${current.status} goals`,
        })
      if (input.tokenDelta === 0 && input.activeTimeMsDelta === 0) {
        if (!checkpoint) return fromRow(current)
        const inserted = yield* primary
          .insert(SessionGoalTurnTable)
          .values(turnValues(checkpoint, current.revision, yield* DateTime.now))
          .onConflictDoNothing()
          .returning({ checkpointID: SessionGoalTurnTable.assistant_message_id })
          .get()
          .pipe(Effect.orDie)
        if (inserted) return fromRow(current)
        const existing = yield* readTurn(checkpoint.checkpointID)
        if (existing) return yield* reconcileTurn(checkpoint, current, existing)
        return yield* Effect.die("Goal turn insert conflicted without a durable checkpoint")
      }
      const tokensUsed = current.tokens_used + input.tokenDelta
      const activeTimeMs = current.active_time_ms + input.activeTimeMsDelta
      if (!Number.isSafeInteger(tokensUsed) || !Number.isSafeInteger(activeTimeMs))
        return yield* new InvalidStateError({
          sessionID: input.sessionID,
          goalID: input.goalID,
          status: current.status,
          message: "Goal usage exceeds the supported range",
        })
      const now = yield* DateTime.now
      const goal = Info.make({
        ...fromRow(current),
        revision: Revision.make(current.revision + 1),
        tokensUsed,
        timeUsedSeconds: Math.floor(activeTimeMs / 1_000),
        time: {
          ...fromRow(current).time,
          updated: now,
        },
      })
      const published = yield* publishUpdate(primary, events, {
        current,
        goal,
        activeTimeMs,
        timestamp: now,
        location: yield* locate(input.sessionID),
        ...(checkpoint
          ? {
              commit: () =>
                primary
                  .insert(SessionGoalTurnTable)
                  .values(turnValues(checkpoint, goal.revision, now))
                  .run()
                  .pipe(Effect.orDie),
            }
          : {}),
      }).pipe(Effect.exit)
      if (published._tag === "Success") return published.value
      if (checkpoint) {
        const existing = yield* readTurn(checkpoint.checkpointID)
        const after = yield* read(input.sessionID)
        if (existing && after) return yield* reconcileTurn(checkpoint, after, existing)
      }
      return yield* Effect.failCause(published.cause)
    })

    return Service.of({ get, preflightCreate, create, edit, status, clear, account })
  }),
)

function fromRow(row: typeof SessionGoalTable.$inferSelect): Info {
  return Info.make({
    id: row.goal_id,
    sessionID: row.session_id,
    revision: row.revision,
    objective: Objective.make(row.objective),
    status: row.status,
    tokensUsed: row.tokens_used,
    timeUsedSeconds: Math.floor(row.active_time_ms / 1_000),
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
      statusChanged: DateTime.makeUnsafe(row.status_changed_at),
      ...(row.time_completed === null ? {} : { completed: DateTime.makeUnsafe(row.time_completed) }),
    },
  })
}

function toRow(goal: Info, activeTimeMs: number): typeof SessionGoalTable.$inferInsert {
  return {
    session_id: goal.sessionID,
    goal_id: goal.id,
    revision: goal.revision,
    objective: goal.objective,
    status: goal.status,
    tokens_used: goal.tokensUsed,
    active_time_ms: activeTimeMs,
    status_changed_at: DateTime.toEpochMillis(goal.time.statusChanged),
    time_created: DateTime.toEpochMillis(goal.time.created),
    time_updated: DateTime.toEpochMillis(goal.time.updated),
    time_completed: goal.time.completed ? DateTime.toEpochMillis(goal.time.completed) : null,
  }
}

function requireCurrent(
  read: (sessionID: SessionSchema.ID) => Effect.Effect<typeof SessionGoalTable.$inferSelect | undefined>,
  sessionID: SessionSchema.ID,
  goalID: ID,
) {
  return Effect.gen(function* () {
    const current = yield* read(sessionID)
    if (!current) return yield* new NotFoundError({ sessionID, goalID })
    return current
  })
}

function requireGuard(
  input: { readonly sessionID: SessionSchema.ID; readonly goalID: ID; readonly expectedRevision: Revision },
  current: typeof SessionGoalTable.$inferSelect,
) {
  if (current.goal_id === input.goalID && current.revision === input.expectedRevision) return Effect.void
  return conflict(input.sessionID, input.goalID, input.expectedRevision, current, "Goal identity or revision is stale")
}

function conflict(
  sessionID: SessionSchema.ID,
  goalID: ID | undefined,
  expectedRevision: Revision | undefined,
  current: typeof SessionGoalTable.$inferSelect,
  message: string,
) {
  return new ConflictError({
    sessionID,
    goalID,
    expectedRevision,
    actualGoalID: current.goal_id,
    actualRevision: current.revision,
    message,
  })
}

function createConflict(
  input: CreateInput,
  actualGoalID: ID | undefined,
  actualRevision: Revision | null | undefined,
  message: string,
) {
  return new ConflictError({
    sessionID: input.sessionID,
    goalID: input.id,
    actualGoalID,
    actualRevision: actualRevision ?? undefined,
    message,
  })
}

function reconcileCreate(
  primary: Database.Interface["db"],
  current: typeof SessionGoalTable.$inferSelect,
  input: CreateInput,
) {
  return Effect.gen(function* () {
    if (!input.id && !input.messageID) return undefined
    if ((input.id !== undefined && current.goal_id !== input.id) || current.objective !== input.objective)
      return undefined
    if (!input.messageID) return fromRow(current)
    const admission = yield* SessionInput.findIdentity(primary, input.messageID)
    if (
      !admission ||
      !SessionInput.equivalentIdentity(admission, {
        kind: "goal",
        sessionID: input.sessionID,
        prompt: Prompt.make({ text: input.objective }),
        delivery: "steer",
        agent: input.agent,
        model: input.model,
      })
    )
      return undefined
    return fromRow(current)
  })
}

function publishUpdate(
  primary: Database.Interface["db"],
  events: EventV2.Interface,
  input: {
    readonly current: typeof SessionGoalTable.$inferSelect
    readonly goal: Info
    readonly activeTimeMs: number
    readonly timestamp: DateTime.Utc
    readonly location?: Location.Ref
    readonly commit?: (seq: number) => Effect.Effect<void>
  },
) {
  return events
    .publish(
      SessionEvent.Goal.Updated,
      {
        sessionID: input.goal.sessionID,
        timestamp: input.timestamp,
        goal: input.goal,
        activeTimeMs: input.activeTimeMs,
      },
      input.commit || input.location
        ? { ...(input.commit ? { commit: input.commit } : {}), ...(input.location ? { location: input.location } : {}) }
        : undefined,
    )
    .pipe(
      Effect.as(input.goal),
      Effect.catchDefect((defect) =>
        defect instanceof ProjectionConflict
          ? primary
              .select()
              .from(SessionGoalTable)
              .where(eq(SessionGoalTable.session_id, input.goal.sessionID))
              .get()
              .pipe(
                Effect.orDie,
                Effect.flatMap((actual) =>
                  actual
                    ? conflict(input.goal.sessionID, input.goal.id, input.current.revision, actual, defect.message)
                    : Effect.die(new ProjectionConflict("Goal disappeared after a projection conflict")),
                ),
              )
          : Effect.die(defect),
      ),
    )
}

function turnValues(
  input: AccountInput & { readonly checkpointID: SessionMessage.ID },
  goalRevision: Revision,
  timestamp: DateTime.Utc,
): typeof SessionGoalTurnTable.$inferInsert {
  return {
    assistant_message_id: input.checkpointID,
    session_id: input.sessionID,
    goal_id: input.goalID,
    goal_revision: goalRevision,
    token_delta: input.tokenDelta,
    active_time_ms_delta: input.activeTimeMsDelta,
    time_created: DateTime.toEpochMillis(timestamp),
  }
}

function reconcileTurn(
  input: AccountInput & { readonly checkpointID: SessionMessage.ID },
  current: typeof SessionGoalTable.$inferSelect,
  recorded: typeof SessionGoalTurnTable.$inferSelect,
) {
  if (
    recorded.session_id === input.sessionID &&
    recorded.goal_id === input.goalID &&
    recorded.token_delta === input.tokenDelta &&
    recorded.active_time_ms_delta === input.activeTimeMsDelta &&
    current.goal_id === input.goalID &&
    current.revision >= recorded.goal_revision
  )
    return Effect.succeed(fromRow(current))
  return conflict(
    input.sessionID,
    input.goalID,
    input.expectedRevision,
    current,
    "Provider-turn accounting checkpoint conflicts with durable usage",
  )
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, SessionStore.node],
})
