# Model and provider layer

TurenOS turns a session's model request into a provider stream through one of two runtimes: the AI SDK path (the default) or the native `@turenlabs/llm` runtime (opt-in). Both converge on the same `LLMEvent` stream consumed by the session processor, so downstream processing doesn't care which one handled a request. The choice is made per request, so one session can route some calls natively and fall back for others.

## Runtime selection

Both runtimes converge on the same `LLMEvent` stream consumed by the session processor. The gate is per-request: a single session can route some calls through native and fall back for others.

```txt
                             ╭───────────────────╮
╭───────────────────────────▶│ session processor │
│                            ╰─────────┬─────────╯
│                                      │
│                                      │
│                                      │
│                                      ▼
│                         ╭─────────────────────────╮
│                         │ LLM.Service (../llm.ts) │
│                         ╰────────────┬────────────╯
│                                      │
│                                      │
│                                      │
│                                      ▼
│                                ╭───────────╮
│                              ╭─╯           ╰─╮
│                              │  native gate  │
│                              ╰─╮           ╭─╯
│                                ╰─────┬─────╯
│                                      │
│                     ╭────── no ──────┴─────── yes ────────╮
│                     │                                     │
│                     ▼                                     ▼
│       ╭───────────────────────────╮             ╭───────────────────╮
│       │          AI SDK           │             │ native-runtime.ts │
│       │ streamText / generateText │             ╰────────┬──────────╯
│       ╰─────────────┬─────────────╯                      │
│                     │                                    │
│                 ╭───╯                                    │
│                 │                                        │
│                 ▼                                        ▼
│     ╭───────────────────────╮             ╭────────────────────────────╮
│     │       ai-sdk.ts       │             │     native-request.ts      │
│     │ fullStream → LLMEvent │             │ session input → LLMRequest │
│     ╰──────────┬────────────╯             ╰──────────────┬─────────────╯
│                │                                         │
│                │                                     ╭───╯
│                │                                     │
│                ▼                                     ▼
│       ╭─────────────────╮             ╭─────────────────────────────╮
╰───────┤ LLMEvent stream │◀────────────┤ LLMClient · RequestExecutor │
        ╰─────────────────╯             ╰─────────────────────────────╯
```

`native-runtime.ts` evaluates the gate. For a supported request it lowers the session input into an `LLMRequest` and hands transport to `LLMClient`; otherwise it returns an unsupported reason and `llm.ts` takes the AI SDK path. Tool execution stays session-owned on both paths.

## Configuration

- `FORGE_EXPERIMENTAL_NATIVE_LLM=true` opts in to the native runtime (default off). The umbrella `FORGE_EXPERIMENTAL` does not enable it, and requests with a connection policy always use AI SDK.
- Native execution supports the `openai` and `anthropic` providers when their catalog entry uses `@ai-sdk/openai`, `@ai-sdk/openai-compatible`, or `@ai-sdk/anthropic` and an API key is configured. OAuth runs natively only for OpenAI with a provider fetch override.

## Limits

- Unsupported providers, other OAuth setups, and missing API keys fall back to AI SDK instead of failing.
- The `@turenlabs/llm` package's own design (routes, protocols, provider facades, tool dispatch) is documented in [LLM package architecture](./llm-package.md) and [LLM tool dispatch](./llm-tool-dispatch.md).

## Source

- [`packages/forge/src/session/llm.ts`](../../../packages/forge/src/session/llm.ts)
- [`packages/forge/src/session/llm/native-runtime.ts`](../../../packages/forge/src/session/llm/native-runtime.ts)
- [`packages/forge/src/session/llm/native-request.ts`](../../../packages/forge/src/session/llm/native-request.ts)
- [`packages/forge/src/session/llm/ai-sdk.ts`](../../../packages/forge/src/session/llm/ai-sdk.ts)
- [`packages/forge/src/effect/runtime-flags.ts`](../../../packages/forge/src/effect/runtime-flags.ts)
