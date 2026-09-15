import { describe, expect } from "bun:test"
import { Clock, DateTime, Effect, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { AISDK } from "@turenlabs/core/aisdk"
import { Catalog } from "@turenlabs/core/catalog"
import { Integration } from "@turenlabs/core/integration"
import { Credential } from "@turenlabs/core/credential"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { Location } from "@turenlabs/core/location"
import { ModelV2 } from "@turenlabs/core/model"
import { Policy } from "@turenlabs/core/policy"
import { ProjectV2 } from "@turenlabs/core/project"
import { ProviderV2 } from "@turenlabs/core/provider"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { Storage } from "@turenlabs/core/storage"
import { SecretVault } from "@turenlabs/core/secret-vault"
import { SessionRunnerModel } from "@turenlabs/core/session/runner/model"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("test") })),
)
const catalogLayer = AppNodeBuilder.build(
  LayerNode.group([
    AISDK.node,
    Catalog.node,
    EventV2.node,
    Credential.node,
    Integration.node,
    Policy.node,
    SessionRunnerModel.node,
    SecretVault.node,
    Storage.node,
  ]),
  [[Location.node, locationLayer]],
)
const it = testEffect(catalogLayer)

describe("CatalogV2", () => {
  it.effect("publishes an updated event after catalog changes", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const events = yield* EventV2.Service
      const updated = yield* events
        .subscribe(Catalog.Event.Updated)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* catalog.transform((editor) => editor.provider.update(ProviderV2.ID.make("test"), () => {}))

      expect((yield* Fiber.join(updated)).length).toBe(1)
    }),
  )

  it.effect("derives availability from active credentials without changing provider state", () => {
    const integrationID = Integration.ID.make("test")
    const localCatalogLayer = Layer.fresh(
      AppNodeBuilder.build(LayerNode.group([Catalog.node, Credential.node]), [[Location.node, locationLayer]]),
    )

    return Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const credentials = yield* Credential.Service
      yield* catalog.transform((editor) => editor.provider.update(ProviderV2.ID.make("test"), () => {}))
      yield* credentials.create({
        integrationID,
        label: "First",
        value: Credential.Key.make({ type: "key", key: "first", metadata: { tenant: "one" } }),
      })

      expect((yield* catalog.provider.available()).map((provider) => provider.id)).toEqual([ProviderV2.ID.make("test")])
      expect(required(yield* catalog.provider.get(ProviderV2.ID.make("test"))).request.body).toEqual({})
      yield* credentials.create({
        integrationID,
        label: "Second",
        value: Credential.Key.make({ type: "key", key: "second", metadata: { tenant: "two" } }),
      })
      expect((yield* catalog.provider.available()).map((provider) => provider.id)).toEqual([ProviderV2.ID.make("test")])
      expect(required(yield* catalog.provider.get(ProviderV2.ID.make("test"))).request.body).toEqual({})
    }).pipe(Effect.provide(localCatalogLayer))
  })

  it.effect("suppresses a policy-denied provider until the deny is lifted", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const policy = yield* Policy.Service
      const providerID = ProviderV2.ID.make("test")

      // `disabled_providers` lowers to a `provider.use` deny, which is what removing a
      // built-in provider writes. The transform stays registered — finalize re-evaluates
      // the deny on every reload — so lifting it restores the provider without re-setup.
      yield* Effect.gen(function* () {
        yield* catalog.transform((editor) => editor.provider.update(providerID, () => {}))
        expect(yield* catalog.provider.get(providerID)).toBeDefined()

        yield* policy.load([new Policy.Info({ action: "provider.use", effect: "deny", resource: "test" })])
        yield* catalog.reload()
        expect(yield* catalog.provider.get(providerID)).toBeUndefined()
        expect(yield* catalog.provider.available()).toEqual([])

        yield* policy.load([])
        yield* catalog.reload()
        expect(yield* catalog.provider.get(providerID)).toBeDefined()
      }).pipe(Effect.ensuring(policy.load([])))
    }),
  )

  it.effect("derives availability from a provider's integration", () => {
    const integrationID = Integration.ID.make("gateway")
    const providerID = ProviderV2.ID.make("remote")
    const localCatalogLayer = Layer.fresh(
      AppNodeBuilder.build(LayerNode.group([Catalog.node, Credential.node, Integration.node]), [
        [Location.node, locationLayer],
      ]),
    )

    return Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* (yield* Integration.Service).transform((editor) => editor.update(integrationID, () => {}))
      yield* catalog.transform((editor) =>
        editor.provider.update(providerID, (provider) => {
          provider.integrationID = integrationID
        }),
      )
      expect(yield* catalog.provider.available()).toEqual([])

      yield* (yield* Credential.Service).create({
        integrationID,
        value: Credential.Key.make({ type: "key", key: "secret" }),
      })

      expect((yield* catalog.provider.available()).map((provider) => provider.id)).toEqual([providerID])
    }).pipe(Effect.provide(localCatalogLayer))
  })

  it.effect("projects environment connections without a catalog plugin", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.env.CATALOG_TEST_API_KEY
        process.env.CATALOG_TEST_API_KEY = "secret"
        return previous
      }),
      () =>
        Effect.gen(function* () {
          const catalog = yield* Catalog.Service
          const integrations = yield* Integration.Service
          const providerID = ProviderV2.ID.make("test")
          yield* integrations.transform((editor) =>
            editor.method.update({
              integrationID: Integration.ID.make(providerID),
              method: { type: "env", names: ["CATALOG_TEST_API_KEY"] },
            }),
          )
          yield* catalog.transform((editor) => editor.provider.update(providerID, () => {}))

          expect((yield* catalog.provider.available()).map((provider) => provider.id)).toContain(providerID)
        }),
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.CATALOG_TEST_API_KEY
          else process.env.CATALOG_TEST_API_KEY = previous
        }),
    ),
  )

  it.effect("normalizes provider baseURL into api url", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.make("test")
      yield* catalog.transform((catalog) =>
        catalog.provider.update(providerID, (provider) => {
          provider.api = {
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: "https://default.example.com",
          }
          provider.request.body.baseURL = "https://override.example.com"
        }),
      )

      expect(required(yield* catalog.provider.get(providerID)).api).toEqual({
        type: "aisdk",
        package: "@ai-sdk/openai-compatible",
        url: "https://override.example.com",
      })
    }),
  )

  it.effect("normalizes model baseURL into api url", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.make("test")
      const modelID = ModelV2.ID.make("model")
      yield* catalog.transform((catalog) => {
        catalog.provider.update(providerID, (provider) => {
          provider.api = {
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: "https://provider.example.com",
          }
        })
        catalog.model.update(providerID, modelID, (model) => {
          model.api = {
            id: modelID,
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: "https://model.example.com",
          }
          model.request.body.baseURL = "https://override.example.com"
        })
      })

      expect(required(yield* catalog.model.get(providerID, modelID)).api).toEqual({
        id: modelID,
        type: "aisdk",
        package: "@ai-sdk/openai-compatible",
        url: "https://override.example.com",
        settings: {},
      })
    }),
  )

  it.effect("keeps generic catalogs intact while the Agent Desktop view selects only routable tool models", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.make("catalog-scope")
      const supportedID = ModelV2.ID.make("supported")
      const unsupportedID = ModelV2.ID.make("unsupported")
      yield* catalog.transform((editor) => {
        editor.provider.update(providerID, (provider) => {
          provider.request.body.apiKey = "configured"
        })
        editor.model.update(providerID, supportedID, (model) => {
          model.api = {
            id: supportedID,
            type: "aisdk",
            package: "@ai-sdk/openai",
            url: "https://catalog-scope.example/v1",
          }
          model.capabilities.tools = true
        })
        editor.model.update(providerID, unsupportedID, (model) => {
          model.api = { id: unsupportedID, type: "aisdk", package: "@ai-sdk/xai" }
          model.capabilities.tools = true
        })
      })

      const available = yield* catalog.model.available()
      expect(available.map((model) => model.id)).toEqual(expect.arrayContaining([supportedID, unsupportedID]))
      expect(available.filter(SessionRunnerModel.selectable).map((model) => model.id)).toContain(supportedID)
      expect(available.filter(SessionRunnerModel.selectable).map((model) => model.id)).not.toContain(unsupportedID)
    }),
  )

  it.effect("filters OpenAI model listing by credential eligibility", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const providerID = ProviderV2.ID.openai
      const integrationID = Integration.ID.make("openai")
      const eligibleID = ModelV2.ID.make("gpt-5.3-codex-spark")
      const apiOnlyID = ModelV2.ID.make("gpt-4o")
      yield* integrations.transform((editor) => editor.update(integrationID, () => {}))
      yield* catalog.transform((editor) => {
        editor.provider.update(providerID, (provider) => {
          provider.integrationID = integrationID
          provider.api = { type: "aisdk", package: "@ai-sdk/openai" }
        })
        Array.from([eligibleID, apiOnlyID]).forEach((id) =>
          editor.model.update(providerID, id, (model) => {
            model.api = { id, type: "aisdk", package: "@ai-sdk/openai" }
            model.capabilities.tools = true
          }),
        )
      })
      yield* credentials.create({
        integrationID,
        value: Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("chatgpt-browser"),
          access: "oauth",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        }),
      })
      const oauthConnection = required(yield* integrations.connection.active(integrationID))
      const oauth = yield* integrations.connection.resolve(oauthConnection)
      const available = yield* catalog.model.available()

      expect(
        available.filter((model) => SessionRunnerModel.selectableWithCredential(model, oauth)).map((model) => model.id),
      ).toEqual([eligibleID])

      yield* credentials.create({
        integrationID,
        value: Credential.Key.make({ type: "key", key: "api-key" }),
      })
      const keyConnection = required(yield* integrations.connection.active(integrationID))
      const key = yield* integrations.connection.resolve(keyConnection)

      expect(
        available.filter((model) => SessionRunnerModel.selectableWithCredential(model, key)).map((model) => model.id),
      ).toEqual([apiOnlyID])
    }),
  )

  it.effect("falls back from an OAuth-ineligible configured default to an eligible ChatGPT model", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const providerID = ProviderV2.ID.openai
      const integrationID = Integration.ID.make("openai")
      const eligibleID = ModelV2.ID.make("gpt-5.3-codex-spark")
      const apiOnlyID = ModelV2.ID.make("gpt-4o")
      yield* integrations.transform((editor) => editor.update(integrationID, () => {}))
      yield* catalog.transform((editor) => {
        editor.provider.update(providerID, (provider) => {
          provider.integrationID = integrationID
          provider.api = { type: "aisdk", package: "@ai-sdk/openai" }
        })
        Array.from([eligibleID, apiOnlyID]).forEach((id) =>
          editor.model.update(providerID, id, (model) => {
            model.api = { id, type: "aisdk", package: "@ai-sdk/openai" }
            model.capabilities.tools = true
          }),
        )
        editor.model.default.set(providerID, apiOnlyID)
      })
      yield* credentials.create({
        integrationID,
        value: Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("chatgpt-browser"),
          access: "oauth",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        }),
      })

      const resolved = yield* (yield* SessionRunnerModel.Service).resolve(
        SessionV2.Info.make({
          id: SessionV2.ID.make("ses_oauth_default"),
          projectID: ProjectV2.ID.global,
          title: "test",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
          location: { directory: AbsolutePath.make("test") },
        }),
      )

      expect(resolved.ref).toMatchObject({ providerID, id: eligibleID })
      expect(resolved.model.route.endpoint.baseURL).toBe("https://chatgpt.com/backend-api/codex/responses")
    }),
  )

  it.effect("isolates stale provider authorization while listing models from healthy providers", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const staleIntegrationID = Integration.ID.make("openai")
      const staleMethodID = Integration.MethodID.make("chatgpt-browser")
      const healthyProviderID = ProviderV2.ID.make("healthy")
      const healthyIntegrationID = Integration.ID.make("healthy")
      const staleModelID = ModelV2.ID.make("gpt-4o")
      const healthyModelID = ModelV2.ID.make("healthy-model")
      yield* integrations.transform((editor) => {
        editor.method.update({
          integrationID: staleIntegrationID,
          method: { id: staleMethodID, type: "oauth", label: "ChatGPT" },
          authorize: () => Effect.die("unused"),
          refresh: () => Effect.fail(new Error("stale credential")),
        })
        editor.update(healthyIntegrationID, () => {})
      })
      yield* catalog.transform((editor) => {
        editor.provider.update(ProviderV2.ID.openai, (provider) => {
          provider.integrationID = staleIntegrationID
          provider.api = { type: "aisdk", package: "@ai-sdk/openai" }
        })
        editor.model.update(ProviderV2.ID.openai, staleModelID, (model) => {
          model.api = { id: staleModelID, type: "aisdk", package: "@ai-sdk/openai" }
          model.capabilities.tools = true
        })
        editor.provider.update(healthyProviderID, (provider) => {
          provider.integrationID = healthyIntegrationID
          provider.api = {
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: "https://healthy.example/v1",
          }
        })
        editor.model.update(healthyProviderID, healthyModelID, (model) => {
          model.api = {
            id: healthyModelID,
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: "https://healthy.example/v1",
          }
          model.capabilities.tools = true
        })
      })
      yield* credentials.create({
        integrationID: staleIntegrationID,
        value: Credential.OAuth.make({
          type: "oauth",
          methodID: staleMethodID,
          access: "expired",
          refresh: "expired",
          expires: 0,
        }),
      })
      yield* credentials.create({
        integrationID: healthyIntegrationID,
        value: Credential.Key.make({ type: "key", key: "healthy" }),
      })

      expect((yield* SessionRunnerModel.available()).map((model) => `${model.providerID}/${model.id}`)).toEqual([
        "healthy/healthy-model",
      ])
    }),
  )

  it.effect("resolves default model api from provider api", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.make("test")
      const modelID = ModelV2.ID.make("model")
      yield* catalog.transform((catalog) => {
        catalog.provider.update(providerID, (provider) => {
          provider.api = {
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: "https://provider.example.com",
          }
        })
        catalog.model.update(providerID, modelID, () => {})
      })

      expect(required(yield* catalog.model.get(providerID, modelID)).api).toEqual({
        id: modelID,
        type: "aisdk",
        package: "@ai-sdk/openai-compatible",
        url: "https://provider.example.com",
      })
    }),
  )

  it.effect("resolves provider and model request merges", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.make("test")
      const modelID = ModelV2.ID.make("model")
      yield* catalog.transform((catalog) => {
        catalog.provider.update(providerID, (provider) => {
          provider.request.headers.provider = "provider"
          provider.request.headers.shared = "provider"
          provider.request.body.provider = true
        })
        catalog.model.update(providerID, modelID, (model) => {
          model.request.headers.model = "model"
          model.request.headers.shared = "model"
          model.request.body.model = true
          model.request.body.request = true
          model.request.body.shared = "model"
        })
      })

      const model = required(yield* catalog.model.get(providerID, modelID))
      expect(model.request.headers).toEqual({ provider: "provider", shared: "model", model: "model" })
      expect(model.request.body).toEqual({ provider: true, model: true, request: true, shared: "model" })
    }),
  )

  it.effect("falls back to newest available model when no default is configured", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.make("test")
      yield* catalog.transform((catalog) => {
        catalog.provider.update(providerID, () => {})
        catalog.model.update(providerID, ModelV2.ID.make("old"), (model) => {
          model.time.released = 1000
        })
        catalog.model.update(providerID, ModelV2.ID.make("new"), (model) => {
          model.time.released = 2000
        })
      })

      expect((yield* catalog.model.default())?.id).toMatch("new")
    }),
  )

  it.effect("uses a transform-provided default model until that transform is replaced", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.make("test")
      const old = ModelV2.ID.make("old")
      const newest = ModelV2.ID.make("new")
      const models = (catalog: Catalog.Draft) => {
        catalog.provider.update(providerID, () => {})
        catalog.model.update(providerID, old, (model) => {
          model.time.released = 1000
        })
        catalog.model.update(providerID, newest, (model) => {
          model.time.released = 2000
        })
      }

      let configured = true
      yield* catalog.transform((catalog) => {
        models(catalog)
        if (configured) catalog.model.default.set(providerID, old)
      })
      expect((yield* catalog.model.default())?.id).toBe(old)

      configured = false
      yield* catalog.reload()
      expect((yield* catalog.model.default())?.id).toBe(newest)
    }),
  )

  it.effect("ignores a configured default on a disabled provider", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const disabledProvider = ProviderV2.ID.make("disabled")
      const enabledProvider = ProviderV2.ID.make("enabled")
      const disabledModel = ModelV2.ID.make("configured")
      const fallbackModel = ModelV2.ID.make("fallback")
      yield* catalog.transform((catalog) => {
        catalog.provider.update(disabledProvider, (provider) => {
          provider.disabled = true
        })
        catalog.model.update(disabledProvider, disabledModel, () => {})
        catalog.provider.update(enabledProvider, () => {})
        catalog.model.update(enabledProvider, fallbackModel, () => {})
        catalog.model.default.set(disabledProvider, disabledModel)
      })

      expect(yield* catalog.model.default()).toMatchObject({
        providerID: enabledProvider,
        id: fallbackModel,
      })
    }),
  )

  it.effect("small model prefers small keyword candidates before cost scoring", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.make("test")
      yield* catalog.transform((catalog) => {
        catalog.provider.update(providerID, () => {})
        catalog.model.update(providerID, ModelV2.ID.make("cheap-large"), (model) => {
          model.capabilities.input = ["text"]
          model.capabilities.output = ["text"]
          model.cost = [{ input: 1, output: 1, cache: { read: 0, write: 0 } }]
          model.time.released = Date.now()
        })
        catalog.model.update(providerID, ModelV2.ID.make("expensive-mini"), (model) => {
          model.capabilities.input = ["text"]
          model.capabilities.output = ["text"]
          model.cost = [{ input: 10, output: 10, cache: { read: 0, write: 0 } }]
          model.time.released = Date.now()
        })
      })

      expect((yield* catalog.model.small(providerID))?.id).toMatch("expensive-mini")
    }),
  )

  // Regression: the composer lists providers from the v1 catalog, which is authenticated by
  // auth.json. The v2 runner resolves from this catalog, which is gated on v2 credentials. When
  // auth.json was the only credential store the user had, every model the composer offered failed
  // to resolve with ModelUnavailableError. Any model the composer offers must be resolvable here.
  it.effect("resolves a model whose only credential lives in v1 auth.json", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const integrations = yield* Integration.Service
      const storage = yield* Storage.Service
      const providerID = ProviderV2.ID.make("kimi-for-coding")
      const integrationID = Integration.ID.make("kimi-for-coding")
      const modelID = ModelV2.ID.make("k3")

      // Exactly how the v1 Auth service persists auth.json.
      yield* storage.set({
        scope: Storage.Scope.make("internal/auth/providers"),
        key: Storage.Key.make("credentials"),
        value: JSON.stringify({ "kimi-for-coding": { type: "api", key: "kimi-secret" } }),
      })

      // Mirrors what the models-dev plugin contributes for this provider.
      yield* integrations.transform((editor) => editor.method.update({ integrationID, method: { type: "key" } }))
      yield* catalog.transform((editor) => {
        editor.provider.update(providerID, (provider) => {
          provider.api = { type: "aisdk", package: "@ai-sdk/anthropic", url: "https://api.kimi.com/coding/v1" }
        })
        editor.model.update(providerID, modelID, (model) => {
          model.api = { id: modelID, type: "aisdk", package: "@ai-sdk/anthropic" }
          model.capabilities.tools = true
        })
      })

      expect((yield* catalog.provider.available()).map((provider) => provider.id)).toContain(providerID)
      expect((yield* catalog.model.available()).map((model) => `${model.providerID}/${model.id}`)).toContain(
        "kimi-for-coding/k3",
      )

      const resolved = yield* (yield* SessionRunnerModel.Service).resolve(
        SessionV2.Info.make({
          id: SessionV2.ID.make("ses_v1_auth_bridge"),
          projectID: ProjectV2.ID.global,
          title: "test",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
          location: { directory: AbsolutePath.make("test") },
          model: { providerID, id: modelID },
        }),
      )

      expect(resolved.ref).toMatchObject({ providerID, id: modelID })
      expect(resolved.model.route.endpoint.baseURL).toBe("https://api.kimi.com/coding/v1")
    }),
  )

  // A composer-offered model can be absent from a given runtime's catalog — this fixture registers
  // no plugins, so `claude-code` (which the ClaudeCodePlugin creates only when the CLI probes as
  // authenticated) is missing here. The mismatch must name the provider and the reason instead of
  // looking identical to a missing credential.
  // Regression: the v1->V2 credential bridge is the only writer of OpenAI credentials most users
  // have, and it projects `auth.json` OAuth entries. Every other OAuth fixture in this file builds
  // a credential through `credentials.create`, which production never does for auth.json users, so
  // the projected shape went untested and every ChatGPT model failed to resolve. Drive the exact
  // bytes v1 persists, not a hand-built credential.
  it.effect("routes an auth.json ChatGPT OAuth credential through the Codex transport", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const storage = yield* Storage.Service
      const providerID = ProviderV2.ID.openai
      const integrationID = Integration.ID.make("openai")

      // Exactly how the v1 Auth service persists a ChatGPT connection, `accountId` included.
      yield* storage.set({
        scope: Storage.Scope.make("internal/auth/providers"),
        key: Storage.Key.make("credentials"),
        value: JSON.stringify({
          openai: {
            type: "oauth",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
            accountId: "acct_123",
          },
        }),
      })

      yield* integrations.transform((editor) => editor.update(integrationID, () => {}))
      // Mirrors the live models.dev catalog: no provider `api.url`, `@ai-sdk/openai`, no options.
      yield* catalog.transform((editor) => {
        editor.provider.update(providerID, (provider) => {
          provider.integrationID = integrationID
          provider.api = { type: "aisdk", package: "@ai-sdk/openai" }
        })
        for (const id of [ModelV2.ID.make("gpt-5.6-sol"), ModelV2.ID.make("gpt-5.5")]) {
          editor.model.update(providerID, id, (model) => {
            model.api = { id, type: "aisdk", package: "@ai-sdk/openai" }
            model.capabilities.tools = true
          })
        }
      })

      const connection = required(yield* integrations.connection.active(integrationID))
      const credential = yield* integrations.connection.resolve(connection)

      // The picker must offer exactly what the resolver can serve.
      expect(
        (yield* catalog.model.available())
          .filter((model) => SessionRunnerModel.selectableWithCredential(model, credential))
          .map((model) => model.id)
          .toSorted(),
      ).toEqual([ModelV2.ID.make("gpt-5.5"), ModelV2.ID.make("gpt-5.6-sol")])

      const resolved = yield* (yield* SessionRunnerModel.Service).resolve(
        SessionV2.Info.make({
          id: SessionV2.ID.make("ses_v1_chatgpt_oauth"),
          projectID: ProjectV2.ID.global,
          title: "test",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
          location: { directory: AbsolutePath.make("test") },
          model: { providerID, id: ModelV2.ID.make("gpt-5.6-sol") },
        }),
      )

      expect(resolved.model.route.endpoint.baseURL).toBe("https://chatgpt.com/backend-api/codex/responses")
      // `accountId` is what scopes a Codex request to the right ChatGPT org; dropping it 401s.
      expect(required(yield* credentials.get(Credential.ID.make("cred_v1_openai")))?.value).toMatchObject({
        type: "oauth",
        metadata: { accountID: "acct_123" },
      })
    }),
  )

  // An `auth.json` token that has already expired must refresh and the new token must land back in
  // `auth.json`. OpenAI rotates the refresh token on use, so a refresh that is not persisted makes
  // the *next* resolve present a refresh token the server has already retired.
  it.effect("persists a refreshed auth.json OAuth token back into the v1 store", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const storage = yield* Storage.Service
      const vault = yield* SecretVault.Service
      const integrationID = Integration.ID.make("openai")
      const scope = Storage.Scope.make("internal/auth/providers")
      const key = Storage.Key.make("credentials")
      // Expiry is compared against the Effect clock, which these tests hold at zero.
      const now = yield* Clock.currentTimeMillis
      let refreshes = 0

      yield* storage.set({
        scope,
        key,
        value: JSON.stringify({
          openai: {
            type: "oauth",
            access: "stale-access",
            refresh: "stale-refresh",
            expires: now,
            accountId: "acct_123",
          },
          // A second provider proves the rewrite touches only the entry that refreshed.
          "kimi-for-coding": { type: "api", key: "kimi-secret" },
        }),
      })
      yield* integrations.transform((editor) =>
        editor.method.update({
          integrationID,
          method: { id: Integration.MethodID.make("chatgpt-browser"), type: "oauth", label: "ChatGPT" },
          authorize: () => Effect.die("unused"),
          refresh: (value) => {
            refreshes += 1
            return Effect.succeed(
              Credential.OAuth.make({
                type: "oauth",
                methodID: Integration.MethodID.make("chatgpt-browser"),
                access: "fresh-access",
                refresh: "rotated-refresh",
                expires: now + 3_600_000,
                metadata: value.metadata,
              }),
            )
          },
        }),
      )

      const connection = required(yield* integrations.connection.active(integrationID))
      const first = yield* integrations.connection.resolve(connection)
      expect(first).toMatchObject({ type: "oauth", access: "fresh-access" })

      const sealed = required(yield* storage.get({ scope, key })).value
      const stored = JSON.parse(yield* vault.open(scope, key, sealed))
      expect(stored.openai).toEqual({
        type: "oauth",
        access: "fresh-access",
        refresh: "rotated-refresh",
        expires: expect.any(Number),
        accountId: "acct_123",
      })
      expect(stored["kimi-for-coding"]).toEqual({ type: "api", key: "kimi-secret" })

      // The persisted token is still valid, so resolving again must not burn the rotated refresh.
      yield* integrations.connection.resolve(required(yield* integrations.connection.active(integrationID)))
      expect(refreshes).toBe(1)
    }),
  )

  it.effect("persists a refreshed auth.json xAI OAuth token back into the v1 store", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const storage = yield* Storage.Service
      const vault = yield* SecretVault.Service
      const integrationID = Integration.ID.make("xai")
      const scope = Storage.Scope.make("internal/auth/providers")
      const key = Storage.Key.make("credentials")
      const now = yield* Clock.currentTimeMillis
      let refreshes = 0

      yield* storage.set({
        scope,
        key,
        value: JSON.stringify({
          xai: {
            type: "oauth",
            access: "stale-access",
            refresh: "stale-refresh",
            expires: now,
          },
        }),
      })
      yield* integrations.transform((editor) =>
        editor.method.update({
          integrationID,
          method: { id: Integration.MethodID.make("grok-browser"), type: "oauth", label: "xAI" },
          authorize: () => Effect.die("unused"),
          refresh: (value) => {
            refreshes += 1
            return Effect.succeed(
              Credential.OAuth.make({
                type: "oauth",
                methodID: Integration.MethodID.make("grok-browser"),
                access: "fresh-access",
                refresh: "rotated-refresh",
                expires: now + 3_600_000,
                metadata: value.metadata,
              }),
            )
          },
        }),
      )

      const connection = required(yield* integrations.connection.active(integrationID))
      const first = yield* integrations.connection.resolve(connection)
      expect(first).toMatchObject({ type: "oauth", access: "fresh-access" })

      const sealed = required(yield* storage.get({ scope, key })).value
      const stored = JSON.parse(yield* vault.open(scope, key, sealed))
      expect(stored.xai).toEqual({
        type: "oauth",
        access: "fresh-access",
        refresh: "rotated-refresh",
        expires: expect.any(Number),
      })

      yield* integrations.connection.resolve(required(yield* integrations.connection.active(integrationID)))
      expect(refreshes).toBe(1)
    }),
  )

  it.effect("tells the user what to do when ChatGPT sign-in cannot serve a model", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const integrations = yield* Integration.Service
      const storage = yield* Storage.Service
      const providerID = ProviderV2.ID.openai
      const integrationID = Integration.ID.make("openai")
      const modelID = ModelV2.ID.make("gpt-4o")

      yield* storage.set({
        scope: Storage.Scope.make("internal/auth/providers"),
        key: Storage.Key.make("credentials"),
        value: JSON.stringify({
          openai: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60_000 },
        }),
      })
      yield* integrations.transform((editor) => editor.update(integrationID, () => {}))
      yield* catalog.transform((editor) => {
        editor.provider.update(providerID, (provider) => {
          provider.integrationID = integrationID
          provider.api = { type: "aisdk", package: "@ai-sdk/openai" }
        })
        editor.model.update(providerID, modelID, (model) => {
          model.api = { id: modelID, type: "aisdk", package: "@ai-sdk/openai" }
          model.capabilities.tools = true
        })
      })

      const failure = yield* (yield* SessionRunnerModel.Service)
        .resolve(
          SessionV2.Info.make({
            id: SessionV2.ID.make("ses_oauth_ineligible"),
            projectID: ProjectV2.ID.global,
            title: "test",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
            location: { directory: AbsolutePath.make("test") },
            model: { providerID, id: modelID },
          }),
        )
        .pipe(Effect.flip)

      // A model the picker must not have offered still has to say what to do about it.
      expect(failure.message).toContain("API key")
    }),
  )

  it.effect("names the provider when a composer-offered model is absent from this catalog", () =>
    Effect.gen(function* () {
      const providerID = ProviderV2.ID.make("claude-code")
      const modelID = ModelV2.ID.make("opus")
      const resolving = yield* (yield* SessionRunnerModel.Service)
        .resolve(
          SessionV2.Info.make({
            id: SessionV2.ID.make("ses_absent_provider"),
            projectID: ProjectV2.ID.global,
            title: "test",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
            location: { directory: AbsolutePath.make("test") },
            model: { providerID, id: modelID },
          }),
        )
        .pipe(Effect.flip, Effect.forkChild)
      // A pinned model missing from the catalog is only a real answer once the
      // resolver has waited out the boot race it holds open for location plugins
      // still publishing providers. That wait sleeps on the clock these tests
      // hold at zero, so drive it past the bounded wait rather than leaving the
      // resolve suspended forever.
      for (let step = 0; step < 20; step++) yield* TestClock.adjust("1 second")
      const failure = yield* Fiber.join(resolving)

      expect(failure).toBeInstanceOf(SessionRunnerModel.ModelUnavailableError)
      expect(failure.message).toContain("claude-code/opus")
      expect(failure.message).toContain("not in this runtime's catalog")
    }),
  )

  it.effect("prefers a v2 credential over the v1 auth.json projection", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const storage = yield* Storage.Service
      const integrationID = Integration.ID.make("overridden")

      yield* storage.set({
        scope: Storage.Scope.make("internal/auth/providers"),
        key: Storage.Key.make("credentials"),
        value: JSON.stringify({ overridden: { type: "api", key: "from-auth-json" } }),
      })
      expect((yield* credentials.list(integrationID)).map((item) => item.value)).toEqual([
        Credential.Key.make({ type: "key", key: "from-auth-json" }),
      ])

      yield* credentials.create({
        integrationID,
        value: Credential.Key.make({ type: "key", key: "from-v2" }),
      })
      expect((yield* credentials.list(integrationID)).map((item) => item.value)).toEqual([
        Credential.Key.make({ type: "key", key: "from-v2" }),
      ])
    }),
  )

  it.effect("removes a v1 auth credential through its projected credential ID", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const storage = yield* Storage.Service
      const integrationID = Integration.ID.make("legacy-remove")

      yield* storage.set({
        scope: Storage.Scope.make("internal/auth/providers"),
        key: Storage.Key.make("credentials"),
        value: JSON.stringify({ "legacy-remove": { type: "api", key: "remove-me" } }),
      })
      const credential = required((yield* credentials.list(integrationID))[0])

      yield* credentials.remove(credential.id)

      expect(yield* credentials.list(integrationID)).toEqual([])
    }),
  )

  it.effect("removes providers denied by policy after loading", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const policy = yield* Policy.Service
      const providerID = ProviderV2.ID.make("blocked")
      yield* policy.load([new Policy.Info({ effect: "deny", action: "provider.use", resource: "blocked" })])
      yield* catalog.transform((catalog) => {
        catalog.provider.update(providerID, () => {})
        catalog.model.update(providerID, ModelV2.ID.make("model"), () => {})
      })

      expect(yield* catalog.provider.all()).toEqual([])
      expect(yield* catalog.model.all()).toEqual([])
      expect(yield* catalog.provider.get(providerID)).toBeUndefined()
    }),
  )
})
