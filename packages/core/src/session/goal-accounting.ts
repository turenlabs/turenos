export * as SessionGoalAccounting from "./goal-accounting"

import { Context, Deferred, Effect, Layer, Scope } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { SessionGoal } from "./goal"
import { SessionSchema } from "./schema"

export type Usage = {
  readonly tokenDelta: number
  readonly activeTimeMsDelta: number
}

export interface Turn {
  readonly complete: (usage: Usage) => Effect.Effect<void>
  readonly checkpoint: Effect.Effect<SessionGoal.Info | undefined>
  readonly allowUpdates: Effect.Effect<void>
}

export interface Interface {
  readonly open: (input: {
    readonly sessionID: SessionSchema.ID
    readonly goalID: SessionGoal.ID | undefined
    readonly checkpoint: (usage: Usage) => Effect.Effect<SessionGoal.Info | undefined>
  }) => Effect.Effect<Turn, never, Scope.Scope>
  readonly awaitCheckpoint: (input: {
    readonly sessionID: SessionSchema.ID
    readonly goalID: SessionGoal.ID
  }) => Effect.Effect<SessionGoal.Info | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/SessionGoalAccounting") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const turns = new Map<
      SessionSchema.ID,
      {
        readonly goalID: SessionGoal.ID
        readonly checkpoint: Effect.Effect<SessionGoal.Info | undefined>
        readonly updatesAllowed: Deferred.Deferred<void>
      }
    >()

    return Service.of({
      open: Effect.fn("SessionGoalAccounting.open")(function* (input) {
        const usage = yield* Deferred.make<Usage>()
        const updatesAllowed = yield* Deferred.make<void>()
        // Cache one uninterruptible checkpoint so the runner and lifecycle tools can observe the
        // same durable settlement without replaying a committed delta.
        const checkpoint = yield* Effect.cached(
          Deferred.await(usage).pipe(Effect.flatMap(input.checkpoint), Effect.uninterruptible),
        )
        const turn = input.goalID ? { goalID: input.goalID, checkpoint, updatesAllowed } : undefined
        if (turn) turns.set(input.sessionID, turn)
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(usage, { tokenDelta: 0, activeTimeMsDelta: 0 }).pipe(
            Effect.andThen(
              Effect.sync(() => {
                if (turns.get(input.sessionID) === turn) turns.delete(input.sessionID)
              }),
            ),
          ),
        )
        return {
          complete: (result) => Deferred.succeed(usage, result).pipe(Effect.asVoid),
          checkpoint,
          allowUpdates: Deferred.succeed(updatesAllowed, undefined).pipe(Effect.asVoid),
        }
      }),
      awaitCheckpoint: Effect.fn("SessionGoalAccounting.awaitCheckpoint")(function* (input) {
        const turn = turns.get(input.sessionID)
        if (turn?.goalID !== input.goalID) return
        const checkpointed = yield* turn.checkpoint
        yield* Deferred.await(turn.updatesAllowed)
        return checkpointed
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [],
})
