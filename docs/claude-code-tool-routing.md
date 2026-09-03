# Claude Code Tool Routing

TurenOS runs the Claude Code subscription provider through `claude -p`. Because that CLI is a separate process, allowing
it to execute native tools would bypass TurenOS's permissions, interceptors, durable tool lifecycle, output storage, and
turn-specific tool policy. TurenOS instead treats the current provider turn's `ToolRegistry.Materialization` as a
capability and exposes it to Claude through a private MCP server.

```text
Session runner
  |
  +-- materialize policy-filtered TurenOS tools
  +-- register an opaque turn capability
  +-- start an authenticated 127.0.0.1 MCP endpoint
  |
  `-- claude -p
        |
        +-- built-in tools disabled
        +-- ambient settings and MCP servers disabled
        `-- mcp__forge__* -> captured ToolRegistry settlement
                              |
                              +-- permissions and interceptors
                              +-- durable tool events and outputs
                              `-- model-visible result and annotations
```

The MCP server does not implement tools independently and does not rematerialize the registry. It calls the exact
materialization whose definitions were advertised for that provider turn. This preserves session overlays,
registration-generation checks, agent permissions, interceptor ordering, canonical `ToolOutput`, and managed output
paths.

## CLI Isolation

TurenOS launches Claude Code with these controls:

- `--tools ""` disables every native Claude tool. This is the availability boundary.
- `--strict-mcp-config` prevents MCP servers from ambient configuration from loading.
- `--setting-sources ""` prevents user, project, and local settings, including hooks and alternate provider routing,
  from loading.
- `--settings <private-file>` supplies only TurenOS's bounded `PostToolBatch` workflow reminder on tool-enabled V2 turns;
  it contains no command hook and is removed with the turn scope.
- `--mcp-config <private-file>` supplies only the turn-scoped TurenOS server.
- `--permission-mode dontAsk` makes non-approved requests fail closed in print mode.
- `--allowedTools "mcp__forge__*"` preapproves the private server's tools. This flag controls approval, not tool
  availability.
- `--no-session-persistence` leaves durable conversation ownership with TurenOS.
- On tool-enabled primary turns, TurenOS appends a compact CLI-specific workflow that prioritizes broad discovery,
  parallel independent tool calls, targeted reads, and early bounded delegation when subagent tools are advertised.
  Tool-less and auxiliary turns omit it. This compensates for the bridge's inability to steer Claude Code's internal
  agent loop without changing tool availability or concurrency.

The subprocess environment also removes ambient Anthropic credentials and alternate Claude provider-routing variables.
It preserves proxy configuration for provider traffic while adding `localhost`, `127.0.0.1`, and `::1` to `NO_PROXY`
so the private MCP request cannot be diverted through a configured proxy.

When TurenOS disables tools for a turn, such as after the maximum agent step, it does not register or configure an MCP
server. Claude still receives `--tools ""`, so the no-tools policy remains effective.

## Capability Boundary

Each MCP endpoint:

- binds to an ephemeral port on `127.0.0.1` only;
- uses an unguessable per-turn URL path and the same value as a bearer credential;
- returns `404` when either part of the capability is absent or wrong;
- lists only definitions from the turn's policy-filtered materialization;
- exists only within the provider-turn scope;
- aborts and drains active calls before teardown.

The same loopback capability exposes an authenticated HTTP hook endpoint. After two consecutive single-tool
exploration batches, it injects a bounded reminder to broaden the search, batch independent calls, and use available
subagents for disjoint work. It never approves, denies, rewrites, or executes a tool. Legacy Claude Code uses the same
state machine through an in-process Agent SDK `PostToolBatch` callback. Reminders are capped at two per provider turn
so a resistant model cannot rapidly flood its context.

The system prompt, MCP configuration, and TurenOS hook settings are written to a private temporary directory with
restrictive file modes and removed when the process scope closes. Cancelling a turn terminates the Claude process
group so descendants are not left detached.

## Tool Lifecycle

An authenticated MCP call is converted back into the normal TurenOS tool lifecycle:

1. TurenOS publishes the canonical tool input and call event.
2. The captured `ToolRegistry.Materialization` settles the call.
3. TurenOS publishes the canonical result, structured output, and output paths.
4. The MCP response returns the model-visible result, including interceptor notes, to Claude in the same `-p` run.

Claude's stream also reports its view of MCP tool calls and results. TurenOS suppresses those private `mcp__forge__*`
envelopes because the registry path has already published the authoritative lifecycle. Without suppression, one
mutation would appear twice under unrelated call IDs and would be replayed twice in later model context.

Call IDs are derived deterministically from the authenticated JSON-RPC request ID and turn capability. This makes an
exact transport retry resolve to the same TurenOS tool identity instead of creating a second random execution identity.
The `ToolRegistry` remains the authority for durable execution reconciliation.

Provider-executed tool envelopes from non-TurenOS sources are normalized to TurenOS's canonical tool names, but they remain
marked `providerExecuted` and are never settled a second time by TurenOS.

## Design Constraints

The bridge depends on several boundaries that are easy to miss:

- A subprocess cannot be integrated by renaming stream events. An IPC path must return TurenOS's actual settled result
  before Claude continues its model loop.
- Rebuilding a registry inside the HTTP handler is incorrect. The advertised materialization is a turn capability, not
  merely a list of schemas.
- `--allowedTools` is not an allowlist of available tools. Native tools must be disabled separately.
- `--strict-mcp-config` isolates MCP configuration but not settings or hooks. Settings sources must be disabled
  separately.
- MCP calls are synchronous from Claude's perspective. A TurenOS tool that waits for the provider stream to finish cannot
  be settled inline without creating a cycle. `update_goal` is the one such tool: it waits for this turn's goal
  accounting checkpoint, which cannot settle while the CLI blocks on the response. It is therefore deferred rather than
  withheld — the runner forks its settlement onto the same goal fiber set the native path uses, awaits it after the
  checkpoint, and answers the CLI inline with an acknowledgement that says the commit happens at turn end. Withholding
  it instead, as the bridge originally did, leaves a goal permanently active because nothing can ever complete it.
- The CLI echoes MCP calls in its stream. Those envelopes are observations, not a second execution request or a second
  durable lifecycle.
- Scope teardown must account for active HTTP calls and subprocess descendants, not only close the listening socket and
  direct child process.

## Verification

Protocol tests exercise authenticated listing and calls, policy-filtered definitions, annotated results, and rejection
without the turn capability. Transport tests exercise CLI arguments, temporary configuration, stream normalization,
private-envelope suppression, malformed and bounded output, terminal-result handling, and process teardown.

Run the focused tests from the Core package:

```bash
cd packages/core
bun test test/session-runner-claude-code-mcp.test.ts test/session-runner-claude-code.test.ts
bun typecheck
```

An opt-in test launches the installed, authenticated Claude CLI and verifies that it calls the private TurenOS MCP tool
while a project-level Claude hook remains disabled. It can incur provider usage:

```bash
cd packages/core
FORGE_LIVE_CLAUDE=1 bun test test/session-runner-claude-code-mcp.test.ts
```

An opt-in A/B probe runs two baseline and two guided `claude -p` investigations against fresh synthetic repositories.
It reports tool counts, parallel batches, subagent calls, serial shell probes, provider turns, elapsed time, and answer
accuracy. It incurs provider usage and requires available Claude Code quota:

```bash
cd packages/core
FORGE_LIVE_CLAUDE=1 bun run script/claude-workflow-probe.ts
```

Source:

- [`packages/core/src/session/runner/claude-code-mcp.ts`](../packages/core/src/session/runner/claude-code-mcp.ts)
- [`packages/core/src/session/runner/claude-code-bridge.ts`](../packages/core/src/session/runner/claude-code-bridge.ts)
- [`packages/core/src/session/runner/llm.ts`](../packages/core/src/session/runner/llm.ts)
- [`packages/core/src/tool/registry.ts`](../packages/core/src/tool/registry.ts)
- [`packages/core/src/provider/claude-code.ts`](../packages/core/src/provider/claude-code.ts)
