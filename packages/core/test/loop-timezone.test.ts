import { expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Loop } from "@turenlabs/core/loop"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Loop.node])))
const input = (id: string, overrides: Partial<Loop.CreateInput> = {}): Loop.CreateInput => ({
  id,
  name: id,
  prompt: "Report status",
  location: { directory: `/work/${id}` },
  cronExpression: "0 12 * * *",
  timezone: "UTC",
  ...overrides,
})

for (const future of [false, true]) {
  it.effect(`timezone-only cron edit recomputes the next occurrence${future ? " after the future start" : ""}`, () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      const loop = yield* loops.create(input("lop_timezone", future ? { startsAt: Date.now() + 172_800_000 } : {}))
      const before = Date.now()
      const edited = yield* loops.edit({ id: loop.id, timezone: "America/New_York" })
      const expected = Loop.computeCronNext("0 12 * * *", "America/New_York", Math.max(before, loop.startsAt - 1))
      if (expected instanceof Loop.InvalidInputError) return yield* Effect.die(expected)
      expect(edited.nextRunAt).toBe(expected)
      expect(edited.nextRunAt).not.toBe(loop.nextRunAt)
      expect(edited.nextRunAt!).toBeGreaterThanOrEqual(loop.startsAt)
      expect(edited.schedule).toMatchObject({ type: "cron", expression: "0 12 * * *", timezone: "America/New_York" })
    }),
  )
}

it.effect("timezone edits leave paused, interval and event scheduling unchanged", () =>
  Effect.gen(function* () {
    const loops = yield* Loop.Service
    for (const overrides of [
      { paused: true },
      { cronExpression: undefined, intervalSeconds: 60 },
      { cronExpression: undefined, eventTrigger: { type: "file-change", paths: ["**"] } },
    ] satisfies Partial<Loop.CreateInput>[]) {
      const loop = yield* loops.create(
        input(`lop_control_${overrides.paused ? "paused" : overrides.eventTrigger ? "event" : "interval"}`, overrides),
      )
      const edited = yield* loops.edit({ id: loop.id, timezone: "America/New_York" })
      expect(edited.status).toBe(loop.status)
      expect(edited.nextRunAt).toBe(loop.nextRunAt)
      expect(edited.schedule.timezone).toBe("America/New_York")
    }
  }),
)

it.effect("invalid timezone edits leave the stored cron schedule unchanged", () =>
  Effect.gen(function* () {
    const loops = yield* Loop.Service
    const loop = yield* loops.create(input("lop_invalid"))
    const error = yield* loops.edit({ id: loop.id, timezone: "Invalid/Timezone" }).pipe(Effect.flip)
    expect(error).toBeInstanceOf(Loop.InvalidInputError)
    expect(yield* loops.get(loop.id)).toEqual(loop)
  }),
)
