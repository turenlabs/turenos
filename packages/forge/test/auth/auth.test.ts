import { describe, expect, test } from "bun:test"
import { Database } from "@turenlabs/core/database/database"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { FSUtil } from "@turenlabs/core/fs-util"
import { Storage } from "@turenlabs/core/storage"
import { SecretVault } from "@turenlabs/core/secret-vault"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { Auth } from "../../src/auth"

type LegacyFile = { content: string | undefined; reads: number }

function run<E>(
  legacy: LegacyFile,
  body: (services: {
    storage: Storage.Interface
    auth: (provided?: Storage.Interface) => Effect.Effect<Auth.Interface, never, Scope.Scope>
  }) => Effect.Effect<void, E, Scope.Scope>,
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const storageContext = yield* Layer.build(
        LayerNode.compile(Storage.node, [[Database.node, Database.layerFromPath(":memory:")]]),
      )
      const storage = Context.get(storageContext, Storage.Service)
      const vaultContext = yield* Layer.build(LayerNode.compile(SecretVault.node))
      const vault = Context.get(vaultContext, SecretVault.Service)
      const fs = Layer.effect(
        FSUtil.Service,
        Effect.gen(function* () {
          const service = yield* FSUtil.Service
          return FSUtil.Service.of({
            ...service,
            readFileStringSafe: () =>
              Effect.sync(() => {
                legacy.reads++
                return legacy.content
              }),
            remove: () => Effect.sync(() => (legacy.content = undefined)),
            rename: () => Effect.void,
          })
        }),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      const auth = (provided = storage) =>
        Layer.build(
          Layer.fresh(
            LayerNode.compile(Auth.node, [
              [Storage.node, Layer.succeed(Storage.Service, provided)],
              [FSUtil.node, fs],
              [SecretVault.node, Layer.succeed(SecretVault.Service, vault)],
            ]),
          ),
        ).pipe(Effect.map((context) => Context.get(context, Auth.Service)))
      yield* body({ storage, auth })
    }).pipe(Effect.scoped),
  )
}

describe("Auth", () => {
  test("imports auth.json once, removes it, and keeps the destination authoritative", async () => {
    const legacy = {
      content: JSON.stringify({ anthropic: { type: "api", key: "legacy-secret" } }),
      reads: 0,
    }
    await run(legacy, ({ storage, auth }) =>
      Effect.gen(function* () {
        const first = yield* auth()
        expect(yield* first.get("anthropic")).toEqual({ type: "api", key: "legacy-secret" })
        expect(legacy.reads).toBe(2)

        yield* first.set("anthropic", { type: "api", key: "database-secret" })
        const stored = yield* storage.get({
          scope: Storage.Scope.make("internal/auth/providers"),
          key: Storage.Key.make("credentials"),
        })
        expect(stored?.value).toStartWith("forge-secret:v1:")
        expect(stored?.value).not.toContain("database-secret")
        const second = yield* auth()
        expect(yield* second.get("anthropic")).toEqual({ type: "api", key: "database-secret" })
        expect(legacy.reads).toBe(3)
        expect(legacy.content).toBeUndefined()

        const receipt = yield* storage.migrationReceipt("internal-auth-json-v1")
        expect(receipt?.rowCount).toBe(1)
        expect(JSON.stringify(receipt)).not.toContain("legacy-secret")
      }),
    )
  })

  test("does not overwrite a database destination during the first legacy import", async () => {
    const legacy: LegacyFile = { content: undefined, reads: 0 }
    await run(legacy, ({ auth }) =>
      Effect.gen(function* () {
        const first = yield* auth()
        yield* first.set("anthropic", { type: "api", key: "database-secret" })

        legacy.content = JSON.stringify({ anthropic: { type: "api", key: "legacy-secret" } })
        const second = yield* auth()
        expect(yield* second.get("anthropic")).toEqual({ type: "api", key: "database-secret" })
        expect(legacy.content).toContain("legacy-secret")
      }),
    )
  })

  test("merges concurrent writes from independent service instances", async () => {
    await run({ content: undefined, reads: 0 }, ({ storage, auth }) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const reads = { value: 0 }
        const armed = { value: false }
        const synchronized = Storage.Service.of({
          ...storage,
          get: (input) => {
            if (
              !armed.value ||
              input.scope !== "internal/auth/providers" ||
              input.key !== "credentials" ||
              reads.value >= 2
            ) {
              return storage.get(input)
            }
            return Effect.gen(function* () {
              const current = yield* storage.get(input)
              reads.value++
              if (reads.value === 2) yield* Deferred.succeed(gate, undefined)
              yield* Deferred.await(gate)
              return current
            })
          },
        })
        const first = yield* auth(synchronized)
        const second = yield* auth(synchronized)
        armed.value = true
        yield* Effect.all(
          [
            first.set("anthropic", { type: "api", key: "anthropic-secret" }),
            second.set("openai", { type: "api", key: "openai-secret" }),
          ],
          { concurrency: "unbounded" },
        )

        expect(yield* first.all()).toEqual({
          anthropic: { type: "api", key: "anthropic-secret" },
          openai: { type: "api", key: "openai-secret" },
        })
        expect((yield* storage.list({ scope: Storage.Scope.make("internal/auth/providers") }))[0]?.revision).toBe(2)
      }),
    )
  })

  test("normalizes trailing slashes and removes normalized credentials", async () => {
    await run({ content: undefined, reads: 0 }, ({ auth }) =>
      Effect.gen(function* () {
        const service = yield* auth()
        yield* service.set("https://example.com/", {
          type: "wellknown",
          key: "TOKEN",
          token: "first",
        })
        yield* service.set("https://example.com", {
          type: "wellknown",
          key: "TOKEN",
          token: "second",
        })
        expect(yield* service.all()).toEqual({
          "https://example.com": { type: "wellknown", key: "TOKEN", token: "second" },
        })

        yield* service.remove("https://example.com/")
        expect(yield* service.all()).toEqual({})
      }),
    )
  })

  test("replaces OAuth credentials only while the exact source credential is current", async () => {
    await run({ content: undefined, reads: 0 }, ({ auth }) =>
      Effect.gen(function* () {
        const service = yield* auth()
        const original = new Auth.Oauth({ type: "oauth", access: "old", refresh: "rt-old", expires: 1 })
        const refreshed = new Auth.Oauth({ type: "oauth", access: "new", refresh: "rt-new", expires: 2 })
        yield* service.set("xai", original)

        expect(yield* service.replaceOAuth("xai", original, refreshed)).toBe(true)
        expect(yield* service.get("xai")).toEqual(refreshed)

        yield* service.remove("xai")
        expect(yield* service.replaceOAuth("xai", refreshed, original)).toBe(false)
        expect(yield* service.get("xai")).toBeUndefined()

        yield* service.set("xai", { type: "api", key: "new-api-key" })
        expect(yield* service.replaceOAuth("xai", refreshed, original)).toBe(false)
        expect(yield* service.get("xai")).toEqual({ type: "api", key: "new-api-key" })
      }),
    )
  })

  test("does not restore OAuth credentials after a concurrent removal", async () => {
    await run({ content: undefined, reads: 0 }, ({ storage, auth }) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const armed = { value: false }
        const waiting = { value: false }
        const synchronized = Storage.Service.of({
          ...storage,
          get: (input) => {
            if (
              !armed.value ||
              waiting.value ||
              input.scope !== "internal/auth/providers" ||
              input.key !== "credentials"
            ) {
              return storage.get(input)
            }
            return Effect.gen(function* () {
              const current = yield* storage.get(input)
              waiting.value = true
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(release)
              return current
            })
          },
        })
        const refresher = yield* auth(synchronized)
        const disconnect = yield* auth()
        const original = new Auth.Oauth({ type: "oauth", access: "old", refresh: "rt-old", expires: 1 })
        const refreshed = new Auth.Oauth({ type: "oauth", access: "new", refresh: "rt-new", expires: 2 })
        yield* disconnect.set("xai", original)

        armed.value = true
        const replacement = yield* refresher.replaceOAuth("xai", original, refreshed).pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* disconnect.remove("xai")
        yield* Deferred.succeed(release, undefined)

        expect(yield* Fiber.join(replacement)).toBe(false)
        expect(yield* disconnect.get("xai")).toBeUndefined()
      }),
    )
  })

  test("keeps FORGE_AUTH_CONTENT external to storage", async () => {
    const previous = process.env.FORGE_AUTH_CONTENT
    await run({ content: undefined, reads: 0 }, ({ storage, auth }) =>
      Effect.gen(function* () {
        const service = yield* auth()
        yield* service.set("database", { type: "api", key: "database-secret" })
        process.env.FORGE_AUTH_CONTENT = JSON.stringify({ runtime: { type: "api", key: "runtime-secret" } })
        expect(yield* service.all()).toEqual({ runtime: { type: "api", key: "runtime-secret" } })

        const values = yield* storage.list({ scope: Storage.Scope.make("internal/auth/providers") })
        expect(values).toHaveLength(1)
        expect(values[0]?.value).not.toContain("runtime-secret")
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env.FORGE_AUTH_CONTENT
            else process.env.FORGE_AUTH_CONTENT = previous
          }),
        ),
      ),
    )
  })

  test("ignores malformed legacy input without recording secret-bearing state", async () => {
    const sentinel = "malformed-secret-sentinel"
    await run(
      {
        content: JSON.stringify({
          anthropic: { type: "api", key: sentinel },
          invalid: { type: "api" },
        }),
        reads: 0,
      },
      ({ storage, auth }) =>
        Effect.gen(function* () {
          const service = yield* auth()
          expect(yield* service.all()).toEqual({})
          expect(yield* storage.migrationReceipt("internal-auth-json-v1")).toBeUndefined()
          expect(yield* storage.list({ scope: Storage.Scope.make("internal/auth/providers") })).toEqual([])
        }),
    )
  })

  test("rejects malformed stored data without exposing or overwriting it", async () => {
    await run({ content: undefined, reads: 0 }, ({ storage, auth }) =>
      Effect.gen(function* () {
        const sentinel = "malformed-stored-auth-secret"
        yield* storage.set({
          scope: Storage.Scope.make("internal/auth/providers"),
          key: Storage.Key.make("credentials"),
          value: JSON.stringify({ provider: { type: "api", key: sentinel }, broken: { type: "api" } }),
        })
        const result = yield* auth().pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) {
          expect(Cause.pretty(result.cause)).toContain("Stored auth data is invalid")
          expect(Cause.pretty(result.cause)).not.toContain(sentinel)
        }

        const stored = yield* storage.get({
          scope: Storage.Scope.make("internal/auth/providers"),
          key: Storage.Key.make("credentials"),
        })
        expect(stored?.value).toContain(sentinel)
      }),
    )
  })
})
