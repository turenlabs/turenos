export * as Loop from "./loop"

import { and, asc, count, desc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm"
import type { EffectDrizzleSqlite } from "@turenlabs/effect-drizzle-sqlite"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { Global } from "./global"
import { Identifier } from "./id/id"
import { LoopRunTable, LoopTable } from "./loop/sql"
import { AgentV2 } from "./agent"
import { ModelV2 } from "./model"

export const MIN_INTERVAL_SECONDS = 60
export const MAX_ACTIVE = 50
export const MAX_ACTIVE_PER_LOCATION = 10
export const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1_000
export const DEFAULT_LEASE_MS = 5 * 60 * 1_000
/** The durable workspace used by Automations that are created without a project. */
export const DEFAULT_LOCATION_DIRECTORY = Global.Path.data

export type ID = string
export type RunID = string
export type Status = "active" | "paused" | "expired"
export type RunStatus = "claimed" | "running" | "succeeded" | "failed" | "cancelled" | "skipped" | "stale"
export type Trigger = "scheduled" | "manual"

/** Per-step overrides; omitted fields inherit the Automation's own agent and model. */
export type StepExecution = {
  readonly agent?: AgentV2.ID
  readonly model?: ModelV2.Ref
}

export type WorkflowStep =
  | ({ readonly id: string; readonly name: string; readonly type: "agent"; readonly prompt: string } & StepExecution)
  | ({
      readonly id: string
      readonly name: string
      readonly type: "skill"
      readonly skill: string
      readonly instructions: string
    } & StepExecution)

export type Workflow = {
  readonly version: 1
  readonly steps: ReadonlyArray<WorkflowStep>
  readonly delivery: { readonly type: "turen" }
}

export type StepArtifact =
  | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
  | { readonly type: "output" | "changed"; readonly path: string }

export type StepOutput = {
  readonly text: string
  readonly json?: unknown
  readonly artifacts: ReadonlyArray<StepArtifact>
}

export type StepOutputs = Readonly<Record<string, StepOutput>>

export type Info = {
  readonly id: ID
  readonly name: string
  readonly prompt: string
  readonly location: { readonly directory: string; readonly workspaceID?: string }
  readonly agent?: AgentV2.ID
  readonly model?: ModelV2.Ref
  readonly skill?: string
  readonly workflow?: Workflow
  readonly status: Status
  readonly schedule: { readonly type: "interval"; readonly seconds: number; readonly timezone: string }
  readonly overlapPolicy: "skip"
  readonly startsAt: number
  readonly nextRunAt?: number
  readonly expiresAt: number
  readonly time: { readonly created: number; readonly updated: number }
}

export type Run = {
  readonly id: RunID
  readonly loopID: ID
  readonly scheduledAt: number
  readonly trigger: Trigger
  readonly status: RunStatus
  readonly currentStep: number
  readonly outputs: StepOutputs
  readonly lease?: { readonly owner: string; readonly expiresAt: number }
  readonly sessionID?: string
  readonly execution?: {
    readonly title: string
    readonly prompt: string
    readonly location: { readonly directory: string; readonly workspaceID?: string }
    readonly agent?: AgentV2.ID
    readonly model?: ModelV2.Ref
    readonly skill?: string
    readonly workflow?: Workflow
  }
  readonly error?: string
  readonly time: {
    readonly created: number
    readonly updated: number
    readonly started?: number
    readonly completed?: number
  }
}

export type CreateInput = {
  readonly id?: ID
  readonly name: string
  readonly prompt: string
  readonly location?: { readonly directory: string; readonly workspaceID?: string }
  readonly agent?: AgentV2.ID
  readonly model?: ModelV2.Ref
  readonly skill?: string
  readonly workflow?: Workflow
  readonly intervalSeconds: number
  readonly timezone?: string
  readonly startsAt?: number
  readonly expiresAt?: number
  readonly paused?: boolean
}

export type EditInput = {
  readonly id: ID
  readonly name?: string
  readonly prompt?: string
  readonly intervalSeconds?: number
  readonly timezone?: string
  readonly expiresAt?: number
  readonly agent?: AgentV2.ID
  readonly model?: ModelV2.Ref
  readonly skill?: string
  readonly workflow?: Workflow
  readonly resetAgent?: boolean
  readonly resetModel?: boolean
  readonly resetSkill?: boolean
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("LoopNotFoundError", {
  id: Schema.String,
}) {}

export class RunNotFoundError extends Schema.TaggedErrorClass<RunNotFoundError>()("LoopRunNotFoundError", {
  id: Schema.String,
}) {}

export class InvalidInputError extends Schema.TaggedErrorClass<InvalidInputError>()("LoopInvalidInputError", {
  message: Schema.String,
}) {}

export class ActiveLimitError extends Schema.TaggedErrorClass<ActiveLimitError>()("LoopActiveLimitError", {
  limit: Schema.Number,
}) {}

export class InvalidStateError extends Schema.TaggedErrorClass<InvalidStateError>()("LoopInvalidStateError", {
  id: Schema.String,
  message: Schema.String,
}) {}

type Error = NotFoundError | InvalidInputError | ActiveLimitError | InvalidStateError
type DatabaseTransaction = Parameters<Parameters<EffectDrizzleSqlite.EffectSQLiteDatabase["transaction"]>[0]>[0]

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<Info, InvalidInputError | ActiveLimitError>
  readonly list: () => Effect.Effect<ReadonlyArray<Info>>
  readonly get: (id: ID) => Effect.Effect<Info, NotFoundError>
  readonly edit: (input: EditInput) => Effect.Effect<Info, NotFoundError | InvalidInputError | InvalidStateError>
  readonly pause: (id: ID) => Effect.Effect<Info, NotFoundError | InvalidStateError>
  readonly resume: (id: ID) => Effect.Effect<Info, NotFoundError | InvalidStateError | ActiveLimitError>
  readonly delete: (id: ID) => Effect.Effect<boolean, InvalidStateError>
  readonly runNow: (input: {
    readonly id: ID
    readonly owner: string
    readonly leaseMs?: number
  }) => Effect.Effect<Run, Error>
  readonly cancelRun: (input: {
    readonly id: RunID
    readonly loopID?: ID
  }) => Effect.Effect<Run, NotFoundError | RunNotFoundError | InvalidStateError>
  readonly listRuns: (loopID: ID) => Effect.Effect<ReadonlyArray<Run>, NotFoundError>
  readonly getRun: (input: {
    readonly id: RunID
    readonly loopID?: ID
  }) => Effect.Effect<Run, NotFoundError | RunNotFoundError>
  readonly claimDue: (input: {
    readonly owner: string
    readonly limit?: number
    readonly leaseMs?: number
  }) => Effect.Effect<ReadonlyArray<Run>, InvalidInputError>
  readonly recordRunSession: (input: {
    readonly id: RunID
    readonly owner: string
    readonly sessionID: string
  }) => Effect.Effect<Run, RunNotFoundError | InvalidStateError>
  readonly startRun: (input: {
    readonly id: RunID
    readonly owner: string
    readonly sessionID: string
    readonly currentStep?: number
  }) => Effect.Effect<Run, RunNotFoundError | InvalidStateError>
  readonly completeRunStep: (input: {
    readonly id: RunID
    readonly owner: string
    readonly currentStep: number
    readonly stepID: string
    readonly output: StepOutput
  }) => Effect.Effect<Run, RunNotFoundError | InvalidStateError>
  readonly renewRun: (input: {
    readonly id: RunID
    readonly owner: string
    readonly leaseMs?: number
  }) => Effect.Effect<Run, RunNotFoundError | InvalidStateError | InvalidInputError>
  readonly finishRun: (input: {
    readonly id: RunID
    readonly owner: string
    readonly status: "succeeded" | "failed"
    readonly error?: string
  }) => Effect.Effect<Run, RunNotFoundError | InvalidStateError>
}

export class Service extends Context.Service<Service, Interface>()("@forge/Loop") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = Database.primary(database.db)

    const get = Effect.fn("Loop.get")(function* (id: ID) {
      const row = yield* db.select().from(LoopTable).where(eq(LoopTable.id, id)).get().pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ id })
      return toInfo(row)
    })

    const getRun = Effect.fn("Loop.getRun")(function* (id: RunID) {
      const row = yield* db.select().from(LoopRunTable).where(eq(LoopRunTable.id, id)).get().pipe(Effect.orDie)
      if (!row) return yield* new RunNotFoundError({ id })
      return row
    })

    const create = Effect.fn("Loop.create")(function* (input: CreateInput) {
      const invalidInterval = validateInterval(input.intervalSeconds)
      if (invalidInterval) return yield* invalidInterval
      if (!input.name.trim()) return yield* new InvalidInputError({ message: "A name is required" })
      const location = input.location ?? { directory: DEFAULT_LOCATION_DIRECTORY }
      if (!location.directory.trim())
        return yield* new InvalidInputError({ message: "A project directory is required" })
      const invalidWorkflow = input.workflow ? validateWorkflow(input.workflow) : undefined
      if (invalidWorkflow) return yield* invalidWorkflow
      if (!input.prompt.trim() && !input.skill && !input.workflow)
        return yield* new InvalidInputError({ message: "A custom prompt or skill is required" })
      const now = Date.now()
      const startsAt = input.startsAt ?? now
      const expiresAt = input.expiresAt ?? now + DEFAULT_EXPIRY_MS
      if (expiresAt <= now) return yield* new InvalidInputError({ message: "Expiry must be in the future" })
      if (expiresAt > now + DEFAULT_EXPIRY_MS)
        return yield* new InvalidInputError({ message: "Loops may run for at most seven days" })
      if (startsAt > expiresAt) return yield* new InvalidInputError({ message: "Start must not be after expiry" })
      const status = input.paused ? "paused" : "active"
      const row = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              if (status === "active" && !(yield* hasCapacity(tx, location, now))) return { type: "limit" } as const
              const created = yield* tx
                .insert(LoopTable)
                .values({
                  id: input.id ?? Identifier.create("lop", "ascending"),
                  name: input.name,
                  prompt: input.prompt,
                  directory: location.directory,
                  workspace_id: location.workspaceID,
                  agent: input.agent,
                  model: input.model,
                  skill: input.skill,
                  workflow: input.workflow,
                  status,
                  schedule_type: "interval",
                  interval_seconds: input.intervalSeconds,
                  timezone: input.timezone ?? "UTC",
                  overlap_policy: "skip",
                  starts_at: startsAt,
                  next_run_at: status === "active" ? startsAt : null,
                  expires_at: expiresAt,
                  time_created: now,
                  time_updated: now,
                })
                .returning()
                .get()
              return { type: "created", row: created } as const
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      if (row.type === "limit") return yield* new ActiveLimitError({ limit: MAX_ACTIVE })
      return toInfo(row.row!)
    })

    const list = Effect.fn("Loop.list")(function* () {
      const rows = yield* db
        .select()
        .from(LoopTable)
        .orderBy(desc(LoopTable.time_created), desc(LoopTable.id))
        .all()
        .pipe(Effect.orDie)
      return rows.map(toInfo)
    })

    const edit = Effect.fn("Loop.edit")(function* (input: EditInput) {
      const invalidInterval = input.intervalSeconds === undefined ? undefined : validateInterval(input.intervalSeconds)
      if (invalidInterval) return yield* invalidInterval
      if (input.name !== undefined && !input.name.trim())
        return yield* new InvalidInputError({ message: "A name is required" })
      const invalidWorkflow = input.workflow ? validateWorkflow(input.workflow) : undefined
      if (invalidWorkflow) return yield* invalidWorkflow
      const now = Date.now()
      const result = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const current = yield* tx.select().from(LoopTable).where(eq(LoopTable.id, input.id)).get()
              if (!current) return { type: "not-found" } as const
              if (current.expires_at <= now) return { type: "state" } as const
              const nextSkill = input.resetSkill ? undefined : (input.skill ?? current.skill ?? undefined)
              if (!(input.prompt ?? current.prompt).trim() && !nextSkill && !(input.workflow ?? current.workflow))
                return { type: "task" } as const
              if (input.expiresAt !== undefined && input.expiresAt <= now) return { type: "expiry" } as const
              if (input.expiresAt !== undefined && input.expiresAt > current.time_created + DEFAULT_EXPIRY_MS)
                return { type: "lifetime" } as const
              const row = yield* tx
                .update(LoopTable)
                .set({
                  name: input.name,
                  prompt: input.prompt,
                  interval_seconds: input.intervalSeconds,
                  timezone: input.timezone,
                  agent: input.resetAgent ? null : input.agent,
                  model: input.resetModel ? null : input.model,
                  skill: input.resetSkill ? null : input.skill,
                  workflow: input.workflow,
                  expires_at: input.expiresAt,
                  next_run_at:
                    current.status === "active" && input.intervalSeconds !== undefined
                      ? now + input.intervalSeconds * 1_000
                      : undefined,
                  time_updated: now,
                })
                .where(eq(LoopTable.id, input.id))
                .returning()
                .get()
              return { type: "edited", row } as const
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      if (result.type === "not-found") return yield* new NotFoundError({ id: input.id })
      if (result.type === "state") return yield* new InvalidStateError({ id: input.id, message: "Loop has expired" })
      if (result.type === "task")
        return yield* new InvalidInputError({ message: "A custom prompt or skill is required" })
      if (result.type === "expiry") return yield* new InvalidInputError({ message: "Expiry must be in the future" })
      if (result.type === "lifetime")
        return yield* new InvalidInputError({ message: "Loops may run for at most seven days" })
      return toInfo(result.row)
    })

    const pause = Effect.fn("Loop.pause")(function* (id: ID) {
      const current = yield* get(id)
      if (current.status !== "active") return yield* new InvalidStateError({ id, message: "Loop is not active" })
      const row = yield* db
        .update(LoopTable)
        .set({ status: "paused", next_run_at: null, time_updated: Date.now() })
        .where(and(eq(LoopTable.id, id), eq(LoopTable.status, "active")))
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new InvalidStateError({ id, message: "Loop changed concurrently" })
      return toInfo(row)
    })

    const resume = Effect.fn("Loop.resume")(function* (id: ID) {
      const now = Date.now()
      const result = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const current = yield* tx.select().from(LoopTable).where(eq(LoopTable.id, id)).get()
              if (!current) return { type: "not-found" } as const
              if (current.status !== "paused") return { type: "state", message: "Loop is not paused" } as const
              if (current.expires_at <= now) return { type: "state", message: "Loop has expired" } as const
              if (
                !(yield* hasCapacity(
                  tx,
                  { directory: current.directory, workspaceID: current.workspace_id ?? undefined },
                  now,
                ))
              )
                return { type: "limit" } as const
              const row = yield* tx
                .update(LoopTable)
                .set({ status: "active", next_run_at: now + current.interval_seconds * 1_000, time_updated: now })
                .where(eq(LoopTable.id, id))
                .returning()
                .get()
              return { type: "resumed", row } as const
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      if (result.type === "not-found") return yield* new NotFoundError({ id })
      if (result.type === "state") return yield* new InvalidStateError({ id, message: result.message })
      if (result.type === "limit") return yield* new ActiveLimitError({ limit: MAX_ACTIVE })
      return toInfo(result.row!)
    })

    const remove = Effect.fn("Loop.delete")(function* (id: ID) {
      const now = Date.now()
      const result = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              if (yield* activeRun(tx, id, now)) return { active: true } as const
              const row = yield* tx.delete(LoopTable).where(eq(LoopTable.id, id)).returning({ id: LoopTable.id }).get()
              return { active: false, removed: row !== undefined } as const
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      if (result.active)
        return yield* new InvalidStateError({ id, message: "Cancel the active run before deleting this Loop" })
      return result.removed
    })

    const runNow = Effect.fn("Loop.runNow")(function* (input: {
      readonly id: ID
      readonly owner: string
      readonly leaseMs?: number
    }) {
      const leaseMs = validateLease(input.leaseMs)
      if (leaseMs instanceof InvalidInputError) return yield* leaseMs
      const now = Date.now()
      const result = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const loop = yield* tx.select().from(LoopTable).where(eq(LoopTable.id, input.id)).get()
              if (!loop) return { type: "not-found" } as const
              if (loop.expires_at <= now) return { type: "expired" } as const
              const active = yield* activeRun(tx, input.id, now)
              const latest = yield* tx
                .select({ scheduledAt: LoopRunTable.scheduled_at })
                .from(LoopRunTable)
                .where(eq(LoopRunTable.loop_id, input.id))
                .orderBy(desc(LoopRunTable.scheduled_at))
                .limit(1)
                .get()
              const scheduledAt = Math.max(now, (latest?.scheduledAt ?? now - 1) + 1)
              const row = yield* tx
                .insert(LoopRunTable)
                .values(
                  runValues(
                    loop,
                    scheduledAt,
                    "manual",
                    active ? "skipped" : "claimed",
                    now,
                    active ? undefined : input.owner,
                    active ? undefined : now + leaseMs,
                  ),
                )
                .returning()
                .get()
              return { type: "run", row } as const
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      if (result.type === "not-found") return yield* new NotFoundError({ id: input.id })
      if (result.type === "expired") return yield* new InvalidStateError({ id: input.id, message: "Loop has expired" })
      return toRun(result.row)
    })

    const claimDue = Effect.fn("Loop.claimDue")(function* (input: {
      readonly owner: string
      readonly limit?: number
      readonly leaseMs?: number
    }) {
      const limit = input.limit ?? 10
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ACTIVE)
        return yield* new InvalidInputError({ message: `Claim limit must be between 1 and ${MAX_ACTIVE}` })
      const leaseMs = validateLease(input.leaseMs)
      if (leaseMs instanceof InvalidInputError) return yield* leaseMs
      const now = Date.now()
      const rows = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              yield* tx
                .update(LoopRunTable)
                .set({
                  status: "stale",
                  lease_owner: null,
                  lease_expires_at: null,
                  time_updated: now,
                  time_completed: now,
                })
                .where(and(eq(LoopRunTable.status, "running"), lte(LoopRunTable.lease_expires_at, now)))
                .run()
              yield* tx
                .update(LoopTable)
                .set({ status: "expired", next_run_at: null, time_updated: now })
                .where(and(eq(LoopTable.status, "active"), lte(LoopTable.expires_at, now)))
                .run()
              const recoverable = yield* tx
                .select({ id: LoopRunTable.id })
                .from(LoopRunTable)
                .where(and(eq(LoopRunTable.status, "claimed"), lte(LoopRunTable.lease_expires_at, now)))
                .orderBy(asc(LoopRunTable.time_created), asc(LoopRunTable.id))
                .limit(limit)
                .all()
              const recovered = recoverable.length
                ? yield* tx
                    .update(LoopRunTable)
                    .set({ lease_owner: input.owner, lease_expires_at: now + leaseMs, time_updated: now })
                    .where(
                      inArray(
                        LoopRunTable.id,
                        recoverable.map((row) => row.id),
                      ),
                    )
                    .returning()
                    .all()
                : []
              const pendingManual = yield* tx
                .select({ id: LoopRunTable.id })
                .from(LoopRunTable)
                .where(
                  and(
                    eq(LoopRunTable.status, "claimed"),
                    eq(LoopRunTable.lease_owner, "manual"),
                    gt(LoopRunTable.lease_expires_at, now),
                  ),
                )
                .orderBy(asc(LoopRunTable.time_created), asc(LoopRunTable.id))
                .limit(Math.max(0, limit - recovered.length))
                .all()
              const manual = pendingManual.length
                ? yield* tx
                    .update(LoopRunTable)
                    .set({ lease_owner: input.owner, lease_expires_at: now + leaseMs, time_updated: now })
                    .where(
                      inArray(
                        LoopRunTable.id,
                        pendingManual.map((row) => row.id),
                      ),
                    )
                    .returning()
                    .all()
                : []
              const due = yield* tx
                .select()
                .from(LoopTable)
                .where(
                  and(eq(LoopTable.status, "active"), lte(LoopTable.next_run_at, now), gt(LoopTable.expires_at, now)),
                )
                .orderBy(asc(LoopTable.next_run_at), asc(LoopTable.id))
                .limit(Math.max(0, limit - recovered.length - manual.length))
                .all()
              const scheduled = yield* Effect.forEach(due, (loop) =>
                Effect.gen(function* () {
                  const scheduledAt = loop.next_run_at as number
                  const active = yield* activeRun(tx, loop.id, now)
                  const run = yield* tx
                    .insert(LoopRunTable)
                    .values(
                      runValues(
                        loop,
                        scheduledAt,
                        "scheduled",
                        active ? "skipped" : "claimed",
                        now,
                        active ? undefined : input.owner,
                        active ? undefined : now + leaseMs,
                      ),
                    )
                    .onConflictDoNothing()
                    .returning()
                    .get()
                  const next = Math.max(
                    scheduledAt + loop.interval_seconds * 1_000,
                    now + loop.interval_seconds * 1_000,
                  )
                  yield* tx
                    .update(LoopTable)
                    .set({
                      status: next > loop.expires_at ? "expired" : "active",
                      next_run_at: next > loop.expires_at ? null : next,
                      time_updated: now,
                    })
                    .where(and(eq(LoopTable.id, loop.id), eq(LoopTable.next_run_at, scheduledAt)))
                    .run()
                  return run
                }),
              )
              return [...recovered, ...manual, ...scheduled]
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      return rows.filter((row): row is NonNullable<typeof row> => row !== undefined).map(toRun)
    })

    const cancelRun = Effect.fn("Loop.cancelRun")(function* (input: { readonly id: RunID; readonly loopID?: ID }) {
      const current = yield* getRun(input.id)
      if (input.loopID !== undefined && current.loop_id !== input.loopID)
        return yield* new NotFoundError({ id: input.id })
      if (current.status !== "claimed" && current.status !== "running")
        return yield* new InvalidStateError({ id: input.id, message: "Run is not active" })
      const now = Date.now()
      const row = yield* db
        .update(LoopRunTable)
        .set({ status: "cancelled", lease_owner: null, lease_expires_at: null, time_updated: now, time_completed: now })
        .where(and(eq(LoopRunTable.id, input.id), inArray(LoopRunTable.status, ["claimed", "running"])))
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new InvalidStateError({ id: input.id, message: "Run changed concurrently" })
      return toRun(row)
    })

    const listRuns = Effect.fn("Loop.listRuns")(function* (loopID: ID) {
      yield* get(loopID)
      const rows = yield* db
        .select()
        .from(LoopRunTable)
        .where(eq(LoopRunTable.loop_id, loopID))
        .orderBy(desc(LoopRunTable.time_created), desc(LoopRunTable.id))
        .all()
        .pipe(Effect.orDie)
      return rows.map(toRun)
    })

    const findRun = Effect.fn("Loop.findRun")(function* (input: { readonly id: RunID; readonly loopID?: ID }) {
      const row = yield* getRun(input.id)
      if (input.loopID !== undefined && row.loop_id !== input.loopID) return yield* new NotFoundError({ id: input.id })
      return toRun(row)
    })

    const recordRunSession = Effect.fn("Loop.recordRunSession")(function* (input: {
      readonly id: RunID
      readonly owner: string
      readonly sessionID: string
    }) {
      const now = Date.now()
      const row = yield* db
        .update(LoopRunTable)
        .set({ session_id: input.sessionID, time_updated: now })
        .where(
          and(
            eq(LoopRunTable.id, input.id),
            eq(LoopRunTable.status, "claimed"),
            eq(LoopRunTable.lease_owner, input.owner),
            gt(LoopRunTable.lease_expires_at, now),
            or(isNull(LoopRunTable.session_id), eq(LoopRunTable.session_id, input.sessionID)),
          ),
        )
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (row) return toRun(row)
      yield* getRun(input.id)
      return yield* new InvalidStateError({ id: input.id, message: "Run Session cannot be recorded by this owner" })
    })

    const startRun = Effect.fn("Loop.startRun")(function* (input: {
      readonly id: RunID
      readonly owner: string
      readonly sessionID: string
      readonly currentStep?: number
    }) {
      const now = Date.now()
      const row = yield* db
        .update(LoopRunTable)
        .set({ status: "running", time_started: now, time_updated: now })
        .where(
          and(
            eq(LoopRunTable.id, input.id),
            eq(LoopRunTable.status, "claimed"),
            eq(LoopRunTable.session_id, input.sessionID),
            eq(LoopRunTable.lease_owner, input.owner),
            gt(LoopRunTable.lease_expires_at, now),
            input.currentStep === undefined ? undefined : eq(LoopRunTable.current_step, input.currentStep),
          ),
        )
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (row) return toRun(row)
      yield* getRun(input.id)
      return yield* new InvalidStateError({ id: input.id, message: "Run is not claimable by this owner" })
    })

    const completeRunStep = Effect.fn("Loop.completeRunStep")(function* (input: {
      readonly id: RunID
      readonly owner: string
      readonly currentStep: number
      readonly stepID: string
      readonly output: StepOutput
    }) {
      const now = Date.now()
      const current = yield* getRun(input.id)
      const row = yield* db
        .update(LoopRunTable)
        .set({
          status: "claimed",
          current_step: input.currentStep + 1,
          step_outputs: { ...(current.step_outputs ?? {}), [input.stepID]: input.output },
          time_updated: now,
        })
        .where(
          and(
            eq(LoopRunTable.id, input.id),
            eq(LoopRunTable.status, "running"),
            eq(LoopRunTable.current_step, input.currentStep),
            eq(LoopRunTable.lease_owner, input.owner),
            gt(LoopRunTable.lease_expires_at, now),
          ),
        )
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (row) return toRun(row)
      yield* getRun(input.id)
      return yield* new InvalidStateError({
        id: input.id,
        message: "Automation step cannot be completed by this owner",
      })
    })

    const renewRun = Effect.fn("Loop.renewRun")(function* (input: {
      readonly id: RunID
      readonly owner: string
      readonly leaseMs?: number
    }) {
      const leaseMs = validateLease(input.leaseMs)
      if (leaseMs instanceof InvalidInputError) return yield* leaseMs
      const now = Date.now()
      const row = yield* db
        .update(LoopRunTable)
        .set({ lease_expires_at: now + leaseMs, time_updated: now })
        .where(
          and(
            eq(LoopRunTable.id, input.id),
            inArray(LoopRunTable.status, ["claimed", "running"]),
            eq(LoopRunTable.lease_owner, input.owner),
            gt(LoopRunTable.lease_expires_at, now),
          ),
        )
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (row) return toRun(row)
      yield* getRun(input.id)
      return yield* new InvalidStateError({ id: input.id, message: "Run lease is not renewable by this owner" })
    })

    const finishRun = Effect.fn("Loop.finishRun")(function* (input: {
      readonly id: RunID
      readonly owner: string
      readonly status: "succeeded" | "failed"
      readonly error?: string
    }) {
      const now = Date.now()
      const row = yield* db
        .update(LoopRunTable)
        .set({
          status: input.status,
          error: input.error,
          lease_owner: null,
          lease_expires_at: null,
          time_updated: now,
          time_completed: now,
        })
        .where(
          and(
            eq(LoopRunTable.id, input.id),
            inArray(LoopRunTable.status, ["claimed", "running"]),
            eq(LoopRunTable.lease_owner, input.owner),
            gt(LoopRunTable.lease_expires_at, now),
          ),
        )
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (row) return toRun(row)
      yield* getRun(input.id)
      return yield* new InvalidStateError({ id: input.id, message: "Run is not finishable by this owner" })
    })

    return Service.of({
      create,
      list,
      get,
      edit,
      pause,
      resume,
      delete: remove,
      runNow,
      cancelRun,
      listRuns,
      getRun: findRun,
      claimDue,
      recordRunSession,
      startRun,
      completeRunStep,
      renewRun,
      finishRun,
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })

function validateInterval(seconds: number) {
  if (Number.isSafeInteger(seconds) && seconds >= MIN_INTERVAL_SECONDS) return
  return new InvalidInputError({ message: `Interval must be an integer of at least ${MIN_INTERVAL_SECONDS} seconds` })
}

function validateLease(leaseMs = DEFAULT_LEASE_MS) {
  if (Number.isSafeInteger(leaseMs) && leaseMs > 0) return leaseMs
  return new InvalidInputError({ message: "Lease must be a positive integer in milliseconds" })
}

function hasCapacity(
  tx: DatabaseTransaction,
  location: { readonly directory: string; readonly workspaceID?: string },
  now: number,
) {
  return Effect.gen(function* () {
    const global = yield* tx
      .select({ value: count() })
      .from(LoopTable)
      .where(and(eq(LoopTable.status, "active"), gt(LoopTable.expires_at, now)))
      .get()
    if ((global?.value ?? 0) >= MAX_ACTIVE) return false
    const perLocation = yield* tx
      .select({ value: count() })
      .from(LoopTable)
      .where(
        and(
          eq(LoopTable.status, "active"),
          gt(LoopTable.expires_at, now),
          eq(LoopTable.directory, location.directory),
          ...(location.workspaceID
            ? [eq(LoopTable.workspace_id, location.workspaceID)]
            : [isNull(LoopTable.workspace_id)]),
        ),
      )
      .get()
    return (perLocation?.value ?? 0) < MAX_ACTIVE_PER_LOCATION
  })
}

function activeRun(tx: DatabaseTransaction, loopID: ID, now: number) {
  return tx
    .select({ id: LoopRunTable.id })
    .from(LoopRunTable)
    .where(
      and(
        eq(LoopRunTable.loop_id, loopID),
        inArray(LoopRunTable.status, ["claimed", "running"]),
        or(isNull(LoopRunTable.lease_expires_at), gt(LoopRunTable.lease_expires_at, now)),
      ),
    )
    .get()
}

function runValues(
  loop: typeof LoopTable.$inferSelect,
  scheduledAt: number,
  trigger: Trigger,
  status: RunStatus,
  now: number,
  owner?: string,
  leaseExpiresAt?: number,
) {
  return {
    id: Identifier.create("lrn", "ascending"),
    loop_id: loop.id,
    scheduled_at: scheduledAt,
    trigger,
    status,
    current_step: 0,
    step_outputs: {},
    lease_owner: owner,
    lease_expires_at: leaseExpiresAt,
    execution_title: loop.name,
    execution_prompt: loop.prompt,
    execution_directory: loop.directory,
    execution_workspace_id: loop.workspace_id,
    execution_agent: loop.agent,
    execution_model: loop.model,
    execution_skill: loop.skill,
    execution_workflow: loop.workflow,
    time_created: now,
    time_updated: now,
    time_completed: status === "skipped" ? now : undefined,
  }
}

function toInfo(row: typeof LoopTable.$inferSelect): Info {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    location: { directory: row.directory, ...(row.workspace_id ? { workspaceID: row.workspace_id } : {}) },
    ...(row.agent ? { agent: AgentV2.ID.make(row.agent) } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.skill ? { skill: row.skill } : {}),
    ...(row.workflow ? { workflow: row.workflow } : {}),
    status: row.status,
    schedule: { type: "interval", seconds: row.interval_seconds, timezone: row.timezone },
    overlapPolicy: "skip",
    startsAt: row.starts_at,
    ...(row.next_run_at === null ? {} : { nextRunAt: row.next_run_at }),
    expiresAt: row.expires_at,
    time: { created: row.time_created, updated: row.time_updated },
  }
}

function toRun(row: typeof LoopRunTable.$inferSelect): Run {
  return {
    id: row.id,
    loopID: row.loop_id,
    scheduledAt: row.scheduled_at,
    trigger: row.trigger,
    status: row.status,
    currentStep: row.current_step,
    outputs: row.step_outputs,
    ...(row.lease_owner && row.lease_expires_at !== null
      ? { lease: { owner: row.lease_owner, expiresAt: row.lease_expires_at } }
      : {}),
    ...(row.session_id ? { sessionID: row.session_id } : {}),
    ...(row.execution_title !== null && row.execution_directory !== null && row.execution_prompt !== null
      ? {
          execution: {
            title: row.execution_title,
            prompt: row.execution_prompt,
            location: {
              directory: row.execution_directory,
              ...(row.execution_workspace_id ? { workspaceID: row.execution_workspace_id } : {}),
            },
            ...(row.execution_agent ? { agent: AgentV2.ID.make(row.execution_agent) } : {}),
            ...(row.execution_model ? { model: row.execution_model } : {}),
            ...(row.execution_skill ? { skill: row.execution_skill } : {}),
            ...(row.execution_workflow ? { workflow: row.execution_workflow } : {}),
          },
        }
      : {}),
    ...(row.error ? { error: row.error } : {}),
    time: {
      created: row.time_created,
      updated: row.time_updated,
      ...(row.time_started === null ? {} : { started: row.time_started }),
      ...(row.time_completed === null ? {} : { completed: row.time_completed }),
    },
  }
}

function validateWorkflow(workflow: Workflow) {
  if (workflow.version !== 1 || workflow.delivery.type !== "turen")
    return new InvalidInputError({ message: "Unsupported Automation workflow version or delivery" })
  if (workflow.steps.length < 1 || workflow.steps.length > 12)
    return new InvalidInputError({ message: "An Automation requires between 1 and 12 steps" })
  if (new Set(workflow.steps.map((step) => step.id)).size !== workflow.steps.length)
    return new InvalidInputError({ message: "Automation step IDs must be unique" })
  const invalid = workflow.steps.find(
    (step) =>
      !/^[A-Za-z][A-Za-z0-9_-]*$/.test(step.id) ||
      !step.name.trim() ||
      (step.type === "agent" ? !step.prompt.trim() : !step.skill.trim()),
  )
  if (invalid)
    return new InvalidInputError({ message: "Every Automation step requires an expression-safe ID, name, and task" })
  for (const [index, step] of workflow.steps.entries()) {
    const template = step.type === "agent" ? step.prompt : step.instructions
    if (template.replace(BINDING, "").includes("{{") || template.replace(BINDING, "").includes("}}"))
      return new InvalidInputError({ message: `Malformed Automation binding in step ${step.id}` })
    for (const binding of parseBindings(template)) {
      if (binding[0] === "trigger") {
        const direct = binding.length === 2 && (binding[1] === "type" || binding[1] === "scheduledAt")
        const payload =
          binding.length === 3 &&
          binding[1] === "payload" &&
          ["repository", "directory", "workspaceID"].includes(binding[2])
        if (!direct && !payload)
          return new InvalidInputError({ message: `Unsupported Automation trigger binding: ${binding.join(".")}` })
        continue
      }
      if (binding[0] !== "steps" || (binding[2] !== "output" && binding[2] !== "artifacts"))
        return new InvalidInputError({ message: `Unsupported Automation binding: ${binding.join(".")}` })
      const source = workflow.steps.findIndex((item) => item.id === binding[1])
      if (source < 0 || source >= index)
        return new InvalidInputError({ message: `Automation step ${step.id} must reference an earlier step` })
    }
  }
}

const BINDING = /{{\s*([A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+)\s*}}/g

export function parseBindings(template: string) {
  return [...template.matchAll(BINDING)].map((match) => match[1].split("."))
}

export function resolveBindings(
  template: string,
  context: {
    readonly trigger: {
      readonly type: Trigger
      readonly scheduledAt: number
      readonly payload: Readonly<Record<string, unknown>>
    }
    readonly steps: StepOutputs
  },
) {
  return template.replace(BINDING, (_token, path: string) => {
    const parts = path.split(".")
    const step = parts[0] === "steps" ? context.steps[parts[1]] : undefined
    const root =
      step && parts[2] === "output"
        ? (step.json ?? step.text)
        : step && parts[2] === "artifacts"
          ? step.artifacts
          : context
    const remaining = step ? parts.slice(3) : parts
    const value = remaining.reduce<unknown>(
      (current, part) =>
        current && typeof current === "object" && part in current
          ? (current as Record<string, unknown>)[part]
          : undefined,
      root,
    )
    if (value === undefined) throw new Error(`Automation binding is unavailable: ${path}`)
    return typeof value === "string" ? value : JSON.stringify(value)
  })
}
