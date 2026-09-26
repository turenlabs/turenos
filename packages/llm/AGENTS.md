# LLM package

Rules for `packages/llm`, an Effect Schema-first LLM core. Follow the nested files when working in those folders: `src/route/AGENTS.md` (routes, endpoints, auth, framing), `src/providers/AGENTS.md` (provider facades), `src/protocols/AGENTS.md` (protocol modules), and `test/AGENTS.md` (recorded tests). Walkthroughs of the request flow, folder layout, and tool dispatch are in `docs/systems/model-provider-layer/llm-package.md` and `docs/systems/model-provider-layer/llm-tool-dispatch.md`.

## Effect

- Prefer `HttpClient.HttpClient` / `HttpClientResponse.HttpClientResponse` over web `fetch` / `Response` at package boundaries.
- Use `Stream.Stream` for streaming data flow. Avoid ad hoc async generators or manual web reader loops unless an Effect `Stream` API cannot model the behavior.
- Use Effect Schema codecs for JSON encode/decode (`Schema.fromJsonString(...)`) instead of direct `JSON.parse` / `JSON.stringify` in implementation code.
- In `Effect.gen`, yield yieldable errors directly (`return yield* new MyError(...)`) instead of `Effect.fail(new MyError(...))`.
- Use `Effect.void` instead of `Effect.succeed(undefined)` when the successful value is intentionally void.

## Conventions

Per-type constructors live on the type, not as top-level re-exports. Use `Message.system(...)`, `Message.user(...)`, `Message.assistant(...)`, `Message.tool(...)`, `Model.make(...)`, `ToolDefinition.make(...)`, `ToolCallPart.make(...)`, `ToolResultPart.make(...)`, `ToolChoice.make(...)`, `ToolChoice.named(...)`, `SystemPart.make(...)`, and `GenerationOptions.make(...)` directly. The top-level `LLM` namespace is reserved for request-shaped call APIs: `LLM.request`, `LLM.generate`, `LLM.stream`, `LLM.updateRequest`, and `LLM.generateObject`. Two ways to construct the same thing is one too many.

## Tests

- Use `testEffect(...)` from `test/lib/effect.ts` for tests requiring Effect layers.
- Keep provider tests fixture-first. Live provider calls must stay behind `RECORD=true` and required API-key checks.

## Boundaries

- This package is an Effect Schema-first LLM core. The Schema classes in `src/schema/` are the canonical runtime data model. Convenience functions in `src/llm.ts` are thin constructors that return those same Schema class instances; they should improve callsites without creating a second model.
- Keep this package independent of session concerns. Session auth, permissions, plugins, telemetry headers, and runtime selection belong in `packages/forge/src/session/llm.ts` and its local adapters.
- The dependency arrow points down: `providers/*.ts` files import protocol routes and auth-option utilities; protocol modules import `endpoint`, `auth`, `framing`, and transport pieces. Protocols do not import provider facades. Lower-level modules know nothing about provider catalog metadata.
- The wrapped-user fallback preserves ordering while visibly lowering authority. Never silently pass a raw chronological `role: "system"` through a route that might reject it. Do not insert raw retrieved documents, tool output, or web content into privileged chronological system updates; keep untrusted content in ordinary user/tool channels.

## Tool dispatch

- `LLM.stream(request)` and `LLM.generate(request)` each run exactly one provider turn. `ToolRuntime.dispatch(tools, call)` executes one local `tool-call`; it does not stream providers, construct Session events, schedule fibers, append history, count steps, or continue model rounds. Persistence and continuation belong to the enclosing product flow.
- Express handler errors as `ToolFailure`. The runtime turns it into a `tool-error` event plus an error `tool-result` so the model can self-correct; anything else is a defect that fails the stream.
- Skip local dispatch for `tool-call` events with `providerExecuted: true`: the provider already ran that hosted tool.
- Close handler dependencies (services, permissions, plugin hooks, abort handling) over at tool-construction time, and build the tools record once inside an `Effect.gen` for reuse.
