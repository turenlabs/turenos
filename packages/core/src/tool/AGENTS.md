# Core Tool Architecture

This folder owns Core's one local tool representation, process and Location registration, effective lookup, and settlement.

## Representations

- `tool.ts` defines the opaque canonical `Tool.make({ description, input, output, execute, toModelOutput })` value. Application tools and shipped built-ins use the same type.
- `application-tools.ts` stores process-scoped application registrations.
- `tools.ts` exposes the registration-only `Tools.Service` view used by Location producers.
- `registry.ts` stores only canonical tools, overlays Location registrations over application registrations, derives definitions, invokes tools, and applies generic output bounding.

Do not add a second executable entry type, registry-owned executor, authorization callback, output-path callback, or legacy normalization path.

## Construction

Tool schemas and projection use `input` and `output` terminology. A tool value is opaque: its codecs, executor, definition derivation, and catalog permission declaration are private runtime details.

Location-scoped built-in layers acquire `PermissionV2.Service` and every other required Location service while the layer is constructed. The executor captures those services. Permission sources are always constructed from the canonical invocation context:

```ts
const source = {
  type: "tool" as const,
  messageID: context.assistantMessageID,
  callID: context.toolCallID,
}
```

Leaves own resolution, permission, and side-effect ordering. Translate only expected typed errors into `ToolFailure`; do not use `catchCause`, because interruption and defects must survive.

## Registration

Built-ins register through `Tools.Service.register({ [name]: tool })`. Application tools register through `ApplicationTools.Service.register(...)`, exposed publicly as `opencode.tools.register(...)`.

`mcp.ts` registers MCP-hosted tools the same way, one scoped generation at a time, re-registering when a server's listing changes. It is built but **not yet wired into a served graph** — see `specs/v2/session.md` for why the trigger has to be demand-driven rather than Location boot. It owns only the translation — server listing to canonical tool, `tools/call` result to model output. The MCP client, its child processes and its OAuth state stay behind `McpTool.Source`, which is a **global** node: `buildLocationServiceMap` builds Location-scoped layers under `Layer.fresh`, so a Location-scoped source would construct one MCP service, and therefore one child process per configured server, per open directory. The Location scope is passed as an explicit `directory` argument instead.

Both are scoped:

- The latest active same-placement registration wins.
- Closing any registration removes only that registration and reveals the next active one.
- Location registrations take precedence over application registrations.
- An invocation captures the effective tool once settlement starts.

`ApplicationTools.Service` is process-scoped and shared by all Locations. `ToolRegistry.Service` is Location-scoped. Do not make the registry process-global or construct a separate application-tool service for each Location.

## Permissions

The registry has no `PermissionV2.Service` dependency and performs no execution authorization. An internal built-in-only operation attaches a permission action solely to preserve whole-tool definition filtering; it is not part of public `Tool.make`. Most tools default to their registered name; `edit`, `write`, and `apply_patch` declare the shared `edit` action.

Definition filtering is catalog visibility, not execution authorization. A call still executes the captured leaf policy if it reaches settlement.

## Output

Built-ins return complete validated domain output. `ToolRegistry.Materialization.settle` is the only execution and generic model-output bounding boundary and owns managed retention paths.

Producer capture limits are separate. For example, Bash keeps `AppProcess.maxOutputBytes` and accurately reports stdout/stderr capture loss, but it does not run model-output truncation or return a managed `outputPath`.

## Current Gaps

- Plugin boot has not been redesigned to register canonical tools through `Tools.Service`; do not redesign it as part of leaf migrations. V1 additionally discovers user-authored tools by globbing `{tool,tools}/*.{js,ts}` and dynamically importing them; V2 has no equivalent.
- Tool definitions carry no plugin transform. V1 fires `tool.definition` per definition; the V2 analogue would be `registry.ts` `materialize`, but V1's contract is in-place mutation of a loosely typed bag. Needs a contract, not a port. No plugin implements it today.

## Execution Interceptors

`interceptor.ts` owns `tool.execute.before`/`.after`. It is a Location-scoped registration store, not a hook bus: `ToolRegistry.settleRegistration` runs it because the registry owns the one boundary where a call resolves, the same way `AISDK` runs its own hooks at provider construction. There is no `trigger` and nothing outside `registry.ts` calls it.

- `before` sees the **raw** provider arguments, before the input schema decodes them. It may deny (terminal; the call never executes and the reason becomes the tool error) or replace the arguments (composes in registration order; the replacement is re-decoded through the tool's own schema, so an invalid one fails the call rather than reaching `execute`).
- `after` sees the settled result after execution, encoding and bounding. It is read-only except for `notes`, which append advisory text to the model-visible output. Notes are dropped for denied and failed calls.
- An interceptor that throws, dies, or exceeds its phase budget has no opinion and the call proceeds. Interruption still propagates.
- Both phases run for every call that reaches a real registration, including subagent calls, which share the parent's Location. They do not run for unknown or stale tool names, because nothing executes there.
- MCP tool registration is built and tested but not enabled; it needs a demand-driven trigger before it can be wired into a served graph.
- The public Session result shape currently exposes managed `outputPaths`; full storage encapsulation requires a future opaque managed-output reference design.
