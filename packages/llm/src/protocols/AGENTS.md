# Protocol modules

Protocol files should look self-similar. Provider quirks belong behind named helpers so a new route can be reviewed by comparing the same sections across files.

## Section order

Use this order for every protocol module:

1. Public model input
2. Request body schema
3. Streaming event schema
4. Parser state
5. Request body construction (`fromRequest`)
6. Stream parsing (`step` and per-event handlers)
7. Protocol and route
8. Protocol route export

## Rules

- Keep protocol files focused on the protocol. Move provider-specific projection, signing, media normalization, or other bulky transformations into `src/protocols/utils/*`.
- Use `Effect.fn("Provider.fromRequest")` for request body construction entrypoints. Use `Effect.fn(...)` for event handlers that yield effects; keep purely synchronous handlers as plain functions returning a `StepResult` that the dispatcher lifts via `Effect.succeed(...)`.
- Parser state owns terminal information. The state machine records finish reason, usage, and pending tool calls; emit one terminal `finish` event (or `provider-error`) for each completed response. If a provider splits reason and usage across events, merge them in parser state before flushing.
- Emit exactly one terminal `finish` event for a completed response, normally after a matching `step-finish`. Use `stream.terminal` to stop reading when the provider has a completion sentinel; use `stream.onHalt` when the final event must be flushed after the framed stream ends.
- Use shared helpers for repeated protocol policy such as text joining, usage totals, JSON parsing, and tool-call accumulation. `ToolStream` (`protocols/utils/tool-stream.ts`) accumulates streamed tool-call arguments uniformly.
- Make intentional provider differences explicit in helper names or comments. If two protocol files differ visually, the reason should be obvious from the names.
- Prefer dispatched per-event handlers (`onMessageStart`, `onContentBlockDelta`, ...) called from a small top-level `step` switch over a long if-chain. The dispatcher keeps the event surface visible at a glance.
- Keep tests in the same conceptual order as the protocol: basic prepare, tools prepare, unsupported lowering, text/usage parsing, tool streaming, finish reasons, provider errors.

## Review checklist

- Can the file be skimmed side-by-side with `openai-chat.ts` without hunting for equivalent sections?
- Are provider quirks named, isolated, and covered by focused tests?
- Does request body construction validate unsupported common content at the protocol boundary?
- Does stream parsing emit stable common events without leaking provider event order to callers?
- Does `toolChoice: "none"` behavior read as intentional?

## Shared protocol helpers

`ProviderShared` exports a small toolkit used inside protocol implementations to keep them focused on provider-native shapes:

- `joinText(parts)` — joins an array of `TextPart` (or anything with a `.text`) with newlines. Use this anywhere a protocol flattens text content into a single string for a provider field.
- `parseToolInput(route, name, raw)` — Schema-decodes a tool-call argument string with the canonical "Invalid JSON input for `<route>` tool call `<name>`" error message. Treats empty input as `{}`.
- `parseJson(route, raw, message)` — generic JSON-via-Schema decode for non-tool bodies.
- `eventError(route, message, ...)` — typed `InvalidProviderOutput` constructor for stream-time decode failures.
- `validateWith(decoder)` — maps Schema decode errors to `InvalidRequest`. `Route.make(...)` uses this for body validation; lower-level routes can reuse it.
- `matchToolChoice(provider, choice, branches)` — branches over `LLMRequest["toolChoice"]` for provider-specific lowering.

If you find yourself copying a 3-to-5-line snippet between two protocols, lift it into `ProviderShared` next to these helpers rather than duplicating.

## Lowering

`LLMRequest.system` is the initial privileged prompt that applies ahead of the conversation. `Message.system(...)` is a separate, provider-neutral chronological operator update inside `LLMRequest.messages`; it applies only from its position in history onward and accepts text content only.

Native chronological system messages are route/model-specific. Anthropic Messages lowers them natively for Claude Opus 4.8 (`claude-opus-4-8`). Other routes and models intentionally lower the update in place into ordinary user-compatible text using this stable escaped representation:

```text
<system-update>
...
</system-update>
```

Routes lower tool-call and tool-result messages into provider-native shapes. Streaming providers should emit `tool-input-delta` events while arguments arrive, then a final `tool-call` event with parsed input.

Hosted (provider-defined) tools: surface the model's call and the provider's result as `tool-call` and `tool-result` events with `providerExecuted: true`, and when adding hosted-tool definitions, lower them into the provider-native shape (no route does yet; `lowerTool` sends every `request.tools` entry as a function tool). Which hosted tool results each route parses, and how callers continue after them, is in `docs/systems/model-provider-layer/llm-tool-dispatch.md`.
