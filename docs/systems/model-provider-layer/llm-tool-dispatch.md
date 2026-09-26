# LLM tool dispatch

How `@turenlabs/llm` represents tool loops, runs one local tool call with typed dispatch, and passes hosted provider tools
through untouched.

## Tool loops

Tool loops are represented in common messages and events:

```ts
const call = ToolCallPart.make({ id: "call_1", name: "lookup", input: { query: "weather" } })
const result = Message.tool({ id: "call_1", name: "lookup", result: { forecast: "sunny" } })

const followUp = LLM.request({
  model,
  messages: [Message.user("Weather?"), Message.assistant([call]), result],
})
```

Routes lower these into provider-native assistant tool-call messages and tool-result messages. Streaming providers should emit `tool-input-delta` events while arguments arrive, then a final `tool-call` event with parsed input.

## Dispatch

`LLM.stream(request)` and `LLM.generate(request)` each run exactly one provider turn. Add tool schemas to `request.tools` with `Tool.toDefinitions(tools)`. When a caller wants the package's typed one-call execution behavior, pass each canonical local `tool-call` event to `ToolRuntime.dispatch(tools, call)`.

```ts
const get_weather = Tool.make({
  description: "Get current weather for a city",
  parameters: Schema.Struct({ city: Schema.String }),
  success: Schema.Struct({ temperature: Schema.Number, condition: Schema.String }),
  execute: ({ city }) =>
    Effect.gen(function* () {
      // city: string  — typed from parameters Schema
      const data = yield* WeatherApi.fetch(city)
      return { temperature: data.temp, condition: data.cond }
      // return type checked against success Schema
    }),
})

const tools = { get_weather, get_time, ... }
const events = yield* LLM.stream(
  LLM.updateRequest(request, { tools: Tool.toDefinitions(tools) }),
).pipe(Stream.runCollect)

const call = Array.from(events).find(LLMEvent.is.toolCall)
if (call && !call.providerExecuted) {
  const dispatched = yield* ToolRuntime.dispatch(tools, call)
  // Persist call + dispatched.result, then construct the next request explicitly.
}
```

The dispatcher:

- On `tool-call`: looks up the named tool, decodes input against `parameters` Schema, dispatches to the typed `execute`, encodes the result against `success` Schema, and returns canonical `tool-result` events.
- Does not stream providers, construct Session events, schedule fibers, append history, count steps, or continue model rounds.
- Leaves persistence and continuation to the enclosing product flow.

Handler dependencies (services, permissions, plugin hooks, abort handling) are closed over by the consumer at tool-construction time. Build the tools record inside an `Effect.gen` once and reuse it across many dispatches.

Errors must be expressed as `ToolFailure`. The runtime catches it and emits a `tool-error` event, then a `tool-result` of `type: "error"`, so the model can self-correct on the next step. `dispatch` has no error channel, so anything that is not a `ToolFailure` is a defect that propagates to the caller of `dispatch`. These recoverable paths produce `tool-error` events:

- The model called an unknown tool name.
- The named tool has no `execute` handler.
- Input failed the `parameters` Schema.
- The handler returned a `ToolFailure`.
- The handler's return value failed the `success` Schema.
- The tool's projected output is itself an error result.

Provider-defined / hosted tools (Anthropic `web_search` / `code_execution` / `web_fetch`, OpenAI Responses output items `web_search_call` / `web_search_preview_call` / `file_search_call` / `code_interpreter_call` / `mcp_call` / `local_shell_call` / `image_generation_call` / `computer_call`) pass through the runtime untouched:

- Routes surface the model's call as a `tool-call` event with `providerExecuted: true`, and the provider's result as a matching `tool-result` event with `providerExecuted: true`.
- Callers detect `providerExecuted` on `tool-call` and **skip local dispatch** — no handler is invoked and no `tool-error` is raised for "unknown tool". The provider already executed it.
- Callers that continue should retain both events in explicit history when the protocol requires it. Anthropic encodes them back as `server_tool_use` + `web_search_tool_result` (or `code_execution_tool_result` / `web_fetch_tool_result`) blocks; OpenAI Responses callers typically use `previous_response_id` instead of resending hosted-tool items.

Routes do not yet lower provider-defined tool definitions: both the Anthropic Messages and OpenAI Responses routes send every `request.tools` entry as a custom function tool (`lowerTool` in `packages/llm/src/protocols/`). Hosted-tool calls and results are parsed when a provider returns them, as described above, but a caller cannot request a hosted tool through `request.tools` today.
