import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionTaskV2 } from "@turenlabs/core/session/task"
import { ShareNext } from "./share-next"

export interface Interface {
  readonly unshare: (sessionID: SessionID) => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@forge/SessionShare") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const shareNext = yield* ShareNext.Service
    const tasks = yield* SessionTaskV2.Service

    const unshare = Effect.fn("SessionShare.unshare")(function* (sessionID: SessionID) {
      yield* tasks.authorizeMutation({ sessionID }).pipe(Effect.orDie)
      const current = yield* session.get(sessionID)
      const removed = yield* shareNext.remove(sessionID)
      if (!removed && current.shared) {
        throw new Error("Cannot revoke legacy share because its local credentials are missing")
      }
      if (!removed) return
      yield* session.clearShare(sessionID)
    })

    return Service.of({ unshare })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Session.node, ShareNext.node, SessionTaskV2.node],
})

export * as SessionShare from "./session"
