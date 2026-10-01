import { describe, expect, test } from "bun:test"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Database } from "@turenlabs/core/database/database"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { FSUtil } from "@turenlabs/core/fs-util"
import { Storage } from "@turenlabs/core/storage"
import { SecretVault } from "@turenlabs/core/secret-vault"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { Auth } from "../../src/auth"
import { tmpdir } from "../fixture/fixture"

type LegacyFile = { content: string | undefined; reads: number }

function run<E>(
  legacy: LegacyFile,
  body: (services: {
    storage: Storage.Interface
    vault: SecretVault.Interface
    auth: (
      provided?: Storage.Interface,
      providedVault?: SecretVault.Interface,
    ) => Effect.Effect<Auth.Interface, never, Scope.Scope>
  }) => Effect.Effect<void, E, Scope.Scope>,
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const databaseContext = yield* Layer.build(Database.layerFromPath(":memory:"))
      const database = Context.get(databaseContext, Database.Service)
      const storageContext = yield* Layer.build(
        LayerNode.compile(Storage.node, [[Database.node, Layer.succeed(Database.Service, database)]]),
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
      const auth = (provided = storage, providedVault = vault) =>
        Layer.build(
          Layer.fresh(
            LayerNode.compile(Auth.node, [
              [Database.node, Layer.succeed(Database.Service, database)],
              [Storage.node, Layer.succeed(Storage.Service, provided)],
              [FSUtil.node, fs],
              [SecretVault.node, Layer.succeed(SecretVault.Service, providedVault)],
            ]),
          ),
        ).pipe(Effect.map((context) => Context.get(context, Auth.Service)))
      yield* body({ storage, vault, auth })
    }).pipe(Effect.scoped),
  )
}

describe("Auth", () => {
  test("creates and accepts the database-bound verification sentinel", async () => {
    await run({ content: undefined, reads: 0 }, ({ storage, auth }) =>
      Effect.gen(function* () {
        yield* auth()
        const sentinel = yield* storage.get({
          scope: Storage.Scope.make("internal/database-verification"),
          key: Storage.Key.make("sentinel"),
        })
        expect(sentinel?.value.startsWith("forge-secret:v1:")).toBe(true)
        expect(Exit.isSuccess(yield* Effect.exit(auth()))).toBe(true)
      }),
    )
  })

  test("refuses a quick-connect start on a persistent-owned database", async () => {
    await run({ content: undefined, reads: 0 }, ({ storage, vault, auth }) =>
      Effect.gen(function* () {
        yield* auth()
        yield* storage.set({
          scope: Storage.Scope.make("internal/server-owner"),
          key: Storage.Key.make("record"),
          value: JSON.stringify({
            serverID: "persistent-server",
            keyID: vault.keyID,
            mode: "persistent",
            pid: 1,
            startedAt: 1,
          }),
        })
        const exit = yield* Effect.exit(auth())
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("another persistent server")
      }),
    )
  })

  test("rejects wrong key bytes even when the key ID matches", async () => {
    await run({ content: undefined, reads: 0 }, ({ auth, vault }) =>
      Effect.gen(function* () {
        yield* auth()
        const wrongVault = yield* Effect.gen(function* () {
          return yield* SecretVault.Service
        }).pipe(Effect.provide(SecretVault.layer({ keyID: vault.keyID, key: new Uint8Array(32).fill(42) })))
        const exit = yield* Effect.exit(auth(undefined, wrongVault))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("Database secret verification failed")
      }),
    )
  })

  test("reuses the database layer's full check for the same key bytes, but not for other bytes under its ID", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "forge.db")
    const key = { keyID: "host-key", key: new Uint8Array(32).fill(7) }
    const release = await Database.acquireOwnerLock(filename, { mode: "quick-connect", keyID: key.keyID, key })
    try {
      await Effect.gen(function* () {
        const database = Context.get(yield* Layer.build(Database.layerFromPath(filename)), Database.Service)
        // Written after the layer's check, so only a second full scan would see this second key ID.
        const foreign = yield* SecretVault.make({ keyID: "other-key", key: new Uint8Array(32).fill(8) }).seal(
          "auth",
          "other",
          "secret",
        )
        yield* Database.primary(database.db).run(
          sql`INSERT INTO storage_state (scope, key, value, revision, time_created, time_updated) VALUES ('auth', 'other', ${foreign}, 1, 0, 0)`,
        )
        const auth = (vaultKey: SecretVault.Key) =>
          Effect.exit(
            Layer.build(
              Layer.fresh(
                LayerNode.compile(Auth.node, [
                  [Database.node, Layer.succeed(Database.Service, database)],
                  [SecretVault.node, SecretVault.layer(vaultKey)],
                ]),
              ),
            ),
          )
        expect(Exit.isSuccess(yield* auth(key))).toBe(true)
        const wrong = yield* auth({ keyID: key.keyID, key: new Uint8Array(32).fill(9) })
        expect(Exit.isFailure(wrong)).toBe(true)
        if (Exit.isFailure(wrong)) expect(Cause.pretty(wrong.cause)).toContain("multiple key IDs")
      }).pipe(Effect.scoped, Effect.runPromise)
    } finally {
      release()
    }
  })

  test("rejects ciphertext that cannot open using the configured vault", async () => {
    await run({ content: undefined, reads: 0 }, ({ storage, vault, auth }) =>
      Effect.gen(function* () {
        yield* auth()
        yield* storage.set({
          scope: Storage.Scope.make("internal/database-verification"),
          key: Storage.Key.make("sentinel"),
          value: `forge-secret:v1:${vault.keyID}:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA`,
        })
        const exit = yield* Effect.exit(auth())
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("Database secret verification failed")
      }),
    )
  })

  test("rejects sealed values that have multiple key IDs", async () => {
    await run({ content: undefined, reads: 0 }, ({ storage, vault, auth }) =>
      Effect.gen(function* () {
        yield* auth()
        const otherValue = yield* Effect.gen(function* () {
          const otherVault = yield* SecretVault.Service
          return yield* otherVault.seal("test/mixed-key-ids", "entry", "secret")
        }).pipe(Effect.provide(SecretVault.layer({ keyID: "other-key", key: new Uint8Array(32).fill(42) })))
        yield* storage.set({
          scope: Storage.Scope.make("test/mixed-key-ids"),
          key: Storage.Key.make("entry"),
          value: otherValue,
        })

        expect(vault.isSealed(otherValue)).toBe(true)
        const exit = yield* Effect.exit(auth())
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("multiple key IDs")
      }),
    )
  })

  test("rejects malformed values that use the sealed-secret prefix", async () => {
    await run({ content: undefined, reads: 0 }, ({ storage, auth }) =>
      Effect.gen(function* () {
        yield* auth()
        yield* storage.set({
          scope: Storage.Scope.make("test/malformed-sealed-value"),
          key: Storage.Key.make("entry"),
          value: "forge-secret:v1:truncated",
        })
        const exit = yield* Effect.exit(auth())
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("Malformed sealed storage value")
      }),
    )
  })

  test.each([
    { provider: "anthropic", credential: new Auth.Api({ type: "api", key: "invalid-stale-api-key" }) },
    {
      provider: "xai",
      credential: new Auth.Oauth({ type: "oauth", access: "stale-access", refresh: "stale-refresh", expires: 1 }),
    },
  ])("removes $provider credentials durably without affecting other providers", async ({ provider, credential }) => {
    await run({ content: undefined, reads: 0 }, ({ auth }) =>
      Effect.gen(function* () {
        const first = yield* auth()
        yield* first.set(provider, credential)
        yield* first.set("retained", new Auth.Api({ type: "api", key: "other-provider-key" }))
        const second = yield* auth()
        expect(yield* second.get(provider)).toEqual(credential)

        yield* first.remove(provider)
        expect(yield* first.get(provider)).toBeUndefined()
        expect(yield* second.get(provider)).toBeUndefined()
        const reopened = yield* auth()
        expect(yield* reopened.all()).toEqual({ retained: { type: "api", key: "other-provider-key" } })
        yield* reopened.remove(provider)
        expect(yield* reopened.get(provider)).toBeUndefined()
      }),
    )
  })

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
