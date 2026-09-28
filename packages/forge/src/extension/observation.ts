import { Extension } from "@turenlabs/schema"
import { NonNegativeInt } from "@turenlabs/core/schema"
import { Storage } from "@turenlabs/core/storage"
import { ToolVisibleError } from "@turenlabs/core/tool/visible-error"
import type { MCP } from "@/mcp"
import { Effect, Option, Schema } from "effect"

/**
 * Persisted runtime observation for an extension, written during reconcile and
 * by the MCP runtime on later transitions (e.g. a managed server crashing after
 * enable). `Extension.list` reads it because the read route has no instance
 * context and cannot query per-directory MCP state directly.
 */
const scope = Storage.Scope.make("internal/extension-reconciliation")

export const Observation = Schema.Struct({
  revision: NonNegativeInt,
  status: Extension.RuntimeStatus,
  detail: Schema.optional(Schema.String),
  /** Recent redacted server output lines, retained for the Extensions UI. */
  log: Schema.optional(Schema.Array(Schema.String)),
})
export type Observation = typeof Observation.Type

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Observation))
const key = (id: Extension.ID | string) => Storage.Key.make(String(id))

export const read = Effect.fnUntraced(function* (id: Extension.ID | string) {
  const storage = yield* Storage.Service
  const stored = yield* storage.get({ scope, key: key(id) })
  return stored ? Option.getOrUndefined(decode(stored.value)) : undefined
})

export const write = Effect.fnUntraced(function* (id: Extension.ID | string, value: Observation) {
  const storage = yield* Storage.Service
  yield* storage.set({ scope, key: key(id), value: JSON.stringify(value) })
})

/** Collapse per-contribution MCP statuses into the extension's runtime view. */
export function runtimeObservation(statuses: ReadonlyArray<MCP.Status | undefined>): {
  readonly status: Extension.RuntimeStatus
  readonly detail?: string
} {
  if (statuses.length === 0) return { status: "connecting" }
  if (statuses.every((status) => status?.status === "connected")) return { status: "connected" }
  if (statuses.some((status) => status?.status === "needs_auth" || status?.status === "needs_client_registration")) {
    return { status: "needs-auth" }
  }
  const failed = statuses.find((status) => status?.status === "failed")
  if (failed?.status === "failed") return { status: "failed", detail: ToolVisibleError.make(failed.error) }
  if (statuses.some((status) => status === undefined)) return { status: "connecting" }
  if (statuses.every((status) => status?.status === "disabled")) return { status: "disabled" }
  return { status: "connecting" }
}

export * as ExtensionObservation from "./observation"
