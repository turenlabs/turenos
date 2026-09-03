export * as SessionExecutionControl from "./execution-control"

import { Effect } from "effect"
import { SessionSchema } from "./schema"

/** Process-local controls exposed to one Location-scoped Session runner. */
export interface Interface {
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  readonly wake: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** Wakes advisory work only after the Session operation and busy checks allow it. */
  readonly wakeAdvisory?: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** Schedules a coalesced retry for durable advisory delivery without waking a provider turn. */
  readonly retry?: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

export const noop: Interface = {
  active: Effect.succeed(new Set()),
  wake: () => Effect.void,
  wakeAdvisory: () => Effect.void,
  interrupt: () => Effect.void,
}
