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

const program = Effect.gen(function* () {
  const result = yield* runtime.execute(`
    const order = await tools.orders.lookup({ id: "order_42" })
    return { id: order.id, needsAttention: order.status !== "complete" }
  `)
  return result
})
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

## In TurenOS

The legacy session runtime (`packages/forge`) exposes CodeMode to agents as a tool named `execute`. It is on by
default: `FORGE_EXPERIMENTAL_CODE_MODE` falls back to the umbrella `FORGE_EXPERIMENTAL`, which defaults to `true` in
`RuntimeFlags`. Set `FORGE_EXPERIMENTAL_CODE_MODE=false` (or `FORGE_EXPERIMENTAL=false`) to turn it off. The tool's tree
contains the connected MCP tools the agent and session permissions allow, grouped by server, and while CodeMode is on
those MCP tools are not offered to the model directly. Each run is limited to 120 seconds, 32 tool calls, and 256 KiB of
output, and the tool result is then bounded to 2,000 lines or 50 KiB like other tool output. Session V2 does not
register it.

Each nested MCP call:

- Runs the `tool.execute.before` and `tool.execute.after` plugin hooks and a permission `ask` for the MCP tool.
- Has its result truncated to 2,000 lines or 50 KiB before it enters the program; a truncated result becomes
  `{ truncated, preview, outputPath }`.
- Has image and PDF content collected host-side as attachments on the outer result, up to 32 files and 10 MiB in total.

## Source

- [`packages/codemode/src/codemode.ts`](../../../packages/codemode/src/codemode.ts)
- [`packages/codemode/src/tool-runtime.ts`](../../../packages/codemode/src/tool-runtime.ts)
- [`packages/forge/src/tool/code-mode.ts`](../../../packages/forge/src/tool/code-mode.ts)
- [`packages/forge/src/tool/registry.ts`](../../../packages/forge/src/tool/registry.ts)
- [`packages/forge/src/effect/runtime-flags.ts`](../../../packages/forge/src/effect/runtime-flags.ts)
