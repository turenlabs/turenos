import { describe, expect } from "bun:test"
import { createHash } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { SessionMessage } from "@turenlabs/core/session/message"
import { SessionSchema } from "@turenlabs/core/session/schema"
import { ToolExecution } from "@turenlabs/core/tool/execution"
import { ToolExecutionTable, type StoredSettlement } from "@turenlabs/core/tool/execution.sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, ToolExecution.node])))

const identity = (callID: string, overrides?: Partial<ToolExecution.Input>): ToolExecution.Input => ({
  sessionID: SessionSchema.ID.make("ses_tool_execution"),
  assistantMessageID: SessionMessage.ID.make("msg_tool_execution"),
  callID,
  tool: "read",
  input: { path: "README.md" },
  retryableError: false,
  ...overrides,
})

type Settlement = Parameters<ToolExecution.Interface["execute"]>[1] extends Effect.Effect<infer S, infer _E> ? S : never

/**
 * Execute once, capture the stored row, optionally rewrite it, then execute the exact same
 * call again with an execution that dies — proving the replay came from the row alone.
 */
const roundTrip = (callID: string, settlement: Settlement, rewrite?: Settlement) =>
  Effect.gen(function* () {
    const executions = yield* ToolExecution.Service
    const database = yield* Database.Service
    const first = yield* executions.execute(identity(callID), Effect.succeed(settlement))
    const where = and(
      eq(ToolExecutionTable.session_id, SessionSchema.ID.make("ses_tool_execution")),
      eq(ToolExecutionTable.call_id, callID),
    )
    const row = yield* database.db
      .select({ settlement: ToolExecutionTable.settlement })
      .from(ToolExecutionTable)
      .where(where)
      .get()
      .pipe(Effect.orDie)
    if (rewrite)
      yield* database.db.update(ToolExecutionTable).set({ settlement: rewrite }).where(where).run().pipe(Effect.orDie)
    const replayed = yield* executions.execute(identity(callID), Effect.die("must not re-execute"))
    return { first, stored: row?.settlement, replayed }
  })

const indeterminate: Settlement = { result: { type: "error", value: "Tool call outcome is indeterminate and cannot be safely replayed" } }
const reused: Settlement = { result: { type: "error", value: "Tool call identity was reused with a different request" } }

/**
 * Mirrors `hash(input)` in the service: the request hash binds a claim to (tool, input).
 * Direct row seeding is how the tests reach claim states that the process-local `active`
 * map would otherwise short-circuit — a row owned by another process is exactly what a
 * crashed owner leaves behind.
 */
const seedRow = (
  input: ToolExecution.Input,
  state: {
    status: "running" | "completed" | "indeterminate"
    owner_id?: string | null
    lease_expires_at?: number | null
    settlement?: StoredSettlement | null
  },
) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const now = Date.now()
    yield* database.db
      .insert(ToolExecutionTable)
      .values({
        session_id: input.sessionID,
        assistant_message_id: input.assistantMessageID,
        call_id: input.callID,
        request_hash: createHash("sha256").update(JSON.stringify([input.tool, input.input])).digest("hex"),
        retryable_error: input.retryableError,
        status: state.status,
        owner_id: state.owner_id ?? null,
        settlement: state.settlement ?? null,
        lease_expires_at: state.lease_expires_at ?? null,
        time_created: now,
        time_updated: now,
      })
      .run()
      .pipe(Effect.orDie)
  })

const rowFor = (input: ToolExecution.Input) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    return yield* database.db
      .select()
      .from(ToolExecutionTable)
      .where(
        and(
          eq(ToolExecutionTable.session_id, input.sessionID),
          eq(ToolExecutionTable.assistant_message_id, input.assistantMessageID),
          eq(ToolExecutionTable.call_id, input.callID),
        ),
      )
      .get()
      .pipe(Effect.orDie)
  })

describe("ToolExecution claim lifecycle", () => {
  it.effect("refuses a persisted identity whose request hash changed", () =>
    Effect.gen(function* () {
      const executions = yield* ToolExecution.Service
      const original = identity("call_conflict")
      yield* executions.execute(original, Effect.succeed({ result: { type: "text", value: "first" } }))

      const replayed = yield* executions.execute(
        identity("call_conflict", { input: { path: "OTHER.md" } }),
        Effect.die("must not re-execute"),
      )

      expect(replayed).toEqual(reused)
      const row = yield* rowFor(original)
      // The conflict must not clobber the completed row.
      expect(row?.status).toBe("completed")
      expect(row?.settlement?.result).toEqual({ type: "text", value: "first" })
    }),
  )

  it.effect("rejects a different request reusing an in-flight call identity", () =>
    Effect.gen(function* () {
      const executions = yield* ToolExecution.Service
      const gate = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const first = yield* executions
        .execute(
          identity("call_live_conflict"),
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(gate)
            return { result: { type: "text", value: "first" } } as const
          }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)

      const conflicting = yield* executions.execute(
        identity("call_live_conflict", { input: { path: "OTHER.md" } }),
        Effect.die("must not re-execute"),
      )

      expect(conflicting).toEqual(reused)
      yield* Deferred.succeed(gate, undefined)
      expect(yield* Fiber.join(first)).toEqual({ result: { type: "text", value: "first" } })
    }),
  )

  it.effect("joins an in-flight execution with the same request instead of re-running", () =>
    Effect.gen(function* () {
      const executions = yield* ToolExecution.Service
      const gate = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const settlement = { result: { type: "text", value: "joined" } } as const
      const first = yield* executions
        .execute(
          identity("call_join"),
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(gate)
            return settlement
          }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)

      const second = yield* executions
        .execute(identity("call_join"), Effect.die("must not re-execute"))
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Deferred.succeed(gate, undefined)

      expect(yield* Fiber.join(first)).toEqual(settlement)
      expect(yield* Fiber.join(second)).toEqual(settlement)
    }),
  )

  it.effect("marks an interrupted execution indeterminate and refuses replay", () =>
    Effect.gen(function* () {
      const executions = yield* ToolExecution.Service
      const started = yield* Deferred.make<void>()
      const input = identity("call_interrupt")
      const fiber = yield* executions
        .execute(
          input,
          Effect.andThen(Deferred.succeed(started, undefined), Effect.never),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)

      const row = yield* rowFor(input)
      expect(row?.status).toBe("indeterminate")
      expect(row?.owner_id).toBeNull()
      expect(row?.lease_expires_at).toBeNull()

      const replayed = yield* executions.execute(input, Effect.die("must not re-execute"))
      expect(replayed).toEqual(indeterminate)
    }),
  )

  it.effect("marks a crashed execution indeterminate and refuses replay", () =>
    Effect.gen(function* () {
      const executions = yield* ToolExecution.Service
      const input = identity("call_crash")

      const crashed = yield* executions.execute(input, Effect.die("boom")).pipe(Effect.exit)
      expect(Exit.isFailure(crashed)).toBe(true)

      const row = yield* rowFor(input)
      expect(row?.status).toBe("indeterminate")
      expect(row?.owner_id).toBeNull()

      const replayed = yield* executions.execute(input, Effect.die("must not re-execute"))
      expect(replayed).toEqual(indeterminate)
    }),
  )

  it.effect("reclaims an expired retryable lease and re-executes", () =>
    Effect.gen(function* () {
      const executions = yield* ToolExecution.Service
      const input = identity("call_reclaim", { retryableError: true })
      yield* seedRow(input, {
        status: "running",
        owner_id: "crashed-owner",
        lease_expires_at: Date.now() - 1000,
      })

      const settlement = { result: { type: "error", value: "retryable failure" } } as const
      const result = yield* executions.execute(input, Effect.succeed(settlement))

      expect(result).toEqual(settlement)
      // A retryable error settlement releases the row instead of completing it.
      expect(yield* rowFor(input)).toBeUndefined()
    }),
  )

  it.effect("marks an expired non-retryable lease indeterminate instead of replaying", () =>
    Effect.gen(function* () {
      const executions = yield* ToolExecution.Service
      const input = identity("call_expired")
      yield* seedRow(input, {
        status: "running",
        owner_id: "crashed-owner",
        lease_expires_at: Date.now() - 1000,
      })

      const result = yield* executions.execute(input, Effect.die("must not re-execute"))

      expect(result).toEqual(indeterminate)
      const row = yield* rowFor(input)
      expect(row?.status).toBe("indeterminate")
      expect(row?.owner_id).toBeNull()
    }),
  )

  it.effect("resolves a completed row with no stored settlement as indeterminate", () =>
    Effect.gen(function* () {
      const executions = yield* ToolExecution.Service
      const input = identity("call_empty_settlement")
      yield* seedRow(input, { status: "completed", settlement: null })

      const result = yield* executions.execute(input, Effect.die("must not re-execute"))

      expect(result).toEqual(indeterminate)
    }),
  )

  it.effect("releases the row for re-execution after a retryable error", () =>
    Effect.gen(function* () {
      const executions = yield* ToolExecution.Service
      const input = identity("call_retry", { retryableError: true })

      const first = yield* executions.execute(input, Effect.succeed({ result: { type: "error", value: "flaky" } }))
      expect(first).toEqual({ result: { type: "error", value: "flaky" } })
      expect(yield* rowFor(input)).toBeUndefined()

      const second = yield* executions.execute(input, Effect.succeed({ result: { type: "error", value: "again" } }))
      expect(second).toEqual({ result: { type: "error", value: "again" } })
    }),
  )

  it.live("a parked caller reclaims the lease once it expires and executes", () =>
    Effect.gen(function* () {
      const executions = yield* ToolExecution.Service
      const input = identity("call_parked_reclaim", { retryableError: true })
      // Lease outlives the claim (so this caller parks) but expires before the first
      // owner-wait poll, so the poll reclaims instead of looping again.
      yield* seedRow(input, {
        status: "running",
        owner_id: "crashed-owner",
        lease_expires_at: Date.now() + 120,
      })

      const settlement = { result: { type: "text", value: "reclaimed" } } as const
      const result = yield* executions.execute(input, Effect.succeed(settlement))

      expect(result).toEqual(settlement)
      const row = yield* rowFor(input)
      expect(row?.status).toBe("completed")
      expect(row?.owner_id).toBeNull()
    }),
  )

  it.live("a parked caller marks an expired non-retryable lease indeterminate", () =>
    Effect.gen(function* () {
      const executions = yield* ToolExecution.Service
      const input = identity("call_parked_expired")
      yield* seedRow(input, {
        status: "running",
        owner_id: "crashed-owner",
        lease_expires_at: Date.now() + 120,
      })

      const result = yield* executions.execute(input, Effect.die("must not re-execute"))

      expect(result).toEqual(indeterminate)
      const row = yield* rowFor(input)
      expect(row?.status).toBe("indeterminate")
    }),
  )
})

describe("ToolExecution settlement storage", () => {
  it.effect("stores no derivable result and replays the settlement intact", () =>
    Effect.gen(function* () {
      const settlement = {
        result: { type: "text" as const, value: "hello" },
        output: { structured: {}, content: [{ type: "text" as const, text: "hello" }] },
      }
      const trip = yield* roundTrip("call_strip", settlement)

      expect(trip.first).toEqual(settlement)
      // `result` is derivable from `output`, so persisting both doubled the payload of every
      // completed row — at scale this column was the single largest redundancy in the database.
      expect(trip.stored).toEqual({ output: settlement.output })
      expect(trip.replayed).toEqual(settlement)
    }),
  )

  it.effect("replays a legacy dual-field row verbatim instead of re-deriving its result", () =>
    Effect.gen(function* () {
      const legacy = {
        // Deliberately different from toResultValue(output): a row written before the strip
        // must replay exactly what it stored, not a re-derivation.
        result: { type: "text" as const, value: "LEGACY-VERBATIM" },
        output: { structured: {}, content: [{ type: "text" as const, text: "derived would differ" }] },
      }
      const trip = yield* roundTrip("call_legacy", legacy, legacy)

      expect(trip.replayed).toEqual(legacy)
    }),
  )

  it.effect("keeps the error result for settlements that carry no output", () =>
    Effect.gen(function* () {
      const settlement = { result: { type: "error" as const, value: "command failed" } }
      const trip = yield* roundTrip("call_error", settlement)

      expect(trip.first).toEqual(settlement)
      expect(trip.stored).toEqual(settlement)
      expect(trip.replayed).toEqual(settlement)
    }),
  )
})
