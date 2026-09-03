export * as ToolExecution from "./execution"

import { createHash, randomUUID } from "node:crypto"
import { and, eq, isNull, lte } from "drizzle-orm"
import { Context, Deferred, Duration, Effect, Exit, Layer } from "effect"
import { ToolOutput } from "@turenlabs/llm"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import type { SessionMessage } from "../session/message"
import type { SessionSchema } from "../session/schema"
import type { ToolOutputStore } from "../tool-output-store"
import { ToolExecutionTable, type StoredSettlement } from "./execution.sql"
import type { Settlement } from "./registry"

export type Status = "running" | "completed" | "indeterminate"

type Claim =
  | { readonly type: "claimed" }
  | { readonly type: "completed"; readonly settlement: Settlement }
  | { readonly type: "conflict" }
  | { readonly type: "indeterminate" }
  | { readonly type: "running" }

type ResolvedClaim = Exclude<Claim, { readonly type: "running" }>

export interface Input {
  readonly sessionID: SessionSchema.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly callID: string
  readonly tool: string
  readonly input: unknown
  readonly retryableError: boolean
}

export interface Interface {
  readonly execute: (
    input: Input,
    execution: Effect.Effect<Settlement, ToolOutputStore.Error>,
  ) => Effect.Effect<Settlement, ToolOutputStore.Error>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/ToolExecution") {}

const lease = Duration.hours(1)
const heartbeatInterval = Duration.minutes(5)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = Database.primary(database.db)
    const active = new Map<
      string,
      { readonly requestHash: string; readonly done: Deferred.Deferred<Settlement, ToolOutputStore.Error> }
    >()

    const execute = Effect.fn("ToolExecution.execute")(function* (
      input: Input,
      execution: Effect.Effect<Settlement, ToolOutputStore.Error>,
    ) {
      const key = JSON.stringify([input.sessionID, input.assistantMessageID, input.callID])
      const requestHash = hash(input)
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const joined = active.get(key)
          if (joined)
            return joined.requestHash === requestHash
              ? yield* restore(Deferred.await(joined.done))
              : error("Tool call identity was reused with a different request")

          const done = Deferred.makeUnsafe<Settlement, ToolOutputStore.Error>()
          active.set(key, { requestHash, done })
          return yield* restore(run(input, requestHash, execution)).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                active.delete(key)
                Deferred.doneUnsafe(done, exit)
              }),
            ),
          )
        }),
      )
    })

    const run = Effect.fn("ToolExecution.run")(function* (
      input: Input,
      requestHash: string,
      execution: Effect.Effect<Settlement, ToolOutputStore.Error>,
    ) {
      const owner = randomUUID()
      const ownedIdentity = and(identityWhere(input), eq(ToolExecutionTable.owner_id, owner))
      const claim = (): Effect.Effect<Claim> =>
        Effect.suspend(() => {
          const now = Date.now()
          return db
            .transaction(
              (tx) =>
                Effect.gen(function* () {
                  yield* tx
                    .insert(ToolExecutionTable)
                    .values({
                      session_id: input.sessionID,
                      assistant_message_id: input.assistantMessageID,
                      call_id: input.callID,
                      request_hash: requestHash,
                      retryable_error: input.retryableError,
                      status: "running",
                      owner_id: owner,
                      lease_expires_at: now + Duration.toMillis(lease),
                      time_created: now,
                      time_updated: now,
                    })
                    .onConflictDoNothing()
                    .run()
                  const row = yield* tx.select().from(ToolExecutionTable).where(identityWhere(input)).get()
                  if (!row) return { type: "indeterminate" as const }
                  if (row.request_hash !== requestHash) return { type: "conflict" as const }
                  if (row.status === "completed")
                    return row.settlement
                      ? { type: "completed" as const, settlement: restoreSettlement(row.settlement) }
                      : { type: "indeterminate" as const }
                  if (row.status === "indeterminate") return { type: "indeterminate" as const }
                  if (row.owner_id === owner) return { type: "claimed" as const }
                  if ((row.lease_expires_at ?? 0) > now) return { type: "running" as const }

                  const ownerCondition =
                    row.owner_id === null
                      ? isNull(ToolExecutionTable.owner_id)
                      : eq(ToolExecutionTable.owner_id, row.owner_id)
                  const leaseCondition =
                    row.lease_expires_at === null
                      ? isNull(ToolExecutionTable.lease_expires_at)
                      : and(
                          eq(ToolExecutionTable.lease_expires_at, row.lease_expires_at),
                          lte(ToolExecutionTable.lease_expires_at, now),
                        )
                  const stale = and(
                    identityWhere(input),
                    eq(ToolExecutionTable.status, "running"),
                    ownerCondition,
                    leaseCondition,
                  )
                  if (row.retryable_error && input.retryableError) {
                    const reclaimed = yield* tx
                      .update(ToolExecutionTable)
                      .set({
                        owner_id: owner,
                        lease_expires_at: now + Duration.toMillis(lease),
                        time_updated: now,
                      })
                      .where(stale)
                      .returning({ owner: ToolExecutionTable.owner_id })
                      .get()
                    return reclaimed ? { type: "claimed" as const } : { type: "running" as const }
                  }
                  const marked = yield* tx
                    .update(ToolExecutionTable)
                    .set({ status: "indeterminate", owner_id: null, lease_expires_at: null, time_updated: now })
                    .where(stale)
                    .returning({ status: ToolExecutionTable.status })
                    .get()
                  return marked ? { type: "indeterminate" as const } : { type: "running" as const }
                }),
              { behavior: "immediate" },
            )
            .pipe(
              Effect.orDie,
              Effect.catchCause((cause) =>
                db
                  .update(ToolExecutionTable)
                  .set({ status: "indeterminate", owner_id: null, lease_expires_at: null, time_updated: Date.now() })
                  .where(and(ownedIdentity, eq(ToolExecutionTable.status, "running")))
                  .run()
                  .pipe(Effect.ignore, Effect.andThen(Effect.failCause(cause))),
              ),
            )
        })

      const waitForOwner = (): Effect.Effect<ResolvedClaim> =>
        Effect.sleep("250 millis").pipe(
          Effect.andThen(db.select().from(ToolExecutionTable).where(identityWhere(input)).get().pipe(Effect.orDie)),
          Effect.flatMap((row): Effect.Effect<ResolvedClaim> => {
            if (!row)
              return input.retryableError
                ? claim().pipe(Effect.flatMap(resolveRunning))
                : Effect.succeed({ type: "indeterminate" })
            if (row.request_hash !== requestHash) return Effect.succeed({ type: "conflict" })
            if (row.status === "completed")
              return Effect.succeed(
                row.settlement
                  ? { type: "completed", settlement: restoreSettlement(row.settlement) }
                  : { type: "indeterminate" },
              )
            if (row.status === "indeterminate") return Effect.succeed({ type: "indeterminate" })
            if ((row.lease_expires_at ?? 0) <= Date.now()) return claim().pipe(Effect.flatMap(resolveRunning))
            return waitForOwner()
          }),
        )

      const resolveRunning = (result: Claim): Effect.Effect<ResolvedClaim> =>
        result.type === "running" ? waitForOwner() : Effect.succeed(result)

      const claimed = yield* claim().pipe(Effect.flatMap(resolveRunning))

      if (claimed.type === "completed") return claimed.settlement
      if (claimed.type === "conflict") return error("Tool call identity was reused with a different request")
      if (claimed.type === "indeterminate")
        return error("Tool call outcome is indeterminate and cannot be safely replayed")

      const markIndeterminate = () =>
        db
          .update(ToolExecutionTable)
          .set({ status: "indeterminate", owner_id: null, lease_expires_at: null, time_updated: Date.now() })
          .where(and(ownedIdentity, eq(ToolExecutionTable.status, "running")))
          .run()
          .pipe(Effect.orDie)
      const heartbeat = Effect.sleep(heartbeatInterval).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            db
              .update(ToolExecutionTable)
              .set({ lease_expires_at: Date.now() + Duration.toMillis(lease), time_updated: Date.now() })
              .where(and(ownedIdentity, eq(ToolExecutionTable.status, "running")))
              .returning({ status: ToolExecutionTable.status })
              .get()
              .pipe(
                Effect.orDie,
                Effect.flatMap((row) =>
                  row ? Effect.void : Effect.die("Tool execution lease ownership was lost during heartbeat"),
                ),
              ),
          ),
        ),
        Effect.forever,
      )
      const monitored = Effect.raceFirst(execution, heartbeat)
      return yield* monitored.pipe(
        Effect.onExit((exit) => {
          const updated = Date.now()
          if (Exit.isSuccess(exit) && exit.value.result.type === "error" && input.retryableError)
            // Opted-in tools own a durable operation that can safely reconcile this exact retry.
            // All other error settlements are completed and replayed like successful results.
            return db
              .delete(ToolExecutionTable)
              .where(ownedIdentity)
              .returning({ status: ToolExecutionTable.status })
              .get()
              .pipe(
                Effect.orDie,
                Effect.flatMap((row) =>
                  row ? Effect.void : Effect.die("Tool execution ownership was lost before retryable release"),
                ),
                Effect.catchCause((cause) =>
                  markIndeterminate().pipe(Effect.ignore, Effect.andThen(Effect.failCause(cause))),
                ),
              )
          if (Exit.isSuccess(exit))
            return db
              .update(ToolExecutionTable)
              .set({
                status: "completed",
                settlement: persistableSettlement(exit.value),
                owner_id: null,
                lease_expires_at: null,
                time_updated: updated,
              })
              .where(and(ownedIdentity, eq(ToolExecutionTable.status, "running")))
              .returning({ status: ToolExecutionTable.status })
              .get()
              .pipe(
                Effect.orDie,
                Effect.flatMap((row) =>
                  row ? Effect.void : Effect.die("Tool execution ownership was lost before completion"),
                ),
                Effect.catchCause((cause) =>
                  markIndeterminate().pipe(Effect.ignore, Effect.andThen(Effect.failCause(cause))),
                ),
              )
          return markIndeterminate()
        }),
      )
    })

    return Service.of({ execute })
  }),
)

function identityWhere(input: Input) {
  return and(
    eq(ToolExecutionTable.session_id, input.sessionID),
    eq(ToolExecutionTable.assistant_message_id, input.assistantMessageID),
    eq(ToolExecutionTable.call_id, input.callID),
  )
}

function hash(input: Input) {
  return createHash("sha256")
    .update(JSON.stringify([input.tool, input.input]) ?? "undefined")
    .digest("hex")
}

function error(value: string): Settlement {
  return { result: { type: "error", value } }
}

/** See `StoredSettlement`: drop the derivable `result` before the row is written. */
function persistableSettlement(settlement: Settlement): StoredSettlement {
  if (settlement.output === undefined) return settlement
  const { result, ...stored } = settlement
  return stored
}

function restoreSettlement(stored: StoredSettlement): Settlement {
  if (stored.result !== undefined) return { ...stored, result: stored.result }
  if (stored.output !== undefined) return { ...stored, result: ToolOutput.toResultValue(stored.output) }
  // A row with neither field cannot be replayed faithfully; surface it the same way an
  // indeterminate claim would rather than inventing a successful result.
  return error("Tool call outcome is indeterminate and cannot be safely replayed")
}

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
