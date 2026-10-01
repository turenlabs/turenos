export * as SecretOutput from "./secret-output"

import { Cause, Context, Effect, Layer, Schema } from "effect"
import { Credential } from "./credential"
import { ExtensionRuntime } from "./extension"
import { makeGlobalNode } from "./effect/app-node"
import { SecretRedaction } from "./secret-redaction"

export class Error extends Schema.TaggedErrorClass<Error>()("SecretOutput.Error", {
  message: Schema.String,
}) {}

export interface Snapshot {
  readonly text: (value: string) => string
  /** Protects `values` as one joined text, returning one protected string per value in order. */
  readonly parts: (values: readonly string[]) => string[]
  readonly json: (value: unknown) => unknown
  /** For streamed output: how much of `value` can be redacted and released now (0 holds it all). */
  readonly boundary?: (value: string) => number
}

export interface Interface {
  readonly snapshot: () => Effect.Effect<Snapshot, Error>
}

export class Service extends Context.Service<Service, Interface>()("@forge/SecretOutput") {}

/**
 * One operation's protection, acquired on first use and reused for the rest of that operation --
 * a provider turn, a tool settlement, a legacy processing step. The raw values stay in the
 * compiled snapshot this closure holds and are released with it; nothing is cached across
 * operations, and a failed acquisition is retried on the next use rather than remembered.
 */
export const reuse = (service: Interface): Effect.Effect<Snapshot, Error> => {
  let current: Snapshot | undefined
  return Effect.suspend(() =>
    current
      ? Effect.succeed(current)
      : service.snapshot().pipe(
          Effect.tap((snapshot) =>
            Effect.sync(() => {
              current = snapshot
            }),
          ),
        ),
  )
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const extensions = yield* ExtensionRuntime.Service
    return Service.of({
      snapshot: () =>
        Effect.gen(function* () {
          // Never retain decrypted values on the global service or truncate protection on overflow.
          const secrets = new Set<string>()
          let bytes = 0
          const add = (value: string | undefined) => {
            if (!value || secrets.has(value)) return
            if (value.length > 65536) throw unavailable()
            // Placeholder keys ("ollama", "EMPTY") are not secrets and would mask ordinary words.
            if (!SecretRedaction.eligible(value)) return
            bytes += Buffer.byteLength(value, "utf8")
            // Match SecretRedaction's literal budget so a successful snapshot is usable.
            if (secrets.size >= 256 || bytes > 65536) throw unavailable()
            secrets.add(value)
          }
          const rows = yield* credentials.all()
          if (rows.length > 1024) return yield* Effect.fail(unavailable())
          rows.forEach((item) => {
            if (item.value.type === "key") return add(item.value.key)
            add(item.value.access)
            add(item.value.refresh)
          })
          const manifests = yield* extensions.manifests()
          if (manifests.length > 4096) return yield* Effect.fail(unavailable())
          const declarations = new Map<string, { id: string; name: string }>()
          let work = 0
          for (const manifest of manifests) {
            for (const contribution of manifest.contributions) {
              if (++work > 8192) return yield* Effect.fail(unavailable())
              for (const field of contribution.secrets) {
                if (++work > 8192 || manifest.id.length > 1024 || field.id.length > 1024)
                  return yield* Effect.fail(unavailable())
                declarations.set(JSON.stringify([manifest.id, field.id]), { id: manifest.id, name: field.id })
                if (declarations.size > 1024) return yield* Effect.fail(unavailable())
              }
            }
          }
          // Sequential, deduplicated reads also protect stored secrets of disabled extensions.
          for (const field of declarations.values()) add(yield* extensions.secret(field.id, field.name))
          return SecretRedaction.compile([...secrets]) satisfies Snapshot
        }).pipe(
          Effect.timeout("5 seconds"),
          Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.fail(unavailable()))),
        ),
    })
  }),
)

function unavailable() {
  return new Error({ message: "Secret output protection unavailable" })
}

export const node = makeGlobalNode({ service: Service, layer, deps: [Credential.node, ExtensionRuntime.node] })
