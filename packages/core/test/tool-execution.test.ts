import { describe, expect } from "bun:test"
import { and, eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { SessionMessage } from "@turenlabs/core/session/message"
import { SessionSchema } from "@turenlabs/core/session/schema"
import { ToolExecution } from "@turenlabs/core/tool/execution"
import { ToolExecutionTable } from "@turenlabs/core/tool/execution.sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, ToolExecution.node])))

const identity = (callID: string) => ({
  sessionID: SessionSchema.ID.make("ses_tool_execution"),
  assistantMessageID: SessionMessage.ID.make("msg_tool_execution"),
  callID,
  tool: "read",
  input: { path: "README.md" },
  retryableError: false,
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
