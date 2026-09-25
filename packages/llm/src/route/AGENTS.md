# Routes

A route is the registered, runnable composition of four orthogonal pieces:

- **`Protocol`** (`src/route/protocol.ts`) — semantic API contract. Owns request body construction (`body.from`), the body schema (`body.schema`), the streaming-event schema (`stream.event`), and the event-to-`LLMEvent` state machine (`stream.step`). `Route.make(...)` validates and JSON-encodes the body from `body.schema` and decodes frames with `stream.event`. Examples: `OpenAIChat.protocol`, `OpenAIResponses.protocol`, `AnthropicMessages.protocol`, `Gemini.protocol`, `BedrockConverse.protocol`.
- **`Endpoint`** (`src/route/endpoint.ts`) — URL construction. The host, path, and route query live on the endpoint. `Endpoint.path("/chat/completions", { baseURL })` is the common case; pass a function for paths that embed the model id or a body field (e.g. `Endpoint.path(({ body }) => `/model/${body.modelId}/converse-stream`)`).
- **`Auth`** (`src/route/auth.ts`) — per-request transport authentication. Provider facades configure credentials onto the route before model selection, usually via `Auth.bearer(apiKey)` or `Auth.header(name, apiKey)`. Routes that need per-request signing (Bedrock SigV4, future Vertex IAM, Azure AAD) implement `Auth` as a function that signs the body and merges signed headers into the result.
- **`Framing`** (`src/route/framing.ts`) — bytes → frames. SSE (`Framing.sse`) is shared; Bedrock keeps its AWS event-stream framing as a typed `Framing<object>` value alongside its protocol.

Compose them via `Route.make(...)`:

```ts
export const route = Route.make({
  id: "openai-chat",
  provider: "openai",
  protocol: OpenAIChat.protocol,
  endpoint: Endpoint.path("/chat/completions", {
    baseURL: "https://api.openai.com/v1",
  }),
  auth: Auth.bearer(),
  framing: Framing.sse,
})
```

Route defaults are request-shaping defaults such as `headers`, `limits`, `generation`, `providerOptions`, and `http`. Endpoint host/query belongs on the route endpoint. Selected `Model` values carry only model id, provider id, and the configured route value. Model capability/catalog metadata lives outside this package; protocol support is enforced by request lowering and typed `LLMError`s.

The four-axis decomposition is the reason DeepSeek, TogetherAI, Cerebras, Baseten, Fireworks, and DeepInfra all reuse `OpenAIChat.protocol` verbatim — each provider deployment is a 5-15 line `Route.make(...)` call instead of a 300-400 line route clone. Bug fixes in one protocol propagate to every consumer of that protocol in a single commit.

When a provider ships a non-HTTP transport (OpenAI's WebSocket Responses backend, hypothetical bidirectional streaming APIs), the seam is `Transport` — `WebSocketTransport.jsonTransport.with(...)` constructs an IO template whose `prepare` receives the route endpoint/auth at compile time, builds a WebSocket URL and message, and whose `frames` yields decoded text from the socket. Same protocol and endpoint source, different transport.

## URL construction

`Endpoint` owns `{ baseURL, path, query }`. Each protocol route includes a canonical endpoint when the provider has one (e.g. `https://api.openai.com/v1`); provider helpers override endpoint fields by configuring the route before selecting a model. Routes that have no canonical URL (OpenAI-compatible Chat, GitHub Copilot) require configuration before execution.

For providers where the URL is derived from typed inputs (Azure resource name, Bedrock region), the provider helper configures the route endpoint before calling `.model(...)`. Use `AtLeastOne<T>` from `route/auth-options.ts` for inputs that accept either of two derivation paths (Azure: `resourceName` or `baseURL`).
