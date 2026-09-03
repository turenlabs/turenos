export * as SessionExecution from "./execution"

import { Context, Effect, Layer } from "effect"
import { LayerNode } from "../effect/layer-node"
import { Node } from "../effect/app-node"
import { SessionRunner } from "./runner/index"
import { SessionSchema } from "./schema"

export interface Interface {
  /** Snapshots active execution owned by this process. */
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  /** Atomically claims an explicit execution and returns a separately interruptible join handle. */
  readonly claimResume: (sessionID: SessionSchema.ID) => Effect.Effect<Effect.Effect<void, SessionRunner.RunError>>
  /** Claims and joins execution only for durable pending work. */
  readonly claimPending?: (sessionID: SessionSchema.ID) => Effect.Effect<Effect.Effect<void, SessionRunner.RunError>>
  /** Starts execution while idle or joins the active execution. */
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, SessionRunner.RunError>
  /** Registers newly recorded work. Repeated wakeups may coalesce. */
  readonly wake: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** Registers one forced follow-up provider turn, coalescing with any active execution. */
  readonly wakeForced?: (sessionID: SessionSchema.ID, forceIfIdle?: boolean) => Effect.Effect<void>
  /** Retries durable advisory delivery without starting provider work directly. */
  readonly retry?: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** Interrupt active work owned by this process. Idle interruption is a no-op. */
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

/** Routes execution from a Session ID to the runner owned by that Session's Location. */
export class Service extends Context.Service<Service, Interface>()("@forge/v2/SessionExecution") {}

export const node = LayerNode.unbound(Service, Node.tags.values.global)

/** Low-level compatibility layer for callers that only need durable Session recording. */
export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    active: Effect.succeed(new Set()),
    claimResume: () => Effect.succeed(Effect.void),
    claimPending: () => Effect.succeed(Effect.void),
    resume: () => Effect.void,
    wake: () => Effect.void,
    wakeForced: () => Effect.void,
    retry: () => Effect.void,
    interrupt: () => Effect.void,
  }),
)
