import { randomUUID } from "node:crypto"
import { Cause, Clock, Context, Effect, Fiber, Layer, Schema, Scope } from "effect"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Config } from "@turenlabs/core/config"
import { AntigravityAcpCLI } from "@turenlabs/core/provider/antigravity-acp"
import { authenticate, AuthError } from "@turenlabs/core/provider/antigravity-acp-auth"
import { InstanceState } from "@/effect/instance-state"

export class State extends Schema.Class<State>("AntigravityAcpAuthState")({
  id: Schema.String,
  status: Schema.Literals(["starting", "waiting", "authenticated", "error", "cancelled"]),
  url: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
}) {}

export class MissingAttempt extends Schema.TaggedErrorClass<MissingAttempt>()("AntigravityAcpAuthMissingAttempt", {}) {}

interface Attempt {
  state: State
  fiber?: Fiber.Fiber<void>
}

export interface Interface {
  readonly authorize: () => Effect.Effect<State, never, Config.Service>
  readonly status: (id: string) => Effect.Effect<State, MissingAttempt>
  readonly cancel: (id: string) => Effect.Effect<State, MissingAttempt>
}

export class Service extends Context.Service<Service, Interface>()("@forge/AntigravityAcpAuth") {}

const active = (state: State) => state.status === "starting" || state.status === "waiting"

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make(() =>
      Effect.gen(function* () {
        const scope = yield* Scope.Scope
        return { scope, current: undefined as Attempt | undefined, nextLaunch: 0 }
      }),
    )

    const authorize = Effect.fn("AntigravityAcpAuth.authorize")(function* () {
      const config = yield* Config.Service
      const entries = yield* config.entries()
      const boundary = entries.findIndex((entry) => entry.type === "directory")
      const configured = (boundary < 0 ? entries : entries.slice(0, boundary))
        .flatMap((entry) =>
          entry.type === "document"
            ? [entry.info.providers?.[AntigravityAcpCLI.ID]?.request?.body?.[AntigravityAcpCLI.EXECUTABLE_KEY]]
            : [],
        )
        .findLast((value) => value !== undefined)
      const executable = AntigravityAcpCLI.resolveExecutable(configured)
      const current = yield* InstanceState.get(state)
      const now = yield* Clock.currentTimeMillis
      // No yield separates checking and publishing an attempt, so concurrent starts join it.
      if (current.current && active(current.current.state)) return current.current.state
      const attempt: Attempt = {
        state: new State(
          executable && now < current.nextLaunch
            ? {
                id: randomUUID(),
                status: "error",
                message: `Please wait ${Math.ceil((current.nextLaunch - now) / 1_000)}s before signing in again.`,
              }
            : executable
              ? { id: randomUUID(), status: "starting" }
              : {
                  id: randomUUID(),
                  status: "error",
                  message:
                    "Antigravity ACP was not found. Install the official runtime or configure its executable path.",
                },
        ),
      }
      current.current = attempt
      if (!executable || attempt.state.status === "error") return attempt.state
      current.nextLaunch = now + 3_000
      const fiber = yield* Effect.scoped(
        authenticate({
          executable,
          onWaiting: (url) => {
            if (active(attempt.state)) attempt.state = new State({ id: attempt.state.id, status: "waiting", url })
          },
        }),
      ).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (active(attempt.state)) attempt.state = new State({ id: attempt.state.id, status: "authenticated" })
          }),
        ),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            if (active(attempt.state)) attempt.state = new State({ id: attempt.state.id, status: "cancelled" })
          }),
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.sync(() => {
                if (!active(attempt.state)) return
                const reason = Cause.findErrorOption(cause)
                attempt.state = new State({
                  id: attempt.state.id,
                  status: "error",
                  message:
                    reason._tag === "Some" && reason.value instanceof AuthError
                      ? reason.value.message
                      : "Antigravity ACP sign-in failed. Try again.",
                })
              }),
        ),
        Effect.interruptible,
        Effect.forkIn(current.scope),
      )
      attempt.fiber = fiber
      if (attempt.state.status === "cancelled") yield* Fiber.interrupt(fiber)
      return attempt.state
    }, Effect.uninterruptible)

    const status = Effect.fn("AntigravityAcpAuth.status")(function* (id: string) {
      const current = (yield* InstanceState.get(state)).current
      if (!current || current.state.id !== id) return yield* new MissingAttempt()
      return current.state
    })

    const cancel = Effect.fn("AntigravityAcpAuth.cancel")(function* (id: string) {
      const current = (yield* InstanceState.get(state)).current
      if (!current || current.state.id !== id) return yield* new MissingAttempt()
      if (active(current.state)) {
        current.state = new State({ id, status: "cancelled" })
        if (current.fiber) yield* Fiber.interrupt(current.fiber)
      }
      return current.state
    }, Effect.uninterruptible)

    return Service.of({ authorize, status, cancel })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })

export * as AntigravityAcpAuth from "./antigravity-acp-auth"
