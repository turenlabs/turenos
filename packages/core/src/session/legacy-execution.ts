export * as SessionLegacyExecution from "./legacy-execution"

import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { SessionSchema } from "./schema"

export class QuiescenceUnavailableError extends Schema.TaggedErrorClass<QuiescenceUnavailableError>()(
  "SessionLegacyExecution.QuiescenceUnavailableError",
  {
    sessionID: SessionSchema.ID,
  },
) {}

export interface Interface {
  readonly quiesce: (input: {
    readonly session: SessionSchema.Info
    readonly hasLegacyTranscript: boolean
  }) => Effect.Effect<void, QuiescenceUnavailableError>
}

export class Service extends Context.Service<Service, Interface>()("@forge/SessionLegacyExecution") {}

const layer = Layer.succeed(
  Service,
  Service.of({
    quiesce: (input) =>
      input.hasLegacyTranscript
        ? Effect.fail(new QuiescenceUnavailableError({ sessionID: input.session.id }))
        : Effect.void,
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
