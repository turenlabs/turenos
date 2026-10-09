import { expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Loop } from "@turenlabs/core/loop"
import { LoopTable } from "@turenlabs/core/loop/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Loop.node])))
const input = (id: string, overrides: Partial<Loop.CreateInput> = {}): Loop.CreateInput => ({
  id,
  name: id,
  prompt: "Report status",
  location: { directory: `/work/${id}` },
  intervalSeconds: 60,
  ...overrides,
})

for (const cron of [false, true]) {
  it.effect(`schedule edits preserve a future ${cron ? "cron" : "interval"} start`, () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      const startsAt = Math.ceil((Date.now() + 3_600_000) / 60_000) * 60_000
      const loop = yield* loops.create(input("lop_future_edit", { startsAt }))
      const edited = yield* loops.edit({
        id: loop.id,
        ...(cron ? { cronExpression: "* * * * *" } : { intervalSeconds: 120 }),
      })
      expect(edited.nextRunAt).toBe(startsAt)
      expect(yield* loops.claimDue({ owner: "scheduler" })).toEqual([])
    }),
  )

  it.effect(`resume preserves a future ${cron ? "cron" : "interval"} start`, () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      // A minute boundary is a valid occurrence for the every-minute cron.
      const startsAt = Math.ceil((Date.now() + 3_600_000) / 60_000) * 60_000
      const loop = yield* loops.create(
        input("lop_future", {
          startsAt,
          paused: true,
          ...(cron ? { intervalSeconds: undefined, cronExpression: "* * * * *" } : {}),
        }),
      )
      const resumed = yield* loops.resume(loop.id)
      expect(resumed.nextRunAt).toBe(startsAt)
      expect(yield* loops.claimDue({ owner: "scheduler" })).toEqual([])
      expect((yield* loops.runNow({ id: loop.id, owner: "manual" })).status).toBe("claimed")
    }),
  )
}

for (const type of ["file-change", "session-end"] as const) {
  it.effect(`${type} admission rejects before startsAt without recording a run`, () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      const database = yield* Database.Service
      const loop = yield* loops.create(
        input("lop_future_event", {
          startsAt: Date.now() + 3_600_000,
          intervalSeconds: undefined,
          eventTrigger: type === "file-change" ? { type, paths: ["**"] } : { type },
        }),
      )
      const result = yield* loops.fireEvent({ id: loop.id, owner: "scheduler", trigger: type }).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(Loop.InvalidStateError)
      expect(yield* loops.listRuns(loop.id)).toEqual([])
      yield* loops.pause(loop.id)
      yield* loops.resume(loop.id)
      expect(
        (yield* loops.fireEvent({ id: loop.id, owner: "scheduler", trigger: type }).pipe(Effect.result))._tag,
      ).toBe("Failure")
      const manual = yield* loops.runNow({ id: loop.id, owner: "manual" })
      expect(manual.status).toBe("claimed")
      yield* loops.cancelRun({ id: manual.id })
      // Move only the configured boundary, not the service clock.
      yield* database.db
        .update(LoopTable)
        .set({ starts_at: Date.now() })
        .where(eq(LoopTable.id, loop.id))
        .run()
        .pipe(Effect.orDie)
      expect((yield* loops.fireEvent({ id: loop.id, owner: "scheduler", trigger: type })).status).toBe("claimed")
    }),
  )
}
