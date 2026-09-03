import { describe, expect, test } from "bun:test"
import { Database } from "@turenlabs/core/database/database"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { FSUtil } from "@turenlabs/core/fs-util"
import { Storage } from "@turenlabs/core/storage"
import { SecretVault } from "@turenlabs/core/secret-vault"
import { Cause, Context, Deferred, Effect, Exit, Layer, Scope } from "effect"
import { McpAuth } from "../../src/mcp/auth"

type LegacyFile = { content: string | undefined; staging?: string; reads: number }

function run<E>(
  legacy: LegacyFile,
  body: (services: {
    storage: Storage.Interface
    auth: (provided?: Storage.Interface) => Effect.Effect<McpAuth.Interface, never, Scope.Scope>
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
            readFileStringSafe: (file) =>
              Effect.sync(() => {
                legacy.reads++
                return file.endsWith(".migrating") ? legacy.staging : legacy.content
              }),
            exists: (file) =>
              Effect.sync(() => (file.endsWith(".migrating") ? legacy.staging : legacy.content) !== undefined),
            remove: (file) =>
              Effect.sync(() => {
                if (file.endsWith(".migrating")) legacy.staging = undefined
                else legacy.content = undefined
              }),
            rename: (source) =>
              Effect.sync(() => {
                if (source.endsWith(".migrating")) {
                  legacy.content = legacy.staging
                  legacy.staging = undefined
                  return
                }
                legacy.staging = legacy.content
                legacy.content = undefined
              }),
          })
        }),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      const auth = (provided = storage) =>
        Layer.build(
          Layer.fresh(
            LayerNode.compile(McpAuth.node, [
              [Storage.node, Layer.succeed(Storage.Service, provided)],
              [FSUtil.node, fs],
              [SecretVault.node, Layer.succeed(SecretVault.Service, vault)],
            ]),
          ),
        ).pipe(Effect.map((context) => Context.get(context, McpAuth.Service)))
      yield* body({ storage, auth })
    }).pipe(Effect.scoped),
  )
}

describe("McpAuth", () => {
  test("imports mcp-auth.json once, removes it, and keeps the destination authoritative", async () => {
    const legacy = {
      content: JSON.stringify({
        posthog: {
          tokens: { accessToken: "legacy-access-token" },
          clientInfo: { clientId: "legacy-client" },
          serverUrl: "https://mcp.posthog.com/mcp",
        },
      }),
      reads: 0,
    }
    await run(legacy, ({ storage, auth }) =>
      Effect.gen(function* () {
        const first = yield* auth()
        expect((yield* first.get("posthog"))?.tokens?.accessToken).toBe("legacy-access-token")
        yield* first.updateTokens("posthog", { accessToken: "database-access-token" })

        const second = yield* auth()
        expect((yield* second.get("posthog"))?.tokens?.accessToken).toBe("database-access-token")
        expect(legacy.reads).toBe(2)
        expect(legacy.content).toBeUndefined()

        const receipt = yield* storage.migrationReceipt("internal-mcp-auth-json-v1")
        expect(receipt?.rowCount).toBe(0)
        expect(JSON.stringify(receipt)).not.toContain("legacy-access-token")
      }),
    )
  })

  test("keeps a database destination authoritative and removes conflicting legacy plaintext", async () => {
    const legacy: LegacyFile = { content: undefined, reads: 0 }
    await run(legacy, ({ auth }) =>
      Effect.gen(function* () {
        const first = yield* auth()
        yield* first.updateTokens("posthog", { accessToken: "database-access-token" })

        legacy.content = JSON.stringify({ posthog: { tokens: { accessToken: "legacy-access-token" } } })
        const second = yield* auth()
        expect((yield* second.get("posthog"))?.tokens?.accessToken).toBe("database-access-token")
        expect(legacy.content).toBeUndefined()
      }),
    )
  })

  test("recovers and removes a plaintext migration staging file after restart", async () => {
    const legacy: LegacyFile = {
      content: undefined,
      staging: JSON.stringify({ notion: { tokens: { accessToken: "staged-notion-token" } } }),
      reads: 0,
    }
    await run(legacy, ({ auth }) =>
      Effect.gen(function* () {
        const service = yield* auth()
        expect((yield* service.get("notion"))?.tokens?.accessToken).toBe("staged-notion-token")
        expect(legacy.content).toBeUndefined()
        expect(legacy.staging).toBeUndefined()
      }),
    )
  })

  test("merges token and client registration updates from independent service instances", async () => {
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
              input.scope !== "internal/mcp-auth/servers" ||
              input.key !== "entries" ||
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
            first.updateTokens("posthog", { accessToken: "access-token" }, "https://mcp.posthog.com/mcp"),
            second.updateClientInfo("posthog", { clientId: "client-id" }),
          ],
          { concurrency: "unbounded" },
        )

        expect(yield* first.get("posthog")).toEqual({
          tokens: { accessToken: "access-token" },
          clientInfo: { clientId: "client-id" },
          serverUrl: "https://mcp.posthog.com/mcp",
        })
        expect((yield* storage.list({ scope: Storage.Scope.make("internal/mcp-auth/servers") }))[0]?.revision).toBe(2)
      }),
    )
  })

  test("preserves explicit server URL precedence and removes credentials", async () => {
    await run({ content: undefined, reads: 0 }, ({ auth }) =>
      Effect.gen(function* () {
        const service = yield* auth()
        yield* service.set(
          "posthog",
          { tokens: { accessToken: "access-token" }, serverUrl: "https://entry.example/mcp" },
          "https://argument.example/mcp",
        )
        expect(yield* service.getForUrl("posthog", "https://argument.example/mcp")).toEqual({
          tokens: { accessToken: "access-token" },
          serverUrl: "https://argument.example/mcp",
        })
        expect(yield* service.getForUrl("posthog", "https://entry.example/mcp")).toBeUndefined()

        yield* service.remove("posthog")
        expect(yield* service.get("posthog")).toBeUndefined()
      }),
    )
  })

  test("never transfers hosted OAuth credentials to another alias", async () => {
    await run({ content: undefined, reads: 0 }, ({ auth }) =>
      Effect.gen(function* () {
        const service = yield* auth()
        yield* service.set(
          "posthog",
          {
            tokens: { accessToken: "access-token", refreshToken: "refresh-token" },
            clientInfo: { clientId: "dynamically-registered-client" },
          },
          "https://mcp.posthog.com/mcp",
        )

        expect(yield* service.getForUrl("analytics", "https://mcp.posthog.com/mcp")).toBeUndefined()
        yield* service.set(
          "analytics",
          { tokens: { accessToken: "different-account-token" } },
          "https://mcp.posthog.com/mcp",
        )
        expect((yield* service.get("posthog"))?.tokens?.accessToken).toBe("access-token")
        expect((yield* service.get("analytics"))?.tokens?.accessToken).toBe("different-account-token")

        yield* service.remove("analytics")
        expect((yield* service.get("posthog"))?.tokens?.accessToken).toBe("access-token")

        const restarted = yield* auth()
        expect(yield* restarted.get("analytics")).toBeUndefined()
        expect((yield* restarted.get("posthog"))?.tokens?.accessToken).toBe("access-token")

        yield* restarted.remove("posthog")
        expect(yield* restarted.all()).toEqual({})
      }),
    )
  })

  test("drops the other principal credential field when an alias changes servers", async () => {
    await run({ content: undefined, reads: 0 }, ({ auth }) =>
      Effect.gen(function* () {
        const service = yield* auth()
        yield* service.set(
          "analytics",
          {
            tokens: { accessToken: "server-a-token" },
            clientInfo: { clientId: "server-a-client", clientSecret: "server-a-secret" },
          },
          "https://a.example/mcp",
        )

        const replacement = yield* auth()
        yield* replacement.prepareForUrl("analytics", "https://b.example/mcp")
        const staleBeforeReplacement = yield* service
          .updateTokens("analytics", { accessToken: "late-server-a-token" }, "https://a.example/mcp")
          .pipe(Effect.exit)
        expect(Exit.isFailure(staleBeforeReplacement)).toBe(true)
        yield* replacement.updateClientInfo(
          "analytics",
          { clientId: "server-b-client", clientSecret: "server-b-secret" },
          "https://b.example/mcp",
        )
        expect(yield* replacement.getForUrl("analytics", "https://b.example/mcp")).toEqual({
          clientInfo: { clientId: "server-b-client", clientSecret: "server-b-secret" },
          serverUrl: "https://b.example/mcp",
        })

        const stale = yield* service
          .updateTokens("analytics", { accessToken: "later-server-a-token" }, "https://a.example/mcp")
          .pipe(Effect.exit)
        expect(Exit.isFailure(stale)).toBe(true)
        expect(yield* replacement.getForUrl("analytics", "https://b.example/mcp")).toEqual({
          clientInfo: { clientId: "server-b-client", clientSecret: "server-b-secret" },
          serverUrl: "https://b.example/mcp",
        })

        yield* replacement.prepareForUrl("analytics", "https://c.example/mcp")
        yield* replacement.updateTokens("analytics", { accessToken: "server-c-token" }, "https://c.example/mcp")
        expect(yield* replacement.getForUrl("analytics", "https://c.example/mcp")).toEqual({
          tokens: { accessToken: "server-c-token" },
          serverUrl: "https://c.example/mcp",
        })
      }),
    )
  })

  test("fences stale writers across same-URL reauthentication and logout", async () => {
    await run({ content: undefined, reads: 0 }, ({ auth }) =>
      Effect.gen(function* () {
        const first = yield* auth()
        const firstGeneration = yield* first.prepareForUrl("notion", "https://mcp.notion.com/mcp")
        yield* first.updateTokens(
          "notion",
          { accessToken: "first-account-token" },
          "https://mcp.notion.com/mcp",
          firstGeneration,
        )

        const second = yield* auth()
        const secondGeneration = yield* second.prepareForUrl("notion", "https://mcp.notion.com/mcp")
        expect((yield* second.get("notion"))?.tokens?.accessToken).toBe("first-account-token")
        yield* second.updateTokens(
          "notion",
          { accessToken: "second-account-token" },
          "https://mcp.notion.com/mcp",
          secondGeneration,
        )

        expect(yield* first.getForUrl("notion", "https://mcp.notion.com/mcp", firstGeneration)).toBeUndefined()
        expect(
          Exit.isFailure(
            yield* first
              .updateTokens(
                "notion",
                { accessToken: "late-first-account-token" },
                "https://mcp.notion.com/mcp",
                firstGeneration,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect((yield* second.get("notion"))?.tokens?.accessToken).toBe("second-account-token")

        yield* second.remove("notion")
        expect(
          Exit.isFailure(
            yield* second
              .updateTokens(
                "notion",
                { accessToken: "post-logout-token" },
                "https://mcp.notion.com/mcp",
                secondGeneration,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(yield* second.get("notion")).toBeUndefined()
      }),
    )
  })

  test("preserves a new legacy file created after staging", async () => {
    const legacy: LegacyFile = {
      content: JSON.stringify({
        notion: { tokens: { accessToken: "imported-token" }, serverUrl: "https://mcp.notion.com/mcp" },
      }),
      reads: 0,
    }
    await run(legacy, ({ storage, auth }) =>
      Effect.gen(function* () {
        const changed = { value: false }
        const concurrent = Storage.Service.of({
          ...storage,
          migrationReceipt: (name) =>
            storage.migrationReceipt(name).pipe(
              Effect.tap((receipt) =>
                Effect.sync(() => {
                  if (!receipt || changed.value) return
                  changed.value = true
                  legacy.content = JSON.stringify({
                    notion: {
                      tokens: { accessToken: "newer-legacy-token" },
                      serverUrl: "https://mcp.notion.com/mcp",
                    },
                  })
                }),
              ),
            ),
        })
        const service = yield* auth(concurrent)

        expect((yield* service.get("notion"))?.tokens?.accessToken).toBe("imported-token")
        expect(legacy.staging).toBeUndefined()
        expect(legacy.content).toContain("newer-legacy-token")
      }),
    )
  })

  test("accepts equivalent spellings of the configured URL for the same alias", async () => {
    await run({ content: undefined, reads: 0 }, ({ auth }) =>
      Effect.gen(function* () {
        const service = yield* auth()
        yield* service.set("posthog", { tokens: { accessToken: "access-token" } }, "https://mcp.posthog.com/mcp")

        expect((yield* service.getForUrl("posthog", "https://MCP.PostHog.com:443/mcp"))?.tokens?.accessToken).toBe(
          "access-token",
        )
      }),
    )
  })

  test("never hands one server's credentials to a different server", async () => {
    await run({ content: undefined, reads: 0 }, ({ auth }) =>
      Effect.gen(function* () {
        const service = yield* auth()
        yield* service.set("posthog", { tokens: { accessToken: "posthog-token" } }, "https://mcp.posthog.com/mcp?t=a")
        yield* service.set("stdio", { tokens: { accessToken: "stdio-token" } })

        for (const other of [
          "https://mcp.posthog.com/mcp?t=b",
          "https://mcp.posthog.com/MCP?t=a",
          "https://mcp.posthog.com/mcp/?t=a",
          "https://evil.example/mcp?t=a",
          "https://user@mcp.posthog.com/mcp?t=a",
        ])
          expect(yield* service.getForUrl("analytics", other)).toBeUndefined()

        expect((yield* service.get("posthog"))?.tokens?.accessToken).toBe("posthog-token")
        expect((yield* service.get("stdio"))?.tokens?.accessToken).toBe("stdio-token")
        expect(Object.keys(yield* service.all()).sort()).toEqual(["posthog", "stdio"])
      }),
    )
  })

  test("keeps OAuth attempt state process-local and out of durable storage", async () => {
    await run({ content: undefined, reads: 0 }, ({ storage, auth }) =>
      Effect.gen(function* () {
        const first = yield* auth()
        yield* first.set("posthog", {
          tokens: { accessToken: "durable-access-token" },
          codeVerifier: "ephemeral-code-verifier",
          oauthState: "ephemeral-oauth-state",
          serverUrl: "https://mcp.posthog.com/mcp",
        })

        expect((yield* first.get("posthog"))?.codeVerifier).toBe("ephemeral-code-verifier")
        expect(yield* first.getOAuthState("posthog")).toBe("ephemeral-oauth-state")

        const stored = yield* storage.get({
          scope: Storage.Scope.make("internal/mcp-auth/servers"),
          key: Storage.Key.make("entries"),
        })
        expect(stored?.value).not.toContain("durable-access-token")
        expect(stored?.value).toStartWith("forge-secret:v1:")
        expect(stored?.value).not.toContain("ephemeral-code-verifier")
        expect(stored?.value).not.toContain("ephemeral-oauth-state")

        const restarted = yield* auth()
        expect((yield* restarted.get("posthog"))?.tokens?.accessToken).toBe("durable-access-token")
        expect((yield* restarted.get("posthog"))?.codeVerifier).toBeUndefined()
        expect(yield* restarted.getOAuthState("posthog")).toBeUndefined()
      }),
    )
  })

  test("seals Notion OAuth credentials before durable storage", async () => {
    await run({ content: undefined, reads: 0 }, ({ storage, auth }) =>
      Effect.gen(function* () {
        const service = yield* auth()
        yield* service.set(
          "notion",
          {
            tokens: {
              accessToken: "notion-access-canary",
              refreshToken: "notion-refresh-canary",
            },
            clientInfo: {
              clientId: "notion-client-id-canary",
              clientSecret: "notion-client-secret-canary",
            },
          },
          "https://mcp.notion.com/mcp",
        )

        const stored = yield* storage.get({
          scope: Storage.Scope.make("internal/mcp-auth/servers"),
          key: Storage.Key.make("entries"),
        })
        expect(stored?.value).toStartWith("forge-secret:v1:")
        for (const canary of [
          "notion-access-canary",
          "notion-refresh-canary",
          "notion-client-id-canary",
          "notion-client-secret-canary",
        ])
          expect(stored?.value).not.toContain(canary)

        const restarted = yield* auth()
        expect(yield* restarted.getForUrl("notion", "https://mcp.notion.com/mcp")).toEqual({
          tokens: {
            accessToken: "notion-access-canary",
            refreshToken: "notion-refresh-canary",
          },
          clientInfo: {
            clientId: "notion-client-id-canary",
            clientSecret: "notion-client-secret-canary",
          },
          serverUrl: "https://mcp.notion.com/mcp",
        })
      }),
    )
  })

  test("drops OAuth attempt state while importing retained legacy credentials", async () => {
    await run(
      {
        content: JSON.stringify({
          posthog: {
            tokens: { accessToken: "legacy-access-token" },
            codeVerifier: "legacy-code-verifier",
            oauthState: "legacy-oauth-state",
          },
        }),
        reads: 0,
      },
      ({ storage, auth }) =>
        Effect.gen(function* () {
          const service = yield* auth()
          expect((yield* service.get("posthog"))?.tokens?.accessToken).toBe("legacy-access-token")
          expect((yield* service.get("posthog"))?.codeVerifier).toBeUndefined()
          expect(yield* service.getOAuthState("posthog")).toBeUndefined()

          const stored = yield* storage.get({
            scope: Storage.Scope.make("internal/mcp-auth/servers"),
            key: Storage.Key.make("entries"),
          })
          expect(stored?.value).not.toContain("legacy-code-verifier")
          expect(stored?.value).not.toContain("legacy-oauth-state")
        }),
    )
  })

  test("ignores malformed legacy input without recording secret-bearing state", async () => {
    const sentinel = "malformed-mcp-secret-sentinel"
    await run(
      {
        content: JSON.stringify({
          posthog: { tokens: { accessToken: sentinel } },
          invalid: { tokens: { refreshToken: sentinel } },
        }),
        reads: 0,
      },
      ({ storage, auth }) =>
        Effect.gen(function* () {
          const service = yield* auth()
          expect(yield* service.all()).toEqual({})
          expect(yield* storage.migrationReceipt("internal-mcp-auth-json-v1")).toBeUndefined()
          expect(yield* storage.list({ scope: Storage.Scope.make("internal/mcp-auth/servers") })).toEqual([])
        }),
    )
  })

  test("rejects malformed stored data without exposing or overwriting it", async () => {
    await run({ content: undefined, reads: 0 }, ({ storage, auth }) =>
      Effect.gen(function* () {
        const sentinel = "malformed-stored-mcp-secret"
        yield* storage.set({
          scope: Storage.Scope.make("internal/mcp-auth/servers"),
          key: Storage.Key.make("entries"),
          value: sentinel,
        })
        const result = yield* auth().pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) {
          expect(Cause.pretty(result.cause)).toContain("Stored MCP auth data is invalid")
          expect(Cause.pretty(result.cause)).not.toContain(sentinel)
        }

        const stored = yield* storage.get({
          scope: Storage.Scope.make("internal/mcp-auth/servers"),
          key: Storage.Key.make("entries"),
        })
        expect(stored?.value).toBe(sentinel)
      }),
    )
  })
})
