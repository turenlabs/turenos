# Model and provider layer

Core Session V2 resolves a catalog model to an `@turenlabs/llm` route and streams
one provider turn through `LLMClient`. The legacy Forge session processor has a
separate runtime selection: a CLI-direct path for Claude Code and Muse Code
models, an AI SDK default, and an experimental native adapter. The native flag
does not select the V2 runtime.

## Model catalog

Both runtimes read the model catalog from [models.dev](https://models.dev)
through `ModelsDev.Service` (`packages/core/src/models-dev.ts`), which contacts
that external service.

- The catalog is `<source>/api.json`, where the source is `FORGE_MODELS_URL` or
  `https://models.dev`. It is cached as `models.json` in the TurenOS cache
  directory, or `models-<hash>.json` for a custom source.
- When the service starts, it refreshes the cache unless the file is less than
  5 minutes old, then refreshes again every 60 minutes. Each fetch times out
  after 10 seconds and retries transient failures twice; a cross-process lock
  keeps concurrent processes from racing on the cache file.
- Reads use `FORGE_MODELS_PATH` when set, otherwise the cache file, then a
  snapshot bundled into the build. `FORGE_MODELS_PATH` does not stop the
  fetches: they still run and write the cache file, which is then never read. A failed fetch keeps the cached or last
  good catalog rather than emptying it.
- `FORGE_DISABLE_MODELS_FETCH` turns off both the startup and hourly fetches;
  with no cache or snapshot the catalog is empty. It does not stop a forced
  refresh: `forge models --refresh` and `forge auth login` call `refresh(true)`,
  which fetches regardless of the flag.

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

`packages/forge/src/session/llm.ts` picks one of three runtimes per request:

1. **CLI direct.** Claude Code and Muse Code models always go through
   `LLMClaudeCodeDirect.stream` (`packages/forge/src/session/llm/claude-code-direct.ts`).
   It lowers the request to an `LLMRequest` routed to the local CLI bridge,
   exposes session tools to the CLI through a private MCP namespace, and
   dispatches their calls with `ToolRuntime.dispatch`. These models reject a
   connection policy.
2. **Native.** When enabled, the native adapter lowers each eligible request
   into an `LLMRequest` and streams it through `LLMClient`; unsupported
   requests fall back to AI SDK.
3. **AI SDK.** The default for every other model.

All three produce `LLMEvent`s for the legacy session processor. Tool execution
remains session-owned. The CLIs themselves are covered in
[Claude Code](../../providers/claude-code/README.md) and
[Muse Code](../../providers/muse-code.md).

## Configuration

`FORGE_EXPERIMENTAL_NATIVE_LLM=true` enables the legacy native adapter. It is
off by default, and the umbrella `FORGE_EXPERIMENTAL` flag does not enable it.

## Limits

The native adapter supports `openai` and `anthropic` catalog entries using
`@ai-sdk/openai`, `@ai-sdk/openai-compatible`, or `@ai-sdk/anthropic` when an API
key is configured. OpenAI OAuth also works with a provider fetch override.
Other OAuth setups, missing API keys, unsupported providers, and requests with
a connection policy use AI SDK.

## Source

- [`packages/core/src/session/runner/llm.ts`](../../../packages/core/src/session/runner/llm.ts)
- [`packages/core/src/session/runner/model.ts`](../../../packages/core/src/session/runner/model.ts)
- [`packages/core/src/session/runner/aisdk-bridge.ts`](../../../packages/core/src/session/runner/aisdk-bridge.ts)
- [`packages/forge/src/session/llm.ts`](../../../packages/forge/src/session/llm.ts)
- [`packages/forge/src/session/llm/claude-code-direct.ts`](../../../packages/forge/src/session/llm/claude-code-direct.ts)
- [`packages/forge/src/session/llm/native-runtime.ts`](../../../packages/forge/src/session/llm/native-runtime.ts)
- [`packages/forge/src/session/llm/native-request.ts`](../../../packages/forge/src/session/llm/native-request.ts)
- [`packages/forge/src/effect/runtime-flags.ts`](../../../packages/forge/src/effect/runtime-flags.ts)
- [`packages/core/src/models-dev.ts`](../../../packages/core/src/models-dev.ts)
- Contracts: [`specs/v2/provider-model.md`](../../../specs/v2/provider-model.md),
  [`specs/v2/provider-policy.md`](../../../specs/v2/provider-policy.md)
