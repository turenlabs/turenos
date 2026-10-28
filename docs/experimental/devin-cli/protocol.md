# Devin ACP protocol findings

Status: adopted, as of 2026-10-28.

The initialize-only probe measured ACP version 1 on 2026-10-27. These are the original protocol findings, not the current runtime qualification results.

The [Devin CLI provider](../../providers/devin-cli.md) documents the implemented transport and its authenticated tests.

Return to the [research decision](./README.md) or continue with the [implementation plan](./implementation.md).

## Measured handshake

The test launched `devin acp` from the research worktree. It sent this request:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientCapabilities": {},
    "clientInfo": { "name": "turenos-research", "version": "0.0.0" }
  }
}
```

The response advertised:

| Field                                       | Observed value                         | Integration consequence                                     |
| ------------------------------------------- | -------------------------------------- | ----------------------------------------------------------- |
| `protocolVersion`                           | `1`                                    | ACP v1 was negotiated                                       |
| `agentInfo.name`                            | `affogato`                             | Do not require the internal name to equal `devin`           |
| `agentInfo.title`                           | `Devin Agent`                          | Suitable display label                                      |
| `agentInfo.version`                         | `0.0.0-dev`                            | Use `devin --version` for build qualification               |
| `loadSession`                               | `true`                                 | `session/load` can be attempted after authenticated testing |
| `promptCapabilities.image`                  | `true`                                 | Images can be negotiated                                    |
| `promptCapabilities.audio`                  | `false`                                | Do not send audio blocks                                    |
| `promptCapabilities.embeddedContext`        | `true`                                 | Embedded resources can be negotiated                        |
| `mcpCapabilities.http`                      | `true`                                 | A private HTTP MCP bridge is a candidate                    |
| `mcpCapabilities.sse`                       | `true`                                 | Legacy SSE is available; prefer HTTP                        |
| `sessionCapabilities.list`                  | `{}`                                   | Session discovery is advertised                             |
| `sessionCapabilities.delete`                | `{}`                                   | Deletion is advertised; require explicit user action        |
| `sessionCapabilities.additionalDirectories` | `{}`                                   | Multi-root input is advertised                              |
| `sessionCapabilities.close`                 | Present                                | Session close is advertised                                 |
| `sessionCapabilities.resume`                | Absent                                 | Do not call `session/resume`                                |
| `authMethods`                               | `devin-browser`, "Log in with browser" | A browser flow is advertised                                |

The response also advertised private `cognition.ai/*` extensions. These include `midTurnPrompts`, `persistOnCreate`, `documentLifecycle`, `userEdits`, and `terminalLifecycle`. Their presence does not specify request fields, acknowledgments, replay rules, or safe use.

The probe did not send `authenticate`, `session/new`, `session/load`, or `session/prompt`. It did not inspect credential contents. Devin may read its own saved login during startup; the probe does not establish that no credential file was accessed internally.

### Reproduce

Run from the worktree root:

```sh
bun mockups/devin-cli/probe.ts
```

For a non-default executable:

```sh
bun mockups/devin-cli/probe.ts /absolute/path/to/devin
```

The probe checks the executable version, then sends one initialization request. It limits initialization output to 1 MiB. Version checking has a 10-second timeout; initialization has a 15-second process deadline. It suppresses stderr and prints authentication method names, not credentials.

This is a diagnostic script, not the production transport or a test of descendant-process cancellation.

## Required protocol flow

ACP uses newline-delimited UTF-8 JSON-RPC. Standard output must contain protocol messages only. Standard error is a separate diagnostic stream.

```text
TurenOS ACP client                         Devin ACP agent
       | -- launch devin acp ------------------> |
       | -- initialize ------------------------> |
       | <- capabilities and auth methods ------ |
       | -- authenticate, if required ----------> |
       | -- session/new or session/load --------> |
       | <- session ID and configuration ------- |
       | -- session/prompt ---------------------> |
       | <- session/update, repeated ------------ |
       | <- session/request_permission ---------- |
       | -- selected option or cancelled -------> |
       | <- prompt result with stopReason ------- |
       | -- session/cancel, when interrupted ---> |
```

Cancellation can occur while a prompt is active, not only after its result. Client handlers must remain available while awaiting a prompt response. A line parser that waits for a final response before handling incoming requests can deadlock.

The [TypeScript SDK](https://agentclientprotocol.com/libraries/typescript) implements both ACP roles. TurenOS already pins `@agentclientprotocol/sdk` version `0.21.0` in [Forge](../../../packages/forge/package.json#L61). Core does not inherit that dependency contract. Declare the dependency in the package that owns the client.

Current SDK documentation prefers the fluent `client()` API over deprecated `ClientSideConnection`. Verify the chosen API against the pinned SDK. Reuse its codec and dispatch rather than writing a second production JSON-RPC stack.

## Session and history ownership

Devin and TurenOS use different session IDs. Persist their association before sending a prompt that could cause side effects. Bind it to backend, Location, canonical working directory, and execution mode.

Start with one supervised process per active external session. Do not multiplex sessions until authentication, configuration, event routing, and cancellation isolation pass tests.

For follow-up messages, send only newly admitted input to the same Devin session. Do not resend the full TurenOS transcript into an already populated Devin session.

After a process restart, `session/load` is the advertised recovery path. It replays conversation updates before its response. Mark that interval as replay and avoid appending duplicate history or executing replayed tools. A missing message ID is not permission to deduplicate by matching text.

The current handshake does not advertise replay-free `session/resume`. CLI `devin -r` support does not imply that ACP method exists.

ACP does not provide TurenOS prompt-ID idempotency or a distributed side-effect transaction. A disconnect after prompt submission leaves delivery uncertain. Preserve the admitted input and require explicit reconciliation; do not automatically resend a possibly executed prompt.

If a saved Devin session is missing, stop with a clear recovery choice. Silently starting another session can repeat shell commands or lose context.

## Streaming and event mapping

These are proposed mappings, not implemented behavior:

| ACP input                        | TurenOS treatment                                                          |
| -------------------------------- | -------------------------------------------------------------------------- |
| `agent_message_chunk`            | Append assistant text; preserve message boundaries when IDs are available  |
| `agent_thought_chunk`            | Append supported reasoning content without inventing unavailable reasoning |
| `tool_call`                      | Record externally executed tool activity, not a new host execution request |
| `tool_call_update`               | Patch the same tool card and settle its reported result or failure         |
| Diff content and locations       | Show changes and file locations; do not apply reported edits a second time |
| `plan`                           | Show Devin's plan separately from TurenOS-owned todo state                 |
| `available_commands_update`      | Populate supported session commands from the agent                         |
| Mode and config updates          | Update session controls after capability validation                        |
| `usage_update`                   | Preserve provider-reported units, currency, and cumulative semantics       |
| `session/request_permission`     | Ask through the host UI; reply with an advertised option ID                |
| Prompt `stopReason`              | Record completion, limit, refusal, or cancellation distinctly              |
| Unsupported content or extension | Report the limit or preserve safe metadata; never infer authority          |

Core can already distinguish provider-executed tools in [the runner](../../../packages/core/src/session/runner/llm.ts#L1568) and [event publisher](../../../packages/core/src/session/runner/publish-llm-event.ts#L571). This distinction prevents double execution. It does not authorize the external operation or prove durable pre-execution settlement.

MCP calls executed by TurenOS already create host tool events. Correlate their ACP reports instead of creating duplicate cards or usage records. If safe correlation is unavailable, show the external report separately with its origin.

ACP permits permission requests; it does not require every tool to request permission. Automatic permissions, native reads, hooks, and configured MCP tools can execute without a host permission callback.

## Steering, cancellation, and limits

Preserve TurenOS durable admission before forwarding input. In the first implementation, promote queued input and steers at the next safe ACP prompt boundary.

Do not claim mid-turn steering parity from `cognition.ai/midTurnPrompts`. Qualify its request and acknowledgment contract before promoting a durable input as consumed. The existing Claude Code implementation depends on explicit confirmation, not a successful stdin write.

On interruption, send `session/cancel`. Resolve pending permission requests with the ACP `cancelled` outcome. Await the active prompt's terminal response for a bounded interval. Then close the session when supported and terminate the owned process group if necessary.

Reject late updates from replaced ownership. Qualify whether Devin background shells and subagents survive cancellation or process termination. A protocol cancellation notification alone does not prove they stopped.

Bound line size, total output, retained tool data, stderr, initialization, shutdown, and request concurrency. Use separate deadlines for a quiet working agent and an unresponsive transport.

## Command and documentation drift

Installed `devin acp --help` exposes `--model`, `--agent-type`, `--refusal-fallback`, and `--cloud`. The fetched command-reference ACP section lists only the first two.

The installed help describes `--cloud` as a stdio-to-cloud-WebSocket relay. This proves an available flag, not a tested cloud connection. `--model` and `--agent-type` are ignored for that relay, according to its help.

The [stable changelog](https://docs.devin.ai/cli/changelog/stable) provides useful version anchors:

- `3000.11.1` added ACP session model, effort, and speed configuration. It also fixed client MCP connections during new and loaded sessions.
- `3000.11.92` fixed ACP configuration leakage across repositories and added session-directory controls.
- `3000.11.205` added opt-in fail-closed hooks and improved steering. It removed `/loop` and `agent.model_mixture` despite stale marketing references.
- `3000.11.228` is the installed stable build, released 2026-10-26.

Discover models and configuration from the authenticated agent instead of freezing a marketing model list. Do not enable refusal fallback, cloud handoff, or extra model calls implicitly.

## Source

- [ACP initialization](https://agentclientprotocol.com/protocol/initialization), [transports](https://agentclientprotocol.com/protocol/transports), and [session setup](https://agentclientprotocol.com/protocol/session-setup).
- [ACP prompt turns](https://agentclientprotocol.com/protocol/prompt-turn), [tool calls](https://agentclientprotocol.com/protocol/tool-calls), and [TypeScript SDK](https://agentclientprotocol.com/libraries/typescript).
- [Devin command reference](https://docs.devin.ai/cli/reference/commands) and [stable changelog](https://docs.devin.ai/cli/changelog/stable).
- [Initialize-only probe](../../../mockups/devin-cli/probe.ts), [Core session input](../../../packages/core/src/session/input.ts), and [existing steering handle](../../../packages/core/src/session/runner/claude-code-mcp.ts#L34).
