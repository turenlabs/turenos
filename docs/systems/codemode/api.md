# CodeMode API

CodeMode exposes schema-described host tools to bounded JavaScript programs. [CodeMode](./README.md) explains the authority boundary; [execution](./execution.md) describes limits and diagnostics.

## API

### `Tool.make`

```ts
const tool = Tool.make({
  description,
  input, // Effect Schema (validating) or JSON Schema (render-only)
  output, // optional; same choice
  run,
})
```

This is CodeMode's own `Tool.make` from `@turenlabs/codemode`. Core's built-in tools use a different `Tool.make` (`input`, `output`, `execute`), and `@turenlabs/llm` has another (`parameters`, `success`, `execute`); import from the package you are building for.

`input` and `output` each accept a validating Effect Schema or a render-only JSON Schema document (the natural shape for adapter-provided tools whose schemas arrive as JSON Schema, e.g. MCP definitions). Effect Schema input is decoded before `run` is invoked, and `run` returns the encoded representation of an Effect Schema `output`, which CodeMode decodes and copies before exposing it to the program. JSON Schemas only shape the model-visible signature; values pass through unvalidated (they still cross the plain-data boundary).

`output` is optional. Without it the tool's signature advertises `Promise<unknown>` and the host result is exposed as-is.

The description and schemas are part of the model-visible tool contract. Keep descriptions concrete and put authorization in `run` or in the service it calls.

Public tool types are grouped under the same namespace: `Tool.Definition`, `Tool.Options`, `Tool.SchemaType`, and `Tool.JsonSchema`.

### `CodeMode.execute`

Use `CodeMode.execute` for a single execution:

```ts
const result =
  yield *
  CodeMode.execute({
    tools: { orders: { lookup: lookupOrder } },
    code: `return await tools.orders.lookup({ id: "order_42" })`,
    limits: { maxToolCalls: 10 },
    onToolCallStart: (call) => Effect.logDebug("CodeMode tool started", call),
    onToolCallEnd: (call) => Effect.logDebug("CodeMode tool settled", call),
  })
```

The Effect environment is inferred from the supplied tools. CodeMode does not erase service requirements introduced by tool implementations.

### `CodeMode.make`

Use `CodeMode.make` when the tool set and execution policy are reused:

```ts
const runtime = CodeMode.make({
  tools: { orders: { lookup: lookupOrder } },
  limits: { timeoutMs: 30_000 },
})

runtime.catalog() // structured tool descriptions
runtime.instructions() // model-facing syntax and tool guide
runtime.execute(source) // CodeMode.Result
```

`CodeMode.Input`, `CodeMode.Result`, `CodeMode.Success`, `CodeMode.Failure`, `CodeMode.Diagnostic`, and `CodeMode.DiagnosticKind` are both Effect schemas and their inferred TypeScript types. Hosts can combine `CodeMode.Input` and `CodeMode.Result` with `runtime.instructions()` and `runtime.execute()` when constructing a framework-specific agent tool.

All other CodeMode types use the same namespace: `CodeMode.Options`, `CodeMode.ExecuteOptions`, `CodeMode.Runtime`, `CodeMode.ExecutionLimits`, `CodeMode.DiscoveryOptions`, `CodeMode.DataValue`, `CodeMode.ToolDescription`, and the `CodeMode.ToolCall*` observation types.

### Results

```ts
type Result = Success | Failure

interface Success {
  readonly ok: true
  readonly value: CodeMode.DataValue
  readonly logs?: ReadonlyArray<string>
  readonly truncated?: boolean
  readonly toolCalls: ReadonlyArray<CodeMode.ToolCall>
}

interface Failure {
  readonly ok: false
  readonly error: CodeMode.Diagnostic
  readonly logs?: ReadonlyArray<string>
  readonly truncated?: boolean
  readonly toolCalls: ReadonlyArray<CodeMode.ToolCall>
}
```

`toolCalls` contains the names of calls admitted by the runtime in call order. It is retained on failure so hosts can audit partial execution without exposing inputs or host failures. `truncated` is present when the value or logs were cut to fit `maxOutputBytes` (see [execution limits](./execution.md#execution-limits)).

### Tool-call hooks

`onToolCallStart` receives `{ index, name, input }` after input decoding and before tool execution. The input is decoded host-side data and may include values produced by schema transformations; applications should avoid logging sensitive tool arguments indiscriminately.

`onToolCallEnd` receives `{ index, name, input, durationMs, outcome, message? }` when an admitted call settles. `outcome` is `"success"` or `"failure"`; `message` is the model-safe failure message and is present only on failure. Interrupted calls (for example when the execution timeout fires) do not produce an end event. Both hooks are Effect-returning and must not fail.

### OpenAPI tools

`OpenAPI.fromSpec` turns an OpenAPI 3.x document into a tool subtree - one tool per operation. Dotted `operationId` values form namespaces such as `v2.session.get`. Missing IDs receive a flat method/path fallback such as `getUsersById`; names are sanitized and deduplicated. The host places the subtree under a key in its `tools` tree; that key is the model-visible namespace.

```ts
import { CodeMode, OpenAPI } from "@turenlabs/codemode"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"

const api = OpenAPI.fromSpec({
  spec: await Bun.file("openapi.json").json(), // parsed document (no YAML)
  auth: {
    resolve: ({ name, scopes, operation }) =>
      name === "BearerAuth" ? Effect.succeed({ type: "bearer", token }) : Effect.succeed(undefined),
  },
})

const runtime = CodeMode.make({ tools: { turenos: api.tools } })
const result = await Effect.runPromise(runtime.execute(code).pipe(Effect.provide(FetchHttpClient.layer)))
```

`fromSpec` is synchronous and returns `{ tools, skipped }`. The initial adapter supports query `form`/`deepObject`, path/header `simple`, JSON request bodies, JSON responses, and text responses; unsupported parameter encodings, non-JSON request bodies, binary responses, and streaming operations land in `skipped` instead of producing broken tools. Operation and path servers take precedence over document servers unless `baseUrl` explicitly overrides all of them. Tool inputs flatten path, query, header, and closed object-body fields into one model-facing object while retaining their HTTP locations internally. Cross-location name collisions receive a location prefix such as `path_id` and `query_id`; composed, nullable, dictionary, conditionally-required, and non-object JSON bodies remain under `body`. Auth is never model-visible. Responses are limited to 50 MiB, and non-2xx responses become safe tool failures carrying the status and a size-capped body summary. Deferred capabilities are tracked in [`packages/codemode/src/openapi/TODO.md`](../../../packages/codemode/src/openapi/TODO.md).

Supported bearer, basic, header, and query authentication follows OpenAPI `security` semantics and is resolved host-side via `auth.resolve` - credential storage, OAuth flows, and token refresh never enter the compiler. Cookie authentication alternatives are discarded; an operation is skipped when it has no supported alternative. See the option docstrings in [`packages/codemode/src/openapi/types.ts`](../../../packages/codemode/src/openapi/types.ts) for the full semantics. Generated tools require `HttpClient.HttpClient` (from `effect/unstable/http`) in the Effect environment - provide `FetchHttpClient.layer` or a custom/test client layer at execution. The supplied client owns redirect policy; credentialed hosts should reject redirects or strip credentials when the origin changes.

## Laws

The public contract is guided by these equivalences:

- `CodeMode.execute({ ...options, code })` is equivalent to `CodeMode.make(options).execute(code)`.
- A tool implementation is not invoked unless its input has decoded successfully.
- A tool result is not visible to the program unless its output has decoded and crossed the plain-data boundary successfully.
- Unknown host failures do not become model-visible diagnostics; `ToolError` is the explicit safe-message channel.
- Host interruption remains interruption rather than a `CodeMode.Failure`.

## Source

- [`packages/codemode/src/codemode.ts`](../../../packages/codemode/src/codemode.ts)
- [`packages/codemode/src/tool.ts`](../../../packages/codemode/src/tool.ts)
- [`packages/codemode/src/openapi/index.ts`](../../../packages/codemode/src/openapi/index.ts)
