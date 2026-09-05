import { describe, expect } from "bun:test"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { FSUtil } from "@turenlabs/core/fs-util"
import { ModelV2 } from "@turenlabs/core/model"
import { ProviderV2 } from "@turenlabs/core/provider"
import { SessionEvent } from "@turenlabs/core/session/event"
import { SessionMessage } from "@turenlabs/core/session/message"
import { DateTime, Effect, Layer } from "effect"
import path from "path"
import { Session } from "@/session/session"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { markPluginDependenciesReady } from "../fixture/plugin"
import { trustProject } from "../fixture/plugin-trust"
import { testEffect } from "../lib/effect"
import { httpApiLayer, request } from "./httpapi-layer"

const testStateLayer = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.promise(() => resetDatabase()),
    () => Effect.promise(() => resetDatabase()),
  ),
)

const it = testEffect(
  Layer.mergeAll(
    testStateLayer,
    LayerNode.compile(FSUtil.node),
    LayerNode.compile(LayerNode.group([EventV2.node, Session.node])),
    httpApiLayer,
  ),
)
const projectOptions = { config: { formatter: false, lsp: false } }
const providerID = "test-oauth-parity"
const oauthURL = "https://example.com/oauth"
const oauthInstructions = "Finish OAuth"

function providerListHasFetch(list: unknown) {
  if (!Array.isArray(list)) return false
  return list.some((item: unknown) => {
    if (typeof item !== "object" || item === null || !("id" in item) || !("options" in item)) return false
    if (item.id !== "google") return false
    if (typeof item.options !== "object" || item.options === null) return false
    return "fetch" in item.options
  })
}

function hasProviderWithFetch(input: unknown, key: "all" | "providers") {
  if (typeof input !== "object" || input === null) return false
  if (key === "all") return "all" in input && providerListHasFetch(input.all)
  return "providers" in input && providerListHasFetch(input.providers)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function providerList(input: unknown, key: "all" | "providers") {
  if (!isRecord(input)) return []
  if (!Array.isArray(input[key])) return []
  return input[key]
}

function providerByID(input: unknown, key: "all" | "providers", id: string) {
  return providerList(input, key).find((provider) => isRecord(provider) && provider.id === id)
}

function hasProviderMutationMarker(input: unknown, key: "all" | "providers", id: string) {
  const provider = providerByID(input, key, id)
  if (!isRecord(provider)) return false
  if (provider.name === "mutated-provider") return true
  return isRecord(provider.options) && provider.options.mutatedByPlugin === true
}

function requestAuthorize(input: {
  providerID: string
  method: number
  headers: HeadersInit
  inputs?: Record<string, string>
}) {
  return Effect.gen(function* () {
    const response = yield* request(`/provider/${input.providerID}/oauth/authorize`, {
      method: "POST",
      headers: input.headers,
      body: JSON.stringify({ method: input.method, ...(input.inputs ? { inputs: input.inputs } : {}) }),
    })
    return {
      status: response.status,
      body: yield* response.text,
    }
  })
}

function requestCallback(input: { providerID: string; method: number; headers: HeadersInit; code?: string }) {
  return Effect.gen(function* () {
    const response = yield* request(`/provider/${input.providerID}/oauth/callback`, {
      method: "POST",
      headers: input.headers,
      body: JSON.stringify({ method: input.method, ...(input.code ? { code: input.code } : {}) }),
    })
    return {
      status: response.status,
      body: yield* response.text,
    }
  })
}

function writeProviderAuthPlugin(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* Effect.promise(() => markPluginDependenciesReady(path.join(dir, ".forge")))

    yield* fs.writeWithDirs(
      path.join(dir, ".forge", "plugin", "provider-oauth-parity.ts"),
      [
        "export default {",
        '  id: "test.provider-oauth-parity",',
        "  server: async () => ({",
        "    auth: {",
        `      provider: "${providerID}",`,
        "      methods: [",
        '        { type: "api", label: "API key" },',
        "        {",
        '          type: "oauth",',
        '          label: "OAuth",',
        "          authorize: async () => ({",
        `            url: "${oauthURL}",`,
        '            method: "code",',
        `            instructions: "${oauthInstructions}",`,
        "            callback: async () => ({ type: 'success', key: 'token' }),",
        "          }),",
        "        },",
        "      ],",
        "    },",
        "  }),",
        "}",
        "",
      ].join("\n"),
    )

    // Plugin files in the opened project do not run until they are approved.
    yield* trustProject(dir)
  })
}

function writeProviderAuthValidationPlugin(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* Effect.promise(() => markPluginDependenciesReady(path.join(dir, ".forge")))

    yield* fs.writeWithDirs(
      path.join(dir, ".forge", "plugin", "provider-oauth-validation.ts"),
      [
        "export default {",
        '  id: "test.provider-oauth-validation",',
        "  server: async () => ({",
        "    auth: {",
        '      provider: "test-oauth-validation",',
        "      methods: [",
        "        {",
        '          type: "oauth",',
        '          label: "OAuth",',
        "          prompts: [",
        "            {",
        '              type: "text",',
        '              key: "token",',
        '              message: "Token",',
        "              validate: (value) => value === 'ok' ? undefined : 'Token must be ok',",
        "            },",
        "          ],",
        "          authorize: async () => ({",
        `            url: "${oauthURL}",`,
        '            method: "code",',
        `            instructions: "${oauthInstructions}",`,
        "            callback: async () => ({ type: 'success', key: 'token' }),",
        "          }),",
        "        },",
        "      ],",
        "    },",
        "  }),",
        "}",
        "",
      ].join("\n"),
    )

    // Plugin files in the opened project do not run until they are approved.
    yield* trustProject(dir)
  })
}

function writeFunctionOptionsPlugin(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* Effect.promise(() => markPluginDependenciesReady(path.join(dir, ".forge")))

    yield* fs.writeWithDirs(
      path.join(dir, ".forge", "plugin", "provider-function-options.ts"),
      [
        "export default {",
        '  id: "test.provider-function-options",',
        "  server: async () => ({",
        "    auth: {",
        '      provider: "google",',
        "      loader: async (_getAuth, provider) => {",
        "        for (const model of Object.values(provider.models ?? {})) {",
        "          model.cost = { input: 0, output: 0 }",
        "        }",
        "        return {",
        '        apiKey: "",',
        "        fetch: async (input, init) => fetch(input, init),",
        "        }",
        "      },",
        "      methods: [{ type: 'api', label: 'API key' }],",
        "    },",
        "  }),",
        "}",
        "",
      ].join("\n"),
    )

    // Plugin files in the opened project do not run until they are approved.
    yield* trustProject(dir)
  })
}

function writeProviderModelsMutationPlugin(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* Effect.promise(() => markPluginDependenciesReady(path.join(dir, ".forge")))

    yield* fs.writeWithDirs(
      path.join(dir, ".forge", "plugin", "provider-models-mutation.ts"),
      [
        "export default {",
        '  id: "test.provider-models-mutation",',
        "  server: async () => ({",
        "    provider: {",
        '      id: "google",',
        "      models: async (provider) => {",
        "        const models = Object.fromEntries(",
        "          Object.entries(provider.models ?? {}).map(([id, model]) => [id, { ...model }]),",
        "        )",
        '        provider.name = "mutated-provider"',
        "        provider.options = { ...provider.options, mutatedByPlugin: true }",
        "        for (const model of Object.values(provider.models ?? {})) {",
        "          model.cost = { input: 0, output: 0 }",
        "        }",
        "        return models",
        "      },",
        "    },",
        "  }),",
        "}",
        "",
      ].join("\n"),
    )

    // Plugin files in the opened project do not run until they are approved.
    yield* trustProject(dir)
  })
}

function setEnvScoped(key: string, value: string) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env[key]
      process.env[key] = value
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[key]
        else process.env[key] = previous
      }),
  )
}

describe("provider HttpApi", () => {
  it.instance(
    "returns the local seven-day usage window",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const sessionID = (yield* (yield* Session.Service).create({ title: "Usage test" })).id
      const assistantMessageID = SessionMessage.ID.create()
      const timestamp = Date.now()
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        agent: "build",
        model: {
          providerID: ProviderV2.ID.make("usage-provider"),
          id: ModelV2.ID.make("usage-model"),
          variant: undefined,
        },
        timestamp: DateTime.makeUnsafe(timestamp),
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID,
        assistantMessageID,
        finish: "end_turn",
        cost: 0.25,
        tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 4 } },
        billed: { input: 20, output: 5, reasoning: 2, cache: { read: 6, write: 8 } },
        timestamp: DateTime.makeUnsafe(timestamp + 1),
      })
      const futureMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID: futureMessageID,
        agent: "build",
        model: {
          providerID: ProviderV2.ID.make("usage-provider"),
          id: ModelV2.ID.make("usage-model"),
          variant: undefined,
        },
        timestamp: DateTime.makeUnsafe(timestamp + 60_000),
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID,
        assistantMessageID: futureMessageID,
        finish: "end_turn",
        cost: 10,
        tokens: { input: 100, output: 100, reasoning: 100, cache: { read: 100, write: 100 } },
        timestamp: DateTime.makeUnsafe(timestamp + 60_001),
      })
      const before = Date.now()
      const response = yield* request("/provider/usage", {
        headers: { "x-forge-directory": directory },
      })
      const body = yield* response.json

      expect(response.status).toBe(200)
      if (!isRecord(body)) throw new Error("Expected usage response object")
      if (
        typeof body.start !== "number" ||
        typeof body.end !== "number" ||
        !Array.isArray(body.providers) ||
        !Array.isArray(body.quotas)
      ) {
        throw new Error("Expected usage response fields")
      }
      expect(body.start).toBeGreaterThanOrEqual(before - 7 * 24 * 60 * 60 * 1000)
      expect(body.end).toBeGreaterThanOrEqual(before)
      expect(body.providers).toEqual([
        {
          providerID: "usage-provider",
          turns: 1,
          cost: 0.25,
          tokens: { input: 20, output: 5, reasoning: 2, cache: { read: 6, write: 8 } },
        },
      ])
    }),
    projectOptions,
  )

  it.instance.skip(
    "returns public v2 provider not found errors",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const response = yield* request("/api/provider/missing", {
        headers: { "x-forge-directory": directory },
      })

      expect(response.status).toBe(404)
      expect(yield* response.json).toEqual({
        _tag: "ProviderNotFoundError",
        providerID: "missing",
        message: "Provider not found: missing",
      })
    }),
    projectOptions,
  )

  it.instance(
    "serves OAuth authorize response shapes",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const headers = { "x-forge-directory": directory, "content-type": "application/json" }
      const api = yield* requestAuthorize({
        providerID,
        method: 0,
        headers,
      })
      // method 0 (api-key style) — authorize() resolves with no further
      // redirect; #26474 changed the wire format to JSON `null` so clients
      // can `.json()` parse uniformly instead of getting an empty body
      // that throws.
      expect(api).toEqual({ status: 200, body: "null" })

      const oauth = yield* requestAuthorize({
        providerID,
        method: 1,
        headers,
      })
      expect(JSON.parse(oauth.body)).toEqual({
        url: oauthURL,
        method: "code",
        instructions: oauthInstructions,
      })
    }),
    { ...projectOptions, init: writeProviderAuthPlugin },
    30000,
  )

  it.instance(
    "returns declared provider auth validation errors",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const response = yield* requestAuthorize({
        providerID: "test-oauth-validation",
        method: 0,
        inputs: { token: "nope" },
        headers: { "x-forge-directory": directory, "content-type": "application/json" },
      })

      expect(response.status).toBe(400)
      expect(JSON.parse(response.body)).toEqual({
        name: "ProviderAuthValidationFailed",
        data: { field: "token", message: "Token must be ok" },
      })
    }),
    { ...projectOptions, init: writeProviderAuthValidationPlugin },
    30000,
  )

  it.instance(
    "returns declared provider auth callback errors",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const response = yield* requestCallback({
        providerID,
        method: 0,
        headers: { "x-forge-directory": directory, "content-type": "application/json" },
      })

      expect(response.status).toBe(400)
      expect(JSON.parse(response.body)).toEqual({
        name: "ProviderAuthOauthMissing",
        data: { providerID },
      })
    }),
    projectOptions,
    30000,
  )

  it.instance(
    "serves provider lists when auth loaders add runtime fetch options",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      yield* setEnvScoped(
        "FORGE_AUTH_CONTENT",
        JSON.stringify({
          google: { type: "oauth", refresh: "dummy", access: "dummy", expires: 9999999999999 },
        }),
      )
      const headers = { "x-forge-directory": directory }
      const providerResponse = yield* request("/provider", { headers })
      const configResponse = yield* request("/config/providers", { headers })

      expect(providerResponse.status).toBe(200)
      expect(configResponse.status).toBe(200)

      const providerBody = yield* providerResponse.json
      const configBody = yield* configResponse.json
      expect(hasProviderWithFetch(providerBody, "all")).toBe(false)
      expect(hasProviderWithFetch(configBody, "providers")).toBe(false)
      expect(providerByID(providerBody, "all", "google")).toMatchObject({ auth: "oauth" })
      expect(providerByID(configBody, "providers", "google")).toBeDefined()
    }),
    { ...projectOptions, init: writeFunctionOptionsPlugin },
  )

  it.instance(
    "keeps provider.models hook input mutations out of provider state",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory

      const headers = { "x-forge-directory": directory }
      const providerResponse = yield* request("/provider", { headers })
      const configResponse = yield* request("/config/providers", { headers })

      expect(providerResponse.status).toBe(200)
      expect(configResponse.status).toBe(200)

      const providerBody = yield* providerResponse.json
      const configBody = yield* configResponse.json
      expect(hasProviderMutationMarker(providerBody, "all", "google")).toBe(false)
      expect(hasProviderMutationMarker(configBody, "providers", "google")).toBe(false)
      expect(providerByID(providerBody, "all", "google")).toBeDefined()
    }),
    { ...projectOptions, init: writeProviderModelsMutationPlugin },
  )
})
