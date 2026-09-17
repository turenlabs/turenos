// End-to-end coverage for local providers. Unlike the per-plugin tests, which stub
// `HttpClient.HttpClient`, these run real loopback HTTP servers and exercise the whole
// chain a user depends on: plugin discovery -> catalog publication -> model resolution
// -> `LLMClient.generate` -> a real streamed `/v1/chat/completions` round trip.
//
// The discovery poll is driven by TestClock (`TestClock.adjust`), while waiting for the
// resulting real fetches to land is done on wall-clock time via `waitFor`.

import { describe, expect } from "bun:test"
import { Catalog } from "@turenlabs/core/catalog"
import { Config } from "@turenlabs/core/config"
import { ConfigProviderPlugin } from "@turenlabs/core/config/plugin/provider"
import { ModelV2 } from "@turenlabs/core/model"
import { PluginV2 } from "@turenlabs/core/plugin"
import { PluginHost } from "@turenlabs/core/plugin/host"
import { ClaudeCodePlugin, overrideProbe, resetProbeCache } from "@turenlabs/core/plugin/provider/claude-code"
import { LlamaCppPlugin } from "@turenlabs/core/plugin/provider/llama-cpp"
import { MuseCodePlugin } from "@turenlabs/core/plugin/provider/muse-code"
import { OllamaPlugin } from "@turenlabs/core/plugin/provider/ollama"
import { ProjectV2 } from "@turenlabs/core/project"
import { ProviderV2 } from "@turenlabs/core/provider"
import { ClaudeCodeCLI } from "@turenlabs/core/provider/claude-code"
import { MuseCodeCLI } from "@turenlabs/core/provider/muse-code"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionRunnerModel } from "@turenlabs/core/session/runner/model"
import { LLM, LLMClient, LLMError, Message, ToolCallPart } from "@turenlabs/llm"
import { RequestExecutor } from "@turenlabs/llm/route"
import { Cause, DateTime, Effect, Exit, Layer, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(
  LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer), Layer.provideMerge(PluginTestLayer)),
)

const ollama = ProviderV2.ID.make("ollama")
const llamaCpp = ProviderV2.ID.make("llama-cpp")
const decode = Schema.decodeUnknownSync(Config.Info)

type Hit = {
  readonly method: string
  readonly path: string
  readonly authorization: string | null
  readonly userAgent: string | null
  readonly body: Record<string, unknown> | undefined
}

type ChatHandler = (body: Record<string, unknown> | undefined) => Response

const listen = (
  handler: (request: Request, hit: Hit) => Response | Promise<Response>,
  options?: { port?: number },
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const hits: Hit[] = []
      let stopped = false
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: options?.port ?? 0,
        fetch: async (request) => {
          const url = new URL(request.url)
          const hit: Hit = {
            method: request.method,
            path: url.pathname,
            authorization: request.headers.get("authorization"),
            userAgent: request.headers.get("user-agent"),
            body:
              request.method === "POST"
                ? ((await request.json().catch(() => undefined)) as Record<string, unknown> | undefined)
                : undefined,
          }
          hits.push(hit)
          return handler(request, hit)
        },
      })
      return {
        url: `http://127.0.0.1:${server.port}`,
        hits,
        stop: () => {
          if (stopped) return
          stopped = true
          server.stop(true)
        },
      }
    }),
    (server) => Effect.sync(() => server.stop()),
  )

const sseFrame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`

const sseChunk = (delta: Record<string, unknown>, finishReason?: string) =>
  sseFrame({
    id: "chatcmpl-e2e",
    object: "chat.completion.chunk",
    created: 1,
    model: "e2e",
    choices: [{ index: 0, delta, ...(finishReason === undefined ? {} : { finish_reason: finishReason }) }],
  })

// A minimal well-formed OpenAI Chat stream: role, one content delta, the stop
// chunk, the `stream_options.include_usage` trailer, and the [DONE] sentinel.
const chatCompletion = (text: string) =>
  new Response(
    sseChunk({ role: "assistant" }) +
      sseChunk({ content: text }) +
      sseChunk({}, "stop") +
      sseFrame({
        id: "chatcmpl-e2e",
        object: "chat.completion.chunk",
        created: 1,
        model: "e2e",
        choices: [],
        usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
      }) +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  )

const DONE = "data: [DONE]\n\n"

const streamResponse = (body: string) =>
  new Response(body, { headers: { "content-type": "text/event-stream" } })

// Real Ollama OpenAI-compat chunks carry `system_fingerprint`, an explicit
// `finish_reason: null`, and a separate `choices: []` usage trailer.
const ollamaDelta = (model: string, delta: Record<string, unknown>, finishReason: string | null = null) =>
  sseFrame({
    id: "chatcmpl-742",
    object: "chat.completion.chunk",
    created: 1_758_075_000,
    model,
    system_fingerprint: "fp_ollama",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })

const ollamaUsage = (model: string, usage: Record<string, unknown>) =>
  sseFrame({
    id: "chatcmpl-742",
    object: "chat.completion.chunk",
    created: 1_758_075_000,
    model,
    system_fingerprint: "fp_ollama",
    choices: [],
    usage,
  })

// llama.cpp carries `timings` on the same chunk that reports finish_reason and
// annotates /v1/models entries with a `meta` block — both must be tolerated.
const llamacppDelta = (
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  extra: Record<string, unknown> = {},
) =>
  sseFrame({
    choices: [{ finish_reason: finishReason, index: 0, delta }],
    created: 1_758_075_000,
    id: "chatcmpl-lc1",
    model,
    system_fingerprint: "b7125-a1b2c3d",
    object: "chat.completion.chunk",
    ...extra,
  })

const notFound = () => Response.json({ error: "not found" }, { status: 404 })

const serveOllama = (state: { models: unknown[]; chat?: ChatHandler }, options?: { port?: number }) =>
  listen((request, hit) => {
    if (request.method === "GET" && hit.path === "/api/tags") return Response.json({ models: state.models })
    if (request.method === "POST" && hit.path === "/v1/chat/completions")
      return state.chat?.(hit.body) ?? chatCompletion("ollama e2e reply")
    return notFound()
  }, options)

const serveLlamaCpp = (
  state: { models: unknown[]; nCtx?: number; props?: boolean; chat?: ChatHandler },
  options?: { port?: number },
) =>
  listen((request, hit) => {
    if (request.method === "GET" && hit.path === "/v1/models")
      return Response.json({ object: "list", data: state.models })
    if (request.method === "GET" && hit.path === "/props")
      return state.props === false
        ? notFound()
        : Response.json({
            default_generation_settings: { n_ctx: state.nCtx ?? 8_192, params: {} },
            total_slots: 1,
            model_path: "/models/qwen3-8b.gguf",
            chat_template: "{% for message in messages %}...{% endfor %}",
            bos_token: "<|begin_of_text|>",
          })
    if (request.method === "POST" && hit.path === "/v1/chat/completions")
      return state.chat?.(hit.body) ?? chatCompletion("llama.cpp e2e reply")
    return notFound()
  }, options)

const configWith = (providers: Record<string, unknown>) =>
  Config.Service.of({
    entries: () =>
      Effect.succeed([new Config.Document({ type: "document", info: decode({ providers }) })]),
  })

const host = Effect.flatMap(PluginV2.Service, (plugin) => PluginHost.make(plugin))

const session = (providerID: ProviderV2.ID, modelID: ModelV2.ID) =>
  SessionV2.Info.make({
    id: SessionV2.ID.make("ses_local_provider_e2e"),
    projectID: ProjectV2.ID.global,
    title: "local provider e2e",
    model: { providerID, id: modelID },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: { directory: AbsolutePath.make("/project") },
  })

// The discovery loop sleeps on the test clock, but its fetch is real — after
// `TestClock.adjust` re-arms the poll, give the loopback request real time to land.
const waitFor = <A, E, R>(probe: Effect.Effect<A | undefined, E, R>, message: string) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 5_000
    while (true) {
      const value = yield* probe
      if (value !== undefined) return value
      if (Date.now() > deadline) return yield* Effect.die(new Error(message))
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)))
    }
  })

// Catalog read -> SessionRunnerModel resolution.
const resolve = Effect.fnUntraced(function* (providerID: ProviderV2.ID, modelID: ModelV2.ID) {
  const catalog = yield* Catalog.Service
  const model = yield* catalog.model.get(providerID, modelID)
  if (!model) return yield* Effect.die(new Error(`model ${providerID}/${modelID} missing from catalog`))
  return yield* SessionRunnerModel.resolveWithRef(session(providerID, modelID), model)
})

// Catalog read -> SessionRunnerModel resolution -> real streamed provider turn.
const complete = Effect.fnUntraced(function* (providerID: ProviderV2.ID, modelID: ModelV2.ID, prompt: string) {
  const resolved = yield* resolve(providerID, modelID)
  const llm = yield* LLMClient.Service
  const response = yield* llm.generate(LLM.request({ model: resolved.model, prompt }))
  return { resolved, response }
})

// Install a fake CLI binary on PATH for the duration of a scope — the local CLI
// providers resolve their executable through `which`, so a real process spawn
// decides availability.
const withPathBin = Effect.fnUntraced(function* (name: string) {
  const dir = yield* Effect.acquireRelease(
    Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "local-provider-e2e-"))),
    (dir) => Effect.sync(() => fs.rmSync(dir, { recursive: true, force: true })),
  )
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env.PATH ?? ""
      process.env.PATH = `${dir}${path.delimiter}${previous}`
      return previous
    }),
    (previous) => Effect.sync(() => (process.env.PATH = previous)),
  )
  const bin = path.join(dir, name)
  const write = (contents: string) => {
    fs.writeFileSync(bin, contents)
    fs.chmodSync(bin, 0o755)
  }
  return { bin, write }
})

const chatHits = (server: { hits: Hit[] }) => server.hits.filter((hit) => hit.path === "/v1/chat/completions")

describe("local providers e2e", () => {
  it.effect("discovers Ollama over real HTTP and completes a real streamed turn", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const server = yield* serveOllama({
        models: [
          { name: "qwen3:8b", modified_at: "2026-08-01T12:00:00Z", details: { family: "qwen3" } },
        ],
      })
      yield* OllamaPlugin.effect(yield* host).pipe(
        Effect.provideService(
          Config.Service,
          configWith({ ollama: { request: { body: { baseURL: server.url } } } }),
        ),
      )

      expect(server.hits.map((hit) => `${hit.method} ${hit.path}`)).toEqual(["GET /api/tags"])
      expect(yield* catalog.provider.get(ollama)).toMatchObject({
        name: "Ollama",
        api: { package: "@ai-sdk/openai-compatible", url: `${server.url}/v1` },
      })
      expect((yield* catalog.provider.available()).map((provider) => provider.id)).toContain(ollama)
      expect(yield* catalog.model.get(ollama, ModelV2.ID.make("qwen3:8b"))).toMatchObject({
        name: "qwen3:8b",
        family: "qwen3",
        enabled: true,
        limit: { context: 32_768, output: 8_192 },
      })

      const { resolved, response } = yield* complete(ollama, ModelV2.ID.make("qwen3:8b"), "say hi")
      expect(resolved.model.route.endpoint.baseURL).toBe(`${server.url}/v1`)
      expect(response.finishReason).toBe("stop")
      expect(response.text).toBe("ollama e2e reply")
      expect(response.usage).toMatchObject({ inputTokens: 9, outputTokens: 4, totalTokens: 13 })

      const hits = chatHits(server)
      expect(hits).toHaveLength(1)
      expect(hits[0]!.method).toBe("POST")
      expect(hits[0]!.authorization).toBe("Bearer ollama")
      expect(hits[0]!.userAgent).toMatch(/^TurenOS\//)
      expect(hits[0]!.body).toMatchObject({
        model: "qwen3:8b",
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "say hi" }],
      })
    }),
  )

  it.effect("discovers llama.cpp over real HTTP, adopts /props context, and completes a turn", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const server = yield* serveLlamaCpp({
        models: [{ id: "models/qwen3-8b.gguf", object: "model", created: 1_700_000_000, owned_by: "llamacpp" }],
        nCtx: 65_536,
      })
      yield* LlamaCppPlugin.effect(yield* host).pipe(
        Effect.provideService(
          Config.Service,
          configWith({
            "llama-cpp": { api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${server.url}/v1` } },
          }),
        ),
      )

      expect(server.hits.map((hit) => `${hit.method} ${hit.path}`)).toEqual(["GET /v1/models", "GET /props"])
      expect(yield* catalog.provider.get(llamaCpp)).toMatchObject({ name: "llama.cpp" })
      const model = yield* catalog.model.get(llamaCpp, ModelV2.ID.make("models/qwen3-8b.gguf"))
      expect(model).toMatchObject({
        enabled: true,
        time: { released: 1_700_000_000_000 },
        limit: { context: 65_536, output: 8_192 },
      })

      const { response } = yield* complete(llamaCpp, ModelV2.ID.make("models/qwen3-8b.gguf"), "say hi")
      expect(response.finishReason).toBe("stop")
      expect(response.text).toBe("llama.cpp e2e reply")

      const hits = chatHits(server)
      expect(hits).toHaveLength(1)
      expect(hits[0]!.authorization).toBe("Bearer llamacpp")
      expect(hits[0]!.body).toMatchObject({ model: "models/qwen3-8b.gguf", stream: true })
    }),
  )

  it.effect("connects a config-declared local provider and completes a turn", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const server = yield* listen((request, hit) =>
        request.method === "POST" && hit.path === "/v1/chat/completions"
          ? chatCompletion("custom provider e2e reply")
          : notFound(),
      )
      const providerID = ProviderV2.ID.make("lmstudio")
      yield* ConfigProviderPlugin.Plugin.effect(yield* host).pipe(
        Effect.provideService(
          Config.Service,
          configWith({
            lmstudio: {
              name: "LM Studio",
              api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${server.url}/v1` },
              request: { body: { apiKey: "lmstudio" } },
              models: {
                friendly: {
                  name: "Friendly Local",
                  api: { type: "aisdk", package: "@ai-sdk/openai-compatible", id: "served-model-id" },
                  capabilities: { tools: true, input: ["text"], output: ["text"] },
                  limit: { context: 32_768, output: 4_096 },
                },
              },
            },
          }),
        ),
      )

      const model = yield* catalog.model.get(providerID, ModelV2.ID.make("friendly"))
      // The model inherits the provider endpoint and keeps its own wire id.
      expect(model).toMatchObject({
        name: "Friendly Local",
        enabled: true,
        api: { type: "aisdk", package: "@ai-sdk/openai-compatible", id: "served-model-id", url: `${server.url}/v1` },
        limit: { context: 32_768, output: 4_096 },
      })

      const { response } = yield* complete(providerID, ModelV2.ID.make("friendly"), "say hi")
      expect(response.text).toBe("custom provider e2e reply")

      const hits = chatHits(server)
      expect(hits).toHaveLength(1)
      expect(hits[0]!.authorization).toBe("Bearer lmstudio")
      // The wire model id is the configured api id, not the catalog alias.
      expect(hits[0]!.body).toMatchObject({ model: "served-model-id", stream: true })
    }),
  )

  it.effect("refreshes the catalog when the Ollama model set changes", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const state = { models: [{ name: "alpha:latest" }, { name: "beta:latest" }] }
      const server = yield* serveOllama(state)
      yield* OllamaPlugin.effect(yield* host).pipe(
        Effect.provideService(
          Config.Service,
          configWith({ ollama: { api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${server.url}/v1` } } }),
        ),
      )
      const ids = Effect.map(catalog.model.available(), (models) => models.map((model) => model.id))
      expect(yield* ids).toEqual([ModelV2.ID.make("alpha:latest"), ModelV2.ID.make("beta:latest")])

      // Pull one model and delete another, then let the next discovery poll run.
      state.models = [{ name: "beta:latest" }, { name: "gamma:latest" }]
      yield* TestClock.adjust("10 seconds")
      yield* waitFor(
        Effect.map(catalog.model.get(ollama, ModelV2.ID.make("gamma:latest")), (model) =>
          model === undefined ? undefined : (true as const),
        ),
        "rediscovery never published gamma:latest",
      )

      expect(yield* ids).toEqual([ModelV2.ID.make("beta:latest"), ModelV2.ID.make("gamma:latest")])
    }),
  )

  it.effect("picks up an Ollama server that starts after boot", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const port = yield* Effect.promise(async () => {
        const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") })
        const port = probe.port
        probe.stop(true)
        return port
      })
      yield* OllamaPlugin.effect(yield* host).pipe(
        Effect.provideService(
          Config.Service,
          configWith({
            ollama: {
              api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `http://127.0.0.1:${port}/v1` },
            },
          }),
        ),
      )
      // The initial probe hit a closed port, so nothing is registered.
      expect(yield* catalog.provider.get(ollama)).toBeUndefined()

      const server = yield* serveOllama({ models: [{ name: "late:latest" }] }, { port })
      yield* TestClock.adjust("10 seconds")
      yield* waitFor(
        Effect.map(catalog.provider.get(ollama), (provider) => (provider === undefined ? undefined : provider)),
        "Ollama provider never registered after its server came up",
      )

      const { response } = yield* complete(ollama, ModelV2.ID.make("late:latest"), "say hi")
      expect(response.text).toBe("ollama e2e reply")
    }),
  )

  it.effect("drops the provider when the Ollama server stops answering", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const server = yield* serveOllama({ models: [{ name: "gone:latest" }] })
      yield* OllamaPlugin.effect(yield* host).pipe(
        Effect.provideService(
          Config.Service,
          configWith({ ollama: { api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${server.url}/v1` } } }),
        ),
      )
      expect(yield* catalog.model.get(ollama, ModelV2.ID.make("gone:latest"))).toBeDefined()

      // A server that was registered must not stay registered after it dies —
      // otherwise the picker offers models that cannot run.
      server.stop()
      yield* TestClock.adjust("10 seconds")
      yield* waitFor(
        Effect.map(catalog.provider.get(ollama), (provider) =>
          provider === undefined ? (true as const) : undefined,
        ),
        "Ollama provider stayed registered after its server stopped",
      )
      expect(yield* catalog.model.get(ollama, ModelV2.ID.make("gone:latest"))).toBeUndefined()
    }),
  )

  it.effect("drops the provider when the llama.cpp server stops answering", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const server = yield* serveLlamaCpp({ models: [{ id: "gone.gguf" }] })
      yield* LlamaCppPlugin.effect(yield* host).pipe(
        Effect.provideService(
          Config.Service,
          configWith({
            "llama-cpp": { api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${server.url}/v1` } },
          }),
        ),
      )
      expect(yield* catalog.provider.get(llamaCpp)).toBeDefined()

      server.stop()
      yield* TestClock.adjust("10 seconds")
      yield* waitFor(
        Effect.map(catalog.provider.get(llamaCpp), (provider) =>
          provider === undefined ? (true as const) : undefined,
        ),
        "llama.cpp provider stayed registered after its server stopped",
      )
      expect(yield* catalog.model.get(llamaCpp, ModelV2.ID.make("gone.gguf"))).toBeUndefined()
    }),
  )

  it.effect("does not follow redirects during discovery", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const target = yield* serveOllama({ models: [{ name: "redirected:latest" }] })
      const server = yield* listen((request, hit) =>
        request.method === "GET" && hit.path === "/api/tags"
          ? Response.redirect(`${target.url}/api/tags`, 302)
          : notFound(),
      )
      yield* OllamaPlugin.effect(yield* host).pipe(
        Effect.provideService(
          Config.Service,
          configWith({ ollama: { api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${server.url}/v1` } } }),
        ),
      )

      // The discovery probe sets redirect: "error" — a bounce to another host
      // must fail closed, never forward the request.
      expect(target.hits).toEqual([])
      expect(yield* catalog.provider.get(ollama)).toBeUndefined()
    }),
  )

  it.effect("does not register when a different service answers on the port", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const server = yield* listen(() =>
        new Response("<html><body>not a model server</body></html>", {
          headers: { "content-type": "text/html" },
        }),
      )
      yield* OllamaPlugin.effect(yield* host).pipe(
        Effect.provideService(
          Config.Service,
          configWith({ ollama: { api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${server.url}/v1` } } }),
        ),
      )
      expect(yield* catalog.provider.get(ollama)).toBeUndefined()
    }),
  )

  it.live("does not follow redirects when streaming a completion", () =>
    Effect.gen(function* () {
      const target = yield* listen(() => chatCompletion("redirected reply"))
      const server = yield* serveOllama({
        models: [{ name: "m:latest" }],
        chat: () => Response.redirect(`${target.url}/v1/chat/completions`, 302),
      })
      yield* OllamaPlugin.effect(yield* host).pipe(
        Effect.provideService(
          Config.Service,
          configWith({ ollama: { api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${server.url}/v1` } } }),
        ),
      )

      const catalog = yield* Catalog.Service
      const model = yield* catalog.model.get(ollama, ModelV2.ID.make("m:latest"))
      if (!model) return yield* Effect.die(new Error("model missing from catalog"))
      const resolved = yield* SessionRunnerModel.resolveWithRef(session(ollama, model.id), model)
      // The local-provider redirect guard is what keeps a bounce from forwarding
      // the request — and its prompt — to a host the user never configured.
      expect(resolved.model.route.defaults.http?.redirect).toBe("error")

      const llm = yield* LLMClient.Service
      const exit = yield* llm.generate(LLM.request({ model: resolved.model, prompt: "say hi" })).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(target.hits).toEqual([])
    }),
  )

  it.effect("maps a provider HTTP 400 to a non-retryable InvalidRequest error", () =>
    Effect.gen(function* () {
      const server = yield* serveOllama({
        models: [{ name: "m:latest" }],
        chat: () => Response.json({ error: { message: "model is not loaded" } }, { status: 400 }),
      })
      yield* OllamaPlugin.effect(yield* host).pipe(
        Effect.provideService(
          Config.Service,
          configWith({ ollama: { api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${server.url}/v1` } } }),
        ),
      )

      const catalog = yield* Catalog.Service
      const model = yield* catalog.model.get(ollama, ModelV2.ID.make("m:latest"))
      if (!model) return yield* Effect.die(new Error("model missing from catalog"))
      const resolved = yield* SessionRunnerModel.resolveWithRef(session(ollama, model.id), model)

      const llm = yield* LLMClient.Service
      const exit = yield* llm.generate(LLM.request({ model: resolved.model, prompt: "say hi" })).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const failure = Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined
      expect(failure).toBeInstanceOf(LLMError)
      if (failure instanceof LLMError) {
        expect(failure.reason._tag).toBe("InvalidRequest")
        expect(failure.message).toContain("400")
      }
      // A 4xx is not retryable — exactly one request must have hit the wire.
      expect(chatHits(server)).toHaveLength(1)
    }),
  )

  it.effect("replays a realistic llama.cpp transcript with timings and model metadata", () =>
    Effect.gen(function* () {
      const server = yield* serveLlamaCpp({
        models: [
          {
            id: "models/qwen3-8b.gguf",
            object: "model",
            created: 1_758_000_000,
            owned_by: "llamacpp",
            meta: { n_ctx_train: 40_960, vocab_type: 2 },
          },
        ],
        nCtx: 40_960,
        chat: () =>
          streamResponse(
            llamacppDelta("qwen3-8b", { role: "assistant", content: "" }) +
              llamacppDelta("qwen3-8b", { content: "The" }) +
              llamacppDelta("qwen3-8b", { content: " capital of France" }) +
              llamacppDelta("qwen3-8b", { content: " is Paris." }) +
              llamacppDelta("qwen3-8b", {}, "stop", {
                usage: { prompt_tokens: 21, completion_tokens: 7, total_tokens: 28 },
                timings: {
                  prompt_n: 21,
                  prompt_ms: 52.1,
                  predicted_n: 7,
                  predicted_ms: 168.4,
                  predicted_per_second: 41.5,
                },
              }) +
              DONE,
          ),
      })
      yield* LlamaCppPlugin.effect(yield* host).pipe(
        Effect.provideService(
          Config.Service,
          configWith({
            "llama-cpp": { api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${server.url}/v1` } },
          }),
        ),
      )

      const { response } = yield* complete(llamaCpp, ModelV2.ID.make("models/qwen3-8b.gguf"), "capital of France?")
      expect(response.finishReason).toBe("stop")
      expect(response.text).toBe("The capital of France is Paris.")
      expect(response.usage).toMatchObject({ inputTokens: 21, outputTokens: 7, totalTokens: 28 })
    }),
  )

  it.effect("streams a thinking model's reasoning before the answer", () =>
    Effect.gen(function* () {
      const server = yield* serveOllama({
        models: [{ name: "deepseek-r1:8b", model: "deepseek-r1:8b", modified_at: "2026-08-01T12:00:00Z", details: { family: "qwen3" } }],
        chat: () =>
          streamResponse(
            ollamaDelta("deepseek-r1:8b", { role: "assistant" }) +
              ollamaDelta("deepseek-r1:8b", { reasoning_content: "The user" }) +
              ollamaDelta("deepseek-r1:8b", { reasoning_content: " said hi." }) +
              ollamaDelta("deepseek-r1:8b", { content: "Hello" }) +
              ollamaDelta("deepseek-r1:8b", { content: "!" }) +
              ollamaDelta("deepseek-r1:8b", {}, "stop") +
              ollamaUsage("deepseek-r1:8b", {
                prompt_tokens: 9,
                completion_tokens: 12,
                total_tokens: 21,
                completion_tokens_details: { reasoning_tokens: 6 },
              }) +
              DONE,
          ),
      })
      yield* OllamaPlugin.effect(yield* host).pipe(
        Effect.provideService(
          Config.Service,
          configWith({ ollama: { api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${server.url}/v1` } } }),
        ),
      )

      const resolved = yield* resolve(ollama, ModelV2.ID.make("deepseek-r1:8b"))
      const llm = yield* LLMClient.Service
      const events = Array.from(yield* llm.stream(LLM.request({ model: resolved.model, prompt: "hi" })).pipe(Stream.runCollect))

      // Reasoning is a separate block that closes before the answer text opens.
      expect(events.map((event) => event.type)).toEqual([
        "step-start",
        "reasoning-start",
        "reasoning-delta",
        "reasoning-delta",
        "reasoning-end",
        "text-start",
        "text-delta",
        "text-delta",
        "text-end",
        "step-finish",
        "finish",
      ])
      const response = yield* llm.generate(LLM.request({ model: resolved.model, prompt: "hi" }))
      expect(response.reasoning).toBe("The user said hi.")
      expect(response.text).toBe("Hello!")
      expect(response.usage?.reasoningTokens).toBe(6)
    }),
  )

  it.effect("streams a tool call and answers with the tool result on the next turn", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const server = yield* serveOllama({
        models: [{ name: "qwen3:8b", model: "qwen3:8b" }],
        chat: (body) => {
          const messages = (body?.messages ?? []) as { role: string }[]
          // Second turn: the tool result is in history, so answer in text.
          if (messages.some((message) => message.role === "tool"))
            return streamResponse(
              ollamaDelta("qwen3:8b", { role: "assistant" }) +
                ollamaDelta("qwen3:8b", { content: "18°C in Paris." }) +
                ollamaDelta("qwen3:8b", {}, "stop") +
                DONE,
            )
          // First turn: a tool call whose JSON arguments arrive split across deltas.
          return streamResponse(
            ollamaDelta("qwen3:8b", { role: "assistant" }) +
              ollamaDelta("qwen3:8b", {
                tool_calls: [
                  { index: 0, id: "call_abc", type: "function", function: { name: "get_weather", arguments: "" } },
                ],
              }) +
              ollamaDelta("qwen3:8b", { tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] }) +
              ollamaDelta("qwen3:8b", { tool_calls: [{ index: 0, function: { arguments: 'ty":"Paris"}' } }] }) +
              ollamaDelta("qwen3:8b", {}, "tool_calls") +
              DONE,
          )
        },
      })
      yield* OllamaPlugin.effect(yield* host).pipe(
        Effect.provideService(
          Config.Service,
          configWith({ ollama: { api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${server.url}/v1` } } }),
        ),
      )

      const resolved = yield* resolve(ollama, ModelV2.ID.make("qwen3:8b"))
      const llm = yield* LLMClient.Service
      const tools = [
        {
          name: "get_weather",
          description: "Get the current weather for a city",
          inputSchema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
            additionalProperties: false,
          },
        },
      ]
      const first = yield* llm.generate(
        LLM.request({ model: resolved.model, prompt: "weather in Paris?", tools, toolChoice: "auto" }),
      )
      expect(first.finishReason).toBe("tool-calls")
      expect(first.toolCalls).toEqual([
        expect.objectContaining({ id: "call_abc", name: "get_weather", input: { city: "Paris" } }),
      ])

      // What went on the wire must be what a real server expects: a tools array
      // of function specs and tool_choice "auto".
      const firstHit = chatHits(server).at(-1)
      expect(firstHit?.body).toMatchObject({ tool_choice: "auto" })
      expect(firstHit?.body?.tools).toEqual([
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the current weather for a city",
            parameters: expect.objectContaining({ properties: { city: { type: "string" } } }),
          },
        },
      ])

      // Second turn: replay history plus the tool result, like the runner does.
      const followUp = yield* llm.generate(
        LLM.request({
          model: resolved.model,
          messages: [
            Message.user("weather in Paris?"),
            Message.assistant([ToolCallPart.make({ id: "call_abc", name: "get_weather", input: { city: "Paris" } })]),
            Message.tool({ id: "call_abc", name: "get_weather", result: { temp: 18, unit: "C" } }),
            Message.user("and tomorrow?"),
          ],
        }),
      )
      expect(followUp.text).toBe("18°C in Paris.")

      const secondHit = chatHits(server).at(-1)
      // The wire conversation must carry the assistant tool_calls entry and the
      // tool result keyed by the same call id — the shape real servers demand.
      expect(secondHit?.body?.messages).toEqual([
        { role: "user", content: "weather in Paris?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_abc", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
          ],
        },
        { role: "tool", tool_call_id: "call_abc", content: '{"temp":18,"unit":"C"}' },
        { role: "user", content: "and tomorrow?" },
      ])
      expect(yield* catalog.model.get(ollama, ModelV2.ID.make("qwen3:8b"))).toBeDefined()
    }),
  )

  it.effect("lowers the system prompt and generation options onto the wire", () =>
    Effect.gen(function* () {
      const server = yield* serveOllama({ models: [{ name: "qwen3:8b" }] })
      yield* OllamaPlugin.effect(yield* host).pipe(
        Effect.provideService(
          Config.Service,
          configWith({ ollama: { api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${server.url}/v1` } } }),
        ),
      )

      const resolved = yield* resolve(ollama, ModelV2.ID.make("qwen3:8b"))
      const llm = yield* LLMClient.Service
      yield* llm.generate(
        LLM.request({
          model: resolved.model,
          system: "You are terse.",
          prompt: "say hi",
          generation: { temperature: 0.2, topP: 0.9, maxTokens: 64, stop: ["\n\n"], seed: 42 },
        }),
      )

      const hit = chatHits(server).at(-1)
      expect(hit?.body).toMatchObject({
        temperature: 0.2,
        top_p: 0.9,
        max_tokens: 64,
        stop: ["\n\n"],
        seed: 42,
      })
      // The system prompt is a privileged first message, not a body field.
      expect(hit?.body?.messages).toEqual([
        { role: "system", content: "You are terse." },
        { role: "user", content: "say hi" },
      ])
    }),
  )

  it.effect("reports finish_reason length as a truncated answer", () =>
    Effect.gen(function* () {
      const server = yield* serveOllama({
        models: [{ name: "qwen3:8b" }],
        chat: () =>
          streamResponse(
            ollamaDelta("qwen3:8b", { role: "assistant" }) +
              ollamaDelta("qwen3:8b", { content: "cut off mid" }) +
              ollamaDelta("qwen3:8b", {}, "length") +
              DONE,
          ),
      })
      yield* OllamaPlugin.effect(yield* host).pipe(
        Effect.provideService(
          Config.Service,
          configWith({ ollama: { api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${server.url}/v1` } } }),
        ),
      )

      const { response } = yield* complete(ollama, ModelV2.ID.make("qwen3:8b"), "say hi")
      expect(response.finishReason).toBe("length")
      expect(response.text).toBe("cut off mid")
    }),
  )

  it.effect("fails when the provider drops the connection mid-stream", () =>
    Effect.gen(function* () {
      const server = yield* serveOllama({
        models: [{ name: "qwen3:8b" }],
        // The socket closes after a partial answer — no finish chunk, no [DONE].
        chat: () =>
          streamResponse(
            ollamaDelta("qwen3:8b", { role: "assistant" }) + ollamaDelta("qwen3:8b", { content: "partial" }),
          ),
      })
      yield* OllamaPlugin.effect(yield* host).pipe(
        Effect.provideService(
          Config.Service,
          configWith({ ollama: { api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${server.url}/v1` } } }),
        ),
      )

      const resolved = yield* resolve(ollama, ModelV2.ID.make("qwen3:8b"))
      const llm = yield* LLMClient.Service
      const exit = yield* llm.generate(LLM.request({ model: resolved.model, prompt: "say hi" })).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const failure = Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined
      expect(failure).toBeInstanceOf(LLMError)
      if (failure instanceof LLMError) {
        expect(failure.reason._tag).toBe("InvalidProviderOutput")
        expect(failure.message).toContain("finish")
      }
    }),
  )

  it.effect("fails when the provider emits a malformed SSE frame", () =>
    Effect.gen(function* () {
      const server = yield* serveOllama({
        models: [{ name: "qwen3:8b" }],
        chat: () =>
          streamResponse(
            ollamaDelta("qwen3:8b", { role: "assistant" }) + "data: {not json\n\n" + DONE,
          ),
      })
      yield* OllamaPlugin.effect(yield* host).pipe(
        Effect.provideService(
          Config.Service,
          configWith({ ollama: { api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${server.url}/v1` } } }),
        ),
      )

      const resolved = yield* resolve(ollama, ModelV2.ID.make("qwen3:8b"))
      const llm = yield* LLMClient.Service
      const exit = yield* llm.generate(LLM.request({ model: resolved.model, prompt: "say hi" })).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const failure = Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined
      expect(failure).toBeInstanceOf(LLMError)
      if (failure instanceof LLMError) expect(failure.reason._tag).toBe("InvalidProviderOutput")
    }),
  )

  it.live("retries a transient 503 and completes when the model finishes loading", () =>
    Effect.gen(function* () {
      // llama-server answers 503 while it loads weights, then serves. The
      // executor's real retry path (backoff, status mapping) must ride through.
      let calls = 0
      const server = yield* serveLlamaCpp({
        models: [{ id: "loading.gguf" }],
        chat: () => (++calls <= 2 ? Response.json({ error: "loading model" }, { status: 503 }) : chatCompletion("ready")),
      })
      yield* LlamaCppPlugin.effect(yield* host).pipe(
        Effect.provideService(
          Config.Service,
          configWith({
            "llama-cpp": { api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${server.url}/v1` } },
          }),
        ),
      )

      const { response } = yield* complete(llamaCpp, ModelV2.ID.make("loading.gguf"), "say hi")
      expect(response.text).toBe("ready")
      expect(chatHits(server)).toHaveLength(3)
    }),
  )

  it.live("maps a persistent 429 to RateLimit carrying the Retry-After hint", () =>
    Effect.gen(function* () {
      const server = yield* serveOllama({
        models: [{ name: "busy:latest" }],
        chat: () =>
          Response.json(
            { error: { message: "too many requests" } },
            { status: 429, headers: { "retry-after-ms": "1" } },
          ),
      })
      yield* OllamaPlugin.effect(yield* host).pipe(
        Effect.provideService(
          Config.Service,
          configWith({ ollama: { api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${server.url}/v1` } } }),
        ),
      )

      const resolved = yield* resolve(ollama, ModelV2.ID.make("busy:latest"))
      const llm = yield* LLMClient.Service
      const exit = yield* llm.generate(LLM.request({ model: resolved.model, prompt: "say hi" })).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const failure = Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined
      expect(failure).toBeInstanceOf(LLMError)
      if (failure instanceof LLMError) {
        expect(failure.reason._tag).toBe("RateLimit")
        expect(failure.retryable).toBe(true)
        expect(failure.retryAfterMs).toBe(1)
      }
      // MAX_RETRIES is 2 — the request hits the wire once plus two retries.
      expect(chatHits(server)).toHaveLength(3)
    }),
  )

  it.effect("registers Ollama as connected when the server runs with zero models", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const server = yield* serveOllama({ models: [] })
      yield* OllamaPlugin.effect(yield* host).pipe(
        Effect.provideService(
          Config.Service,
          configWith({ ollama: { api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${server.url}/v1` } } }),
        ),
      )

      // "Running, nothing pulled" is a real state — the provider shows as
      // connected so the UI can say so, but offers no models.
      expect(yield* catalog.provider.get(ollama)).toMatchObject({ name: "Ollama" })
      expect((yield* catalog.provider.available()).map((provider) => provider.id)).toContain(ollama)
      expect((yield* catalog.model.available()).filter((model) => model.providerID === ollama)).toEqual([])
    }),
  )

  it.effect("runs Ollama and llama.cpp side by side on different ports", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const ollamaServer = yield* serveOllama({ models: [{ name: "qwen3:8b" }] })
      const llamacppServer = yield* serveLlamaCpp({ models: [{ id: "local.gguf" }] })
      const config = configWith({
        ollama: { api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${ollamaServer.url}/v1` } },
        "llama-cpp": {
          api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${llamacppServer.url}/v1` },
        },
      })
      const pluginHost = yield* host
      yield* OllamaPlugin.effect(pluginHost).pipe(Effect.provideService(Config.Service, config))
      yield* LlamaCppPlugin.effect(pluginHost).pipe(Effect.provideService(Config.Service, config))

      expect((yield* catalog.provider.available()).map((provider) => provider.id)).toEqual(
        expect.arrayContaining([ollama, llamaCpp]),
      )

      const first = yield* complete(ollama, ModelV2.ID.make("qwen3:8b"), "hi")
      const second = yield* complete(llamaCpp, ModelV2.ID.make("local.gguf"), "hi")
      expect(first.response.text).toBe("ollama e2e reply")
      expect(second.response.text).toBe("llama.cpp e2e reply")
      // Each provider authenticated against its own server only.
      expect(chatHits(ollamaServer)[0]!.authorization).toBe("Bearer ollama")
      expect(chatHits(llamacppServer)[0]!.authorization).toBe("Bearer llamacpp")
    }),
  )

  it.effect("uses the default context when llama.cpp has no /props endpoint", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const server = yield* serveLlamaCpp({ models: [{ id: "local.gguf" }], props: false })
      yield* LlamaCppPlugin.effect(yield* host).pipe(
        Effect.provideService(
          Config.Service,
          configWith({
            "llama-cpp": { api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${server.url}/v1` } },
          }),
        ),
      )

      // Older llama-server builds lack /props — the model still registers on
      // the conservative default window rather than being dropped.
      expect(yield* catalog.model.get(llamaCpp, ModelV2.ID.make("local.gguf"))).toMatchObject({
        limit: { context: 32_768, output: 8_192 },
      })
    }),
  )

  it.effect("probes a real claude binary on PATH and disables the provider when it logs out", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const { bin, write } = yield* withPathBin("claude")
      // A real process spawn decides availability: `claude auth status --json`.
      write(`#!/bin/sh\nprintf '%s' '{"loggedIn":true,"subscriptionType":"max"}'\n`)
      yield* Effect.addFinalizer(() => Effect.sync(() => overrideProbe()))
      resetProbeCache()

      const pluginHost = yield* host
      yield* ClaudeCodePlugin.effect(pluginHost)

      const provider = yield* catalog.provider.get(ClaudeCodeCLI.ID)
      expect(provider?.disabled).toBe(false)
      expect(provider?.api).toMatchObject({ type: "native", url: "local://claude-code" })
      expect(provider?.request.body[ClaudeCodeCLI.EXECUTABLE_KEY]).toBe(bin)
      const model = yield* catalog.model.get(ClaudeCodeCLI.ID, ModelV2.ID.make("opus"))
      expect(model?.enabled).toBe(true)
      expect(SessionRunnerModel.selectable(model!)).toBe(true)

      // The user runs `claude auth logout` — the next probe must flip the
      // provider off rather than keep offering a dead model.
      write(`#!/bin/sh\nprintf '%s' '{"loggedIn":false}'\n`)
      resetProbeCache()
      yield* ClaudeCodePlugin.effect(pluginHost)
      expect((yield* catalog.provider.get(ClaudeCodeCLI.ID))?.disabled).toBe(true)
      expect((yield* catalog.provider.available()).map((item) => item.id)).not.toContain(ClaudeCodeCLI.ID)
    }),
  )

  it.effect("registers muse-code when a real muse binary is on PATH", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const { bin, write } = yield* withPathBin("muse")
      write(`#!/bin/sh\nexit 0\n`)
      yield* MuseCodePlugin.effect(yield* host)

      const provider = yield* catalog.provider.get(MuseCodeCLI.ID)
      expect(provider?.disabled).toBe(false)
      expect(provider?.api).toMatchObject({ type: "native", url: "local://muse-code" })
      expect(provider?.request.body[MuseCodeCLI.EXECUTABLE_KEY]).toBe(bin)
      const model = yield* catalog.model.get(MuseCodeCLI.ID, ModelV2.ID.make("muse-spark-1.3"))
      expect(model?.enabled).toBe(true)
      expect(SessionRunnerModel.selectable(model!)).toBe(true)
    }),
  )
})
