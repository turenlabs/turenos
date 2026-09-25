# Model and provider layer

Core Session V2 resolves a catalog model to an `@turenlabs/llm` route and streams
one provider turn through `LLMClient`. The legacy Forge session processor has a
separate AI SDK default with an experimental native adapter; that flag does not
select the V2 runtime.

## Session V2

`SessionRunnerModel.resolve` selects an available model, applies provider
credentials and request settings, and returns a model with an executable route.
The route can be a native protocol, an AI SDK bridge for a supported catalog
entry, or a local CLI bridge. `SessionRunner` constructs a canonical
`LLMRequest`, calls `llm.stream(wireRequest)` for each provider turn, persists
the resulting events, then owns tool execution and continuation. Provider
streaming does not delegate to the legacy Forge prompt loop.

```txt
Catalog + credentials → SessionRunnerModel.resolve → Model route
SessionRunner → LLMRequest → LLMClient.stream → LLMEvent stream
                                     ↓
                    SessionRunner persists and settles tools
```

See [LLM package architecture](./llm-package.md) for route construction and
[LLM tool dispatch](./llm-tool-dispatch.md) for the package's one-turn contract.

## Legacy Forge session processor

`packages/forge/src/session/llm.ts` uses AI SDK by default. With
`FORGE_EXPERIMENTAL_NATIVE_LLM=true`, each eligible request is lowered into an
`LLMRequest` and streamed through `LLMClient`; unsupported requests fall back
to AI SDK. Both paths produce `LLMEvent`s for the legacy session processor.
Tool execution remains session-owned.

The native adapter supports `openai` and `anthropic` catalog entries using
`@ai-sdk/openai`, `@ai-sdk/openai-compatible`, or `@ai-sdk/anthropic` when an API
key is configured. OpenAI OAuth also works with a provider fetch override.
Other OAuth setups, missing API keys, unsupported providers, and requests with
a connection policy use AI SDK. The umbrella `FORGE_EXPERIMENTAL` flag does not
enable this adapter.

## Source

- [`packages/core/src/session/runner/llm.ts`](../../../packages/core/src/session/runner/llm.ts)
- [`packages/core/src/session/runner/model.ts`](../../../packages/core/src/session/runner/model.ts)
- [`packages/core/src/session/runner/aisdk-bridge.ts`](../../../packages/core/src/session/runner/aisdk-bridge.ts)
- [`packages/forge/src/session/llm.ts`](../../../packages/forge/src/session/llm.ts)
- [`packages/forge/src/session/llm/native-runtime.ts`](../../../packages/forge/src/session/llm/native-runtime.ts)
- [`packages/forge/src/effect/runtime-flags.ts`](../../../packages/forge/src/effect/runtime-flags.ts)
