# LLM package architecture

`@turenlabs/llm` (`packages/llm`) is an Effect Schema-first LLM core. The Schema classes in `packages/llm/src/schema/` are the canonical runtime data model. Convenience functions in `packages/llm/src/llm.ts` are thin constructors that return those same Schema class instances; they should improve callsites without creating a second model.

In-repo Session V2 integration:

- `packages/core/src/session/runner/model.ts` resolves catalog models to native,
  AI SDK bridge, or local CLI routes.
- `packages/core/src/session/runner/llm.ts` builds each `LLMRequest`, calls
  `LLMClient.stream` for one provider turn, and owns persistence, tools, and
  continuation.

The legacy Forge session processor has a separate integration:

- `packages/forge/src/session/llm.ts` decides whether a legacy request uses AI SDK or this package's opt-in native route runtime.
- `packages/forge/src/session/llm/native-request.ts` is the lowering adapter from opencode's session/AI SDK-shaped data into this package's `LLMRequest` model.
- `packages/forge/src/session/llm/native-runtime.ts` is the execution adapter that calls raw `LLMClient.stream(request)` and bridges one provider turn of opencode tool calls through this package's typed dispatcher.
- `packages/forge/src/session/llm/ai-sdk.ts` keeps the default AI SDK path compatible by converting AI SDK stream parts into this package's shared `LLMEvent`s.

## Request flow

The intended callsite is:

```ts
const request = LLM.request({
  model: OpenAI.configure({ apiKey }).responses("gpt-4o-mini"),
  system: "You are concise.",
  prompt: "Say hello.",
})

const response = yield * LLMClient.generate(request)
```

`LLM.request(...)` builds an `LLMRequest`. `LLMClient.generate(...)` reads the executable route carried by `request.model.route`, builds the provider-native body, asks the route's transport for a real `HttpClientRequest.HttpClientRequest`, sends it through `RequestExecutor.Service`, parses the provider stream into common `LLMEvent`s, and finally returns an `LLMResponse`.

Use `LLMClient.stream(request)` when callers want incremental `LLMEvent`s. Use `LLMClient.generate(request)` when callers want those same events collected into an `LLMResponse`. Use `LLMClient.prepare<Body>(request)` to compile a request through the route pipeline without sending it — the optional `Body` type argument narrows `.body` to the route's native shape (e.g. `prepare<OpenAIChatBody>(...)` returns a `PreparedRequestOf<OpenAIChatBody>`). The runtime body is identical; the generic is a type-level assertion.

Filter or narrow `LLMEvent` streams with `LLMEvent.is.*` (camelCase guards, e.g. `events.filter(LLMEvent.is.toolCall)`). The kebab-case `LLMEvent.guards["tool-call"]` form also works but prefer `is.*` in new code.

## Folder layout

```
packages/llm/src/
  schema/                   canonical Schema model, split by concern
    ids.ts                  branded IDs, literal types, ProviderMetadata
    options.ts              Generation/Provider/Http options, Limits, Model, cache policy
    messages.ts             content parts, Message, ToolDefinition, LLMRequest
    events.ts               Usage, individual events, LLMEvent, PreparedRequest, LLMResponse
    errors.ts               error reasons, LLMError, ToolFailure
    index.ts                barrel
  llm.ts                    request constructors and convenience helpers
  route/
    index.ts                @turenlabs/llm/route advanced barrel
    client.ts               Route.make + LLMClient.prepare/stream/generate
    executor.ts             RequestExecutor service + transport error mapping
    protocol.ts             Protocol type + Protocol.make
    endpoint.ts             Endpoint type + Endpoint.path
    auth.ts                 Auth type + Auth.bearer / Auth.apiKeyHeader / Auth.passthrough
    auth-options.ts         ProviderAuthOption shape, AuthOptions.bearer, AtLeastOne helper
    framing.ts              Framing type + Framing.sse
    transport/              transport implementations
      index.ts              Transport type + HttpTransport / WebSocketTransport namespaces
      http.ts               HttpTransport.httpJson — POST + framing
      websocket.ts          WebSocketTransport.json + WebSocketExecutor service
  protocols/
    shared.ts               ProviderShared toolkit used inside protocol impls
    openai-chat.ts          protocol + route (compose OpenAIChat.protocol)
    openai-responses.ts
    anthropic-messages.ts
    gemini.ts
    bedrock-converse.ts
    bedrock-event-stream.ts framing for AWS event-stream binary frames
    openai-compatible-chat.ts route that reuses OpenAIChat.protocol, no canonical URL
    utils/                  per-protocol helpers (auth, cache, media, tool-stream, ...)
  providers/
    openai-compatible.ts    generic compatible helper + family model helpers
    openai-compatible-profile.ts family defaults (deepseek, togetherai, ...)
    azure.ts / amazon-bedrock.ts / cloudflare.ts / github-copilot.ts / google.ts / xai.ts / openai.ts / anthropic.ts / openrouter.ts
  tool.ts                   typed Tool.make() helper and Tool.toDefinitions()
  tool-runtime.ts           narrow one-call typed tool dispatcher
```

The dependency arrow points down: `providers/*.ts` files import protocol routes and auth-option utilities; protocol modules import `endpoint`, `auth`, `framing`, and transport pieces. Protocols do not import provider facades. Lower-level modules know nothing about provider catalog metadata.

Tool loops and dispatch are covered in [LLM tool dispatch](./llm-tool-dispatch.md).
