import { expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Loop } from "@turenlabs/core/loop"
import { LoopRunTable } from "@turenlabs/core/loop/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Loop.node])))
const input = (id: string): Loop.CreateInput => ({
  id,
  name: id,
  prompt: "Report status",
  location: { directory: `/work/${id}` },
  intervalSeconds: 60,
  paused: true,
})

it.effect("recovery defers durable work while a fresh manual run owns the loop", () =>
  Effect.gen(function* () {
    const loops = yield* Loop.Service
    const database = yield* Database.Service
    const loop = yield* loops.create(input("lop_overlap"))
    const abandoned = yield* loops.runNow({ id: loop.id, owner: "crashed" })
    yield* loops.recordRunSession({ id: abandoned.id, owner: "crashed", sessionID: "ses_durable" })
    yield* database.db
      .update(LoopRunTable)
      .set({
        lease_expires_at: Date.now() - 1,
        current_step: 1,
        step_outputs: { "0": { text: "durable output", artifacts: [] } },
      })
      .where(eq(LoopRunTable.id, abandoned.id))
      .run()
      .pipe(Effect.orDie)
    const fresh = yield* loops.runNow({ id: loop.id, owner: "manual" })
    expect(fresh.status).toBe("claimed")
    const recovered = yield* loops.claimDue({ owner: "scheduler" })
    yield* Effect.forEach(recovered, (run) =>
      Effect.gen(function* () {
        const sessionID = `ses_loop_${run.id}`
        yield* loops.recordRunSession({ id: run.id, owner: "scheduler", sessionID })
        yield* loops.startRun({ id: run.id, owner: "scheduler", sessionID })
      }),
    )
    expect((yield* loops.listRuns(loop.id)).filter((run) => run.status === "running")).toHaveLength(1)
    expect(recovered.map((run) => run.id)).toEqual([fresh.id])
    expect(yield* loops.claimDue({ owner: "other" })).toEqual([])
    expect(yield* loops.nextWakeAt(Date.now())).toBeGreaterThan(Date.now())
    const pending = yield* loops.getRun({ id: abandoned.id })
    expect(pending.status).toBe("claimed")
    expect(pending.currentStep).toBe(1)
    expect(pending.outputs).toEqual({ "0": { text: "durable output", artifacts: [] } })
    yield* loops.cancelRun({ id: fresh.id })
    const resumed = yield* loops.claimDue({ owner: "restarted", limit: 1 })
    expect(resumed.map((run) => run.id)).toEqual([abandoned.id])
    expect(resumed[0]?.currentStep).toBe(1)
    expect(resumed[0]?.sessionID).toBe("ses_durable")
    expect(resumed[0]?.outputs).toEqual({ "0": { text: "durable output", artifacts: [] } })
    expect(yield* loops.claimDue({ owner: "again" })).toEqual([])
  }),
)

for (const limit of [1, 2]) {
  it.effect(`recovery serializes expired siblings without starving other loops with limit ${limit}`, () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      const database = yield* Database.Service
      const loop = yield* loops.create(input("lop_siblings"))
      const other = yield* loops.create(input("lop_other"))
      const expired = []
      for (const id of [loop.id, loop.id, other.id]) {
        const run = yield* loops.runNow({ id, owner: "crashed" })
        expired.push(run)
        yield* database.db
          .update(LoopRunTable)
          .set({ lease_expires_at: Date.now() - 1 })
          .where(eq(LoopRunTable.id, run.id))
          .run()
          .pipe(Effect.orDie)
      }
      const first = yield* loops.claimDue({ owner: "first", limit })
      expect(first.map((run) => run.id)).toEqual(limit === 1 ? [expired[0]!.id] : [expired[0]!.id, expired[2]!.id])
      const second = yield* loops.claimDue({ owner: "second", limit })
      expect(second.map((run) => run.id)).toEqual(limit === 1 ? [expired[2]!.id] : [])
      expect(yield* loops.claimDue({ owner: "third", limit: 2 })).toEqual([])
      yield* loops.cancelRun({ id: first[0]!.id })
      expect((yield* loops.claimDue({ owner: "last", limit: 2 })).map((run) => run.id)).toEqual([expired[1]!.id])
    }),
  )
}
