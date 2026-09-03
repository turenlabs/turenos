export * as SessionV2Cutover from "./v2-cutover"

import { SessionLegacyExecution } from "@turenlabs/core/session/legacy-execution"
import { makeGlobalNode } from "@turenlabs/core/effect/app-node"
import { Effect, Layer } from "effect"
import { InstanceStore } from "@/project/instance-store"
import { SessionRunState } from "./run-state"

const layer = Layer.effect(
  SessionLegacyExecution.Service,
  Effect.gen(function* () {
    const instances = yield* InstanceStore.Service
    const state = yield* SessionRunState.Service

    return SessionLegacyExecution.Service.of({
      quiesce: Effect.fn("SessionV2Cutover.quiesce")(function* (input) {
        if (!input.hasLegacyTranscript) return
        yield* instances.provide(
          { directory: input.session.location.directory },
          state.cancel(input.session.id).pipe(
            Effect.andThen(state.assertNotBusy(input.session.id)),
            Effect.mapError(
              () => new SessionLegacyExecution.QuiescenceUnavailableError({ sessionID: input.session.id }),
            ),
          ),
        )
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: SessionLegacyExecution.Service,
  layer,
  deps: [InstanceStore.node, SessionRunState.node],
})
