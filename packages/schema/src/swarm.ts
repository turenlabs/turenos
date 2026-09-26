export * as Swarm from "./swarm"

import { Schema } from "effect"

export const DEFAULT_SIZE = 12
export const MIN_SIZE = 2
/** Largest swarm one leader dispatches directly; larger swarms go through orchestrators. */
export const DIRECT_SIZE = 50
export const MAX_SIZE = 2_000

export const InvalidReason = Schema.Literals(["missing_objective", "count_out_of_range"]).annotate({
  identifier: "Swarm.InvalidReason",
})
export type InvalidReason = typeof InvalidReason.Type

export const Ready = Schema.Struct({
  status: Schema.Literal("ready"),
  objective: Schema.String,
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_SIZE), Schema.isLessThanOrEqualTo(MAX_SIZE)),
  explicitCount: Schema.Boolean,
}).annotate({ identifier: "Swarm.Ready" })
export type Ready = typeof Ready.Type

export const Invalid = Schema.Struct({
  status: Schema.Literal("invalid"),
  objective: Schema.String,
  reason: InvalidReason,
  requestedCount: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "Swarm.Invalid" })
export type Invalid = typeof Invalid.Type

export const Invocation = Schema.Union([Ready, Invalid]).annotate({ identifier: "Swarm.Invocation" })
export type Invocation = typeof Invocation.Type

export function parse(input: string): Invocation | undefined {
  const text = input.trimStart()
  if (!text.startsWith("@swarm")) return
  if (text.length > "@swarm".length && !/\s/.test(text["@swarm".length]!)) return

  const remainder = text.slice("@swarm".length).trim()
  const count = /^(\d+)(?:\s+([\s\S]*))?$/.exec(remainder)
  const objective = (count?.[2] ?? (count ? "" : remainder)).trim()
  if (!objective)
    return Invalid.make({
      status: "invalid",
      objective,
      reason: "missing_objective",
      ...(count?.[1] === undefined ? {} : { requestedCount: count[1] }),
    })
  if (count?.[1] !== undefined) {
    const requested = Number(count[1])
    if (!Number.isSafeInteger(requested) || requested < MIN_SIZE || requested > MAX_SIZE)
      return Invalid.make({
        status: "invalid",
        objective,
        reason: "count_out_of_range",
        requestedCount: count[1],
      })
    return Ready.make({ status: "ready", objective, count: requested, explicitCount: true })
  }
  return Ready.make({ status: "ready", objective, count: DEFAULT_SIZE, explicitCount: false })
}
