export * as PermissionChecks from "./permission-checks"

import { Context, Effect, Layer, Option, Schema } from "effect"
import { makeGlobalNode } from "./effect/app-node"
import { Storage } from "./storage"

const scope = Storage.Scope.make("internal/permissions")
const key = Storage.Key.make("enforce_checks")
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Boolean))

export const enforced = Effect.fn("PermissionChecks.enforced")(function* () {
  const storage = yield* Storage.Service
  const state = yield* storage.get({ scope, key })
  if (!state) return false
  return Option.getOrElse(decode(state.value), () => false)
})

export const set = Effect.fn("PermissionChecks.set")(function* (value: boolean) {
  const storage = yield* Storage.Service
  if (!value) {
    yield* storage.remove({ scope, key })
    return
  }
  yield* storage.set({ scope, key, value: JSON.stringify(true) })
})

export interface Interface {
  readonly enforced: () => Effect.Effect<boolean>
  readonly set: (enforced: boolean) => Effect.Effect<void>
  readonly untilDisabled: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@forge/PermissionChecks") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const read = () => enforced().pipe(Effect.provideService(Storage.Service, storage))
    const write = (value: boolean) => set(value).pipe(Effect.provideService(Storage.Service, storage))

    const untilDisabled = Effect.fn("PermissionChecks.untilDisabled")(function* () {
      while (yield* read()) yield* Effect.sleep("250 millis")
    })

    return Service.of({ enforced: read, set: write, untilDisabled })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Storage.node] })
