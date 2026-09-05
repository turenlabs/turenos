import { AISDK } from "@turenlabs/core/aisdk"
import { describe, expect } from "bun:test"
import { createServer } from "node:http"
import { Effect } from "effect"
import { ModelV2 } from "@turenlabs/core/model"
import { PluginV2 } from "@turenlabs/core/plugin"
import { PluginHost } from "@turenlabs/core/plugin/host"
import { OpenAICompatiblePlugin } from "@turenlabs/core/plugin/provider/openai-compatible"
import { ProviderV2 } from "@turenlabs/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* PluginV2.Service
  const aisdk = yield* AISDK.Service
  const host = yield* PluginHost.make(plugin)
  yield* OpenAICompatiblePlugin.effect(host)
})

describe("OpenAICompatiblePlugin", () => {
  it.live("reports a stalled SSE read once when abort also rejects cancellation", () =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const server = createServer((_, response) => {
            response.writeHead(200, { "content-type": "text/event-stream" })
            response.flushHeaders()
          })
          await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
          return server
        }),
        (server) =>
          Effect.sync(() => {
            server.closeAllConnections()
            server.close()
          }),
      )
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
      yield* addPlugin()
      const aisdk = yield* AISDK.Service
      const model = yield* aisdk.language(
        ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.make("custom"), ModelV2.ID.make("model")),
          api: {
            id: ModelV2.ID.make("model"),
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: `http://127.0.0.1:${address.port}`,
            settings: { chunkTimeout: 50 },
          },
        }),
      )
      yield* Effect.promise(async () => {
        const result = await model.doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        })
        await expect(
          (async () => {
            for await (const part of result.stream) {
              if (part.type === "error") throw part.error
            }
          })(),
        ).rejects.toThrow("SSE read timed out")
      })
    }),
  )

  it.effect("preserves explicit includeUsage false and defaults it to true", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      yield* addPlugin()
      const defaulted = yield* aisdk.runSDK({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.make("custom"), ModelV2.ID.make("model")),
          api: { id: ModelV2.ID.make("model"), type: "aisdk", package: "test-provider" },
        }),
        package: "@ai-sdk/openai-compatible",
        options: { name: "custom" },
      })
      const disabled = yield* aisdk.runSDK({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.make("custom"), ModelV2.ID.make("model")),
          api: { id: ModelV2.ID.make("model"), type: "aisdk", package: "test-provider" },
        }),
        package: "@ai-sdk/openai-compatible",
        options: { name: "custom", includeUsage: false },
      })
      expect(defaulted.options.includeUsage).toBe(true)
      expect(disabled.options.includeUsage).toBe(false)
    }),
  )

  it.effect("defaults includeUsage for OpenAI-compatible package matches", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      yield* addPlugin()
      const result = yield* aisdk.runSDK({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.make("custom"), ModelV2.ID.make("model")),
          api: { id: ModelV2.ID.make("model"), type: "aisdk", package: "test-provider" },
        }),
        package: "file:///tmp/@ai-sdk/openai-compatible-provider.js",
        options: { name: "custom" },
      })
      expect(result.options.includeUsage).toBe(true)
    }),
  )

  it.effect("uses the provider ID as the OpenAI-compatible provider name", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      const observed: string[] = []
      yield* addPlugin()
      yield* aisdk.hook.sdk((event) =>
        Effect.sync(() => {
          observed.push(event.sdk.languageModel("model").provider)
        }),
      )
      yield* aisdk.runSDK({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.make("custom-provider"), ModelV2.ID.make("model")),
          api: { id: ModelV2.ID.make("model"), type: "aisdk", package: "test-provider" },
        }),
        package: "@ai-sdk/openai-compatible",
        options: { name: "custom-provider", baseURL: "https://example.com/v1" },
      })
      expect(observed).toEqual(["custom-provider.chat"])
    }),
  )

  it.effect("does not overwrite an SDK created by an earlier provider-specific plugin", () =>
    Effect.gen(function* () {
      const aisdk = yield* AISDK.Service
      const sentinel = { languageModel: (modelID: string) => ({ modelID }) }
      yield* aisdk.hook.sdk((event) => {
        event.sdk = sentinel
      })
      yield* addPlugin()
      const result = yield* aisdk.runSDK({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.make("cloudflare-workers-ai"), ModelV2.ID.make("model")),
          api: { id: ModelV2.ID.make("model"), type: "aisdk", package: "test-provider" },
        }),
        package: "@ai-sdk/openai-compatible",
        options: { name: "cloudflare-workers-ai" },
      })
      expect(result.sdk).toBe(sentinel)
    }),
  )
})
