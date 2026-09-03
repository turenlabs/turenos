import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { SecretVault } from "@turenlabs/core/secret-vault"
import { it } from "./lib/effect"

const root = Uint8Array.from({ length: 32 }, (_, index) => index)
const vault = SecretVault.layer({ keyID: "test-key", key: root })

const withVault = <A, E>(effect: Effect.Effect<A, E, SecretVault.Service>) => effect.pipe(Effect.provide(vault))

describe("SecretVault", () => {
  it.effect("roundtrips a secret", () =>
    Effect.gen(function* () {
      const service = yield* SecretVault.Service
      const sealed = yield* service.seal("provider", "api-key", "very secret")
      expect(service.isSealed(sealed)).toBe(true)
      expect(yield* service.open("provider", "api-key", sealed)).toBe("very secret")
    }).pipe(Effect.provide(vault)),
  )

  it.effect("roundtrips binary content for sensitive files", () =>
    Effect.gen(function* () {
      const service = yield* SecretVault.Service
      const content = new Uint8Array([0, 255, 1, 128, 2])
      const sealed = yield* service.sealBytes("files", "credential.bin", content)
      expect(yield* service.openBytes("files", "credential.bin", sealed)).toEqual(content)
    }).pipe(Effect.provide(vault)),
  )

  it.effect("binds the scope and key", () =>
    withVault(
      Effect.gen(function* () {
        const service = yield* SecretVault.Service
        const sealed = yield* service.seal("provider", "api-key", "very secret")
        expect(Exit.isFailure(yield* Effect.exit(service.open("other", "api-key", sealed)))).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(service.open("provider", "other", sealed)))).toBe(true)
      }),
    ),
  )

  it.effect("rejects a different root key", () =>
    Effect.gen(function* () {
      const sealed = yield* withVault(
        Effect.gen(function* () {
          const service = yield* SecretVault.Service
          return yield* service.seal("provider", "api-key", "very secret")
        }),
      )
      const exit = yield* Effect.gen(function* () {
        const service = yield* SecretVault.Service
        return yield* Effect.exit(service.open("provider", "api-key", sealed))
      }).pipe(Effect.provide(SecretVault.layer({ keyID: "test-key", key: new Uint8Array(32).fill(42) })))
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect("rejects tampering", () =>
    withVault(
      Effect.gen(function* () {
        const service = yield* SecretVault.Service
        const sealed = yield* service.seal("provider", "api-key", "very secret")
        const parts = sealed.split(":")
        parts[4] = `${parts[4]![0] === "A" ? "B" : "A"}${parts[4]!.slice(1)}`
        expect(Exit.isFailure(yield* Effect.exit(service.open("provider", "api-key", parts.join(":"))))).toBe(true)
      }),
    ),
  )

  it.effect("rejects malformed envelopes", () =>
    withVault(
      Effect.gen(function* () {
        const service = yield* SecretVault.Service
        const malformed = [
          "not-sealed",
          "forge-secret:v2:test-key:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA",
          "forge-secret:v1:test:key:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA",
          "forge-secret:v1:test-key:AAAAAAAAAAAAAAAA=:AAAAAAAAAAAAAAAAAAAAAA",
          "forge-secret:v1:test-key:AAAAAAAAAAAAAAAA:AA==",
        ]
        const exits = yield* Effect.all(
          malformed.map((value) => Effect.exit(service.open("provider", "api-key", value))),
        )
        expect(exits.every(Exit.isFailure)).toBe(true)
        expect(malformed.every((value) => !service.isSealed(value))).toBe(true)
      }),
    ),
  )

  it.effect("enforces the one MiB value bound", () =>
    withVault(
      Effect.gen(function* () {
        const service = yield* SecretVault.Service
        const exit = yield* Effect.exit(service.seal("provider", "api-key", "x".repeat(1024 * 1024 + 1)))
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    ),
  )

  it.effect("uses a new nonce for each seal", () =>
    withVault(
      Effect.gen(function* () {
        const service = yield* SecretVault.Service
        const first = yield* service.seal("provider", "api-key", "very secret")
        const second = yield* service.seal("provider", "api-key", "very secret")
        expect(first).not.toBe(second)
        expect(first.split(":")[3]).not.toBe(second.split(":")[3])
      }),
    ),
  )
})
