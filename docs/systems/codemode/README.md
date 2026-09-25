# CodeMode

CodeMode executes a bounded JavaScript program against only the schema-described tools a host supplies. It can sequence, branch, and parallelize calls while the host retains authentication, approval, and durable-side-effect policy. The program receives no ambient filesystem, process, network, module, or application authority.

The workspace package supports one-shot execution with `CodeMode.execute({ tools, code })` and a reusable runtime with `CodeMode.make({ tools, limits })`.

- [API and result contract](./api.md): tool definitions, execution options, results, hooks, and OpenAPI adaptation.
- [Tool discovery](./discovery.md): budgeted catalog entries and runtime search.
- [Language, limits, and diagnostics](./execution.md): supported programs, resource controls, and failure data.

## Quick start

Define tools with Effect Schema, then place them in the object tree exposed to programs as `tools`:

```ts
import { CodeMode, Tool } from "@turenlabs/codemode"
import { Effect, Schema } from "effect"

const lookupOrder = Tool.make({
  description: "Look up an order by ID",
  input: Schema.Struct({ id: Schema.String }),
  output: Schema.Struct({ id: Schema.String, status: Schema.String }),
  run: ({ id }) => Effect.succeed({ id, status: "open" }),
})

const runtime = CodeMode.make({
  tools: {
    orders: {
      lookup: lookupOrder,
    },
  },
})

const result =
  yield *
  runtime.execute(`
  const order = await tools.orders.lookup({ id: "order_42" })
  return { id: order.id, needsAttention: order.status !== "complete" }
`)
```

`result` is always a `CodeMode.Result`. Program, validation, limit, and tool failures are returned as diagnostics rather than failing the Effect. Host interruption remains interruption.

Successful result values are JSON-safe data. A program that returns `undefined`, including by reaching the end without `return`, produces `null`; nested `undefined` values are normalized to `null` as well.

## Authority boundary

CodeMode confines programs to the supplied tool tree, but it does not decide what those tools may do.

The host owns:

- Authentication and authorization.
- Tool selection and immutable scope.
- Credentials and network clients.
- Persistence, idempotency, approval, and durable side effects.
- Logging and redaction policy.

CodeMode owns:

- Parsing and interpreting the supported subset without `eval`.
- Schema boundaries around tool calls.
- Plain-data copying and blocked prototype members.
- Resource limits, call accounting, and normalized diagnostics.
- Model-facing tool discovery and instructions.

A program cannot gain authority through prose or generated code. It can only exercise authority already present in the supplied tools. Do not expose a broad tool and expect the prompt to restrict it.

## Non-goals

- Generic permission prompts or approval workflows.
- Durable pause/resume, replay, or storage adapters.
- Exactly-once external side effects.
- Application authorization or product policy.
- A filesystem or process sandbox for arbitrary JavaScript.
- Compatibility with the full JavaScript language or npm ecosystem.

Applications that need approval or durable consequences should model those above CodeMode and expose only the currently authorized tools.

## Source

- [`packages/codemode/src/codemode.ts`](../../../packages/codemode/src/codemode.ts)
- [`packages/codemode/src/tool-runtime.ts`](../../../packages/codemode/src/tool-runtime.ts)
- [`packages/codemode/README.md`](../../../packages/codemode/README.md)
