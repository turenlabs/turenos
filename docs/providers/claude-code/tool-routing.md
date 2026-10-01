# Claude Code tool routing

TurenOS runs the Claude Code subscription provider through `claude -p`. Because that CLI is a separate process, allowing
it to execute native tools would bypass TurenOS's permissions, interceptors, durable tool lifecycle, output storage, and
turn-specific tool policy. TurenOS instead treats the current provider turn's `ToolRegistry.Materialization` as a
capability and exposes it to Claude through a private MCP server.

This page is about routing a provider's tool calls into TurenOS. [Shell tool routing](../../systems/shell-tool-routing.md)
is unrelated: it redirects shell commands to specialized workspace tools.

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

## CLI isolation

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

It also sets Claude Code variables that no flag expresses, overriding any inherited value:

- `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` drops Claude Code's auto-memory prompt, about half of its system prompt, which
  targets a Write tool the bridge never exposes. TurenOS memory tools and guidance are unaffected.
- `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` drops the per-turn git status snapshot. It precedes the replayed transcript,
  so any file edit changed it and invalidated the next turn's cached transcript. TurenOS's own environment context still
  reports whether the directory is a git repository, as it does for every provider.
- `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` keeps MCP calls synchronous. An inherited `CLAUDE_AUTO_BACKGROUND_TASKS=1`
  would otherwise move a long call into a background task and let the run end before TurenOS settles it.
- `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH=65536` delivers TurenOS tool descriptions in full, as other providers receive
  them, instead of truncating them at 2,048 characters.

When TurenOS disables tools for a turn, such as after the maximum agent step, it does not register or configure an MCP
server. Claude still receives `--tools ""`, so the no-tools policy remains effective.

## Mid-turn steering

One TurenOS provider turn is one `claude -p` run, which can make many model requests and tool calls. So that a steer
does not wait for the whole run, TurenOS keeps stdin open on tool-enabled turns and uses the CLI's own mid-turn queue,
the path interactive Claude Code uses for a message typed while it works:

- The bridge accepts steers only after `system/init` advertises both `msg_lifecycle_v1` and
  `interrupt_cancel_queued_v1`. Older CLIs keep boundary delivery.
- The runner polls for pending steers and hands each eligible one to the CLI as a default-priority `user` message with
  a bridge-generated uuid. Eligible means a plain text prompt for the running agent and model. Commands, goals,
  attachments, and a different agent or model hold the queue for the boundary, so steers keep admission order.
- The CLI folds the message in after its current tool calls finish and before its next model request, and reports
  `command_lifecycle` `started`. Only then does the runner promote the input. It ends the current assistant step with no
  usage, since the CLI reports the run's usage once on the final step, and opens a new one. The transcript shows the
  steer where the model read it.
- A steer written during a final answer with no tool calls is not folded in. The CLI takes it off its queue within a
  millisecond of the run's `result` to start a second turn, too soon for `cancel_async_message`. So at the `result`,
  if any steer is unfolded, the bridge sends `interrupt` with `cancel_queued: true` and closes stdin. The interrupt
  aborts that turn before the model reads the steer, and the bridge accepts the CLI's resulting exit code 1. The steer
  stays pending and promotes at the next provider-turn boundary.
- An input cancelled in TurenOS while the run continues is withdrawn with `cancel_async_message`. If the CLI folds it
  in before the cancel lands, the model has read it, so the runner promotes it anyway and the cancellation does not
  stand.
- The step that ends at a fold records no usage, so reverting to a steer subtracts the whole run's tokens from the
  Session totals. Claude Code runs report no cost, so this affects token counts only.

## Transcript replay and caching

Each provider turn replays the TurenOS transcript as one stream-json user message. The CLI marks only that message's last
content block for prompt caching, so the replay is split into append-only blocks. The next turn then reads the previous
turn's cache entry at the matching block boundary instead of rewriting the whole transcript:

- Each user message and each chronological system update is its own block, and each run of assistant and tool
  messages is one block. A turn normally appends two blocks and rewrites none.
- System updates use the same `<system-update>` wrapper as every other provider route.
- PNG, JPEG, GIF, and WebP images, including screenshots in tool results, follow the block of the message that
  attached them. Past eight images or 8 MiB, the newest are kept and older ones remain attachment notes; below those
  limits, no earlier block changes. Other image types are noted as not forwarded.
- When the replay exceeds the 4 MiB prompt limit, the oldest blocks are dropped first behind an omission notice.
- One-turn runtime instructions (the todo checkpoint, harness guidance, and reflection and stream-recovery prompts) are
  not replayed. The todo checkpoint accompanies every new human message, and a block that is absent from the next
  replay leaves the turn's cache entry unreachable.

A turn that carries a one-turn note, such as goal context or a current-task anchor, still does not produce a cross-turn
hit for the turn after it, for the same reason. Do not add a TurenOS `cache_control` marker to compensate: the CLI
already uses all four cache breakpoints on its follow-up requests, and a fifth makes the API reject the request.

## Capability boundary

Each MCP endpoint:

- binds to an ephemeral port on `127.0.0.1` only;
- uses an unguessable per-turn URL path and the same value as a bearer credential;
- returns `404` when either part of the capability is absent or wrong;
- lists only definitions from the turn's policy-filtered materialization;
- exists only within the provider-turn scope;
- aborts and drains active calls before teardown.

The same loopback capability exposes an authenticated HTTP hook endpoint. After two consecutive single-tool
exploration batches, it injects a bounded reminder to broaden the search, batch independent calls, and use available
subagents for disjoint work. It never approves, denies, rewrites, or executes a tool. Only this V2 bridge sends the
reminder; the legacy Claude Code path in `packages/forge` has no `PostToolBatch` hook. Reminders are capped at two per
provider turn so a resistant model cannot rapidly flood its context.

The system prompt, MCP configuration, and TurenOS hook settings are written to a private temporary directory with
restrictive file modes and removed when the process scope closes. Cancelling a turn terminates the Claude process
group so descendants are not left detached.

## Tool lifecycle

An authenticated MCP call is converted back into the normal TurenOS tool lifecycle:

1. TurenOS publishes the canonical tool input and call event.
2. The captured `ToolRegistry.Materialization` settles the call.
3. TurenOS publishes the canonical result, structured output, and output paths.
4. The MCP response returns the model-visible result, including interceptor notes, to Claude in the same `-p` run.

Inline PNG, JPEG, GIF, and WebP images in a result, such as screenshots, return as MCP image content, up to eight
images or 8 MiB per result. Other inline data becomes a short omission note, and file-backed attachments stay
references. Claude echoes those images on stdout, so one stream-json line may be up to 20 MiB; the 8 MiB cap on output
TurenOS records is unchanged.

Claude's stream also reports its view of MCP tool calls and results. TurenOS suppresses those private `mcp__forge__*`
envelopes because the registry path has already published the authoritative lifecycle. Without suppression, one
mutation would appear twice under unrelated call IDs and would be replayed twice in later model context.

Call IDs are derived deterministically from the authenticated JSON-RPC request ID and turn capability. This makes an
exact transport retry resolve to the same TurenOS tool identity instead of creating a second random execution identity.
The `ToolRegistry` remains the authority for durable execution reconciliation.

Provider-executed tool envelopes from non-TurenOS sources are normalized to TurenOS's canonical tool names, but they remain
marked `providerExecuted` and are never settled a second time by TurenOS.

## Design constraints

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
  it would leave a goal permanently active, because nothing could ever complete it.
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

- [`packages/core/src/session/runner/claude-code-mcp.ts`](../../../packages/core/src/session/runner/claude-code-mcp.ts)
- [`packages/core/src/session/runner/claude-code-bridge.ts`](../../../packages/core/src/session/runner/claude-code-bridge.ts)
- [`packages/core/src/session/runner/llm.ts`](../../../packages/core/src/session/runner/llm.ts)
- [`packages/core/src/tool/registry.ts`](../../../packages/core/src/tool/registry.ts)
- [`packages/core/src/provider/claude-code.ts`](../../../packages/core/src/provider/claude-code.ts)
