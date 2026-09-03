export * as SessionOperation from "./operation"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { KeyedMutex } from "../effect/keyed-mutex"
import { SessionSchema } from "./schema"

export interface Interface {
  readonly withLock: (
    sessionID: SessionSchema.ID,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/SessionOperation") {}

const layer = Layer.sync(Service, () => {
  const operations = KeyedMutex.makeUnsafe<SessionSchema.ID>()
  return Service.of({ withLock: operations.withLock })
})

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
