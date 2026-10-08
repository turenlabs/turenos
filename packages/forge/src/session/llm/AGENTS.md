# Session LLM runtime

`../llm.ts` is the TurenOS session LLM service. It owns session concerns (auth, config, model and provider resolution, plugins, permissions, telemetry headers, and runtime selection) and is the only file in this area that should know the full session request shape. This folder holds the adapters behind it:

- `ai-sdk.ts` converts AI SDK `fullStream` parts into `@turenlabs/llm` `LLMEvent`s. This is the default runtime path.
- `native-request.ts` converts the normalized session input into a native `@turenlabs/llm` `LLMRequest`. It does not execute requests.
- `native-runtime.ts` is the opt-in native runtime adapter. It decides whether a selected model is supported, builds the native request, bridges session tools into native executable tools, and delegates transport to `LLMClient` / `RequestExecutor`.
- `claude-code-direct.ts` is the always-on path for Claude Code and Muse Code models. It lowers the request with `native-request.ts`, routes it to the CLI bridge through `LLMClient`, and dispatches CLI tool calls with `ToolRuntime.dispatch` over a private MCP namespace.

The three runtimes are described in the "Legacy Forge session processor" section of `docs/systems/model-provider-layer/README.md`; its diagram covers Session V2 only.

## Seams

- `../llm.ts` imports `LLMClient` from `@turenlabs/llm/route` and passes it to the native and CLI-direct paths; the AI SDK path never calls it.
- `../llm.ts` selects `LLMClaudeCodeDirect` from `./llm/claude-code-direct` before any other runtime when the provider is Claude Code or Muse Code; those models reject connection policies.
- `../llm.ts` imports `LLMAISDK` from `./llm/ai-sdk`; the AI SDK path still calls `streamText(...)` locally, then adapts `result.fullStream` into shared `LLMEvent`s.
- `../llm.ts` imports `LLMNativeRuntime` from `./llm/native-runtime`; this is the runtime-selection seam. Unsupported native requests return a reason and fall back to AI SDK.
- `native-runtime.ts` imports `LLMNative` from `./native-request`; this keeps request lowering separate from transport and tool execution.
- `native-request.ts` is the only adapter file that should construct `LLM.request(...)`, `LLM.model(...)`, `Message.*`, `SystemPart`, `ToolCallPart`, `ToolResultPart`, or `ToolDefinition` values from `@turenlabs/llm`.
- `ai-sdk.ts` and `native-runtime.ts` both emit `@turenlabs/llm` `LLMEvent`s so downstream session processing does not care which runtime handled the request.

Keep new integration code on one of these seams. Avoid importing session services into `native-request.ts`; pass normalized data through `RequestInput` instead.

## Safety boundary

- AI SDK remains the default. Native is not a global replacement: `../llm.ts` tries it only when `FORGE_EXPERIMENTAL_NATIVE_LLM=true` and the request has no connection policy. The umbrella `FORGE_EXPERIMENTAL` does not enable it.
- Native execution supports the `openai` and `anthropic` providers when their catalog entry uses `@ai-sdk/openai`, `@ai-sdk/openai-compatible`, or `@ai-sdk/anthropic` and an API key is configured. OAuth is native only for OpenAI with a provider fetch override. Everything else returns an unsupported reason and falls back to AI SDK.
- Tool execution stays session-owned on both paths; only request lowering and transport differ.
