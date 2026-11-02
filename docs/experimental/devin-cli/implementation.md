# Devin implementation and safety plan

Status: adopted, as of 2026-10-28.

The [Devin CLI provider](../../providers/devin-cli.md) implements the managed route. Real-CLI tests qualified native-read blocking, fail-closed hook failure, and private host MCP execution on macOS.

This page records the pre-implementation plan from 2026-10-27. The implementation uses a fresh private Devin session per provider turn, not a persisted external-session association.

Return to the [research decision](./README.md) or inspect the [protocol evidence](./protocol.md).

## Existing integration points

The following source map refers to TurenOS commit `b1502839`:

| Area                     | Existing source                                                                                                                                                                   | Reuse or constraint                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| External ACP role        | [Forge ACP command](../../../packages/forge/src/cli/cmd/acp.ts#L49)                                                                                                               | Uses `AgentSideConnection`; serves TurenOS to an editor, not Devin to TurenOS        |
| Local CLI discovery      | [Muse provider](../../../packages/core/src/provider/muse-code.ts#L5) and [Claude provider](../../../packages/core/src/provider/claude-code.ts#L9)                                 | Executable discovery, local provider IDs, and probe patterns                         |
| Provider registration    | [Muse plugin](../../../packages/core/src/plugin/provider/muse-code.ts#L8) and [plugin list](../../../packages/core/src/plugin/provider.ts#L65)                                    | Catalog wiring; installation must not imply authentication                           |
| Model route selection    | [Runner model](../../../packages/core/src/session/runner/model.ts#L1060)                                                                                                          | Native CLI fast paths bypass normal HTTP adapters                                    |
| MCP registration         | [Runner](../../../packages/core/src/session/runner/llm.ts#L916)                                                                                                                   | Currently branches for Claude Code and Muse; not generic ACP support                 |
| Host tool bridge         | [Claude MCP](../../../packages/core/src/session/runner/claude-code-mcp.ts#L103)                                                                                                   | Private scoped tool definitions, execution callback, and tool-list refresh           |
| Host-only Claude tools   | [Claude arguments](../../../packages/core/src/session/runner/claude-code-bridge.ts#L872)                                                                                          | Disables native tools, foreign settings, and session persistence                     |
| Muse isolation           | [Muse bridge](../../../packages/core/src/session/runner/muse-code-bridge.ts#L16)                                                                                                  | Exact version gate, empty workspace, native-tool exclusion, and filtered environment |
| Durable input            | [Session API](../../../packages/core/src/session.ts#L1010) and [Session input](../../../packages/core/src/session/input.ts)                                                       | Admit first; execute through the serialized Session runner                           |
| Durable session metadata | [Session table](../../../packages/core/src/session/sql.ts#L54)                                                                                                                    | Existing metadata storage needs a typed ownership and update contract before reuse   |
| External event rendering | [Event publisher](../../../packages/core/src/session/runner/publish-llm-event.ts#L571)                                                                                            | Existing provider-executed tool records can represent reports without re-execution   |
| Process lifecycle        | [Muse cleanup](../../../packages/core/src/session/runner/muse-code-bridge.ts#L375) and [Claude termination](../../../packages/core/src/session/runner/claude-code-bridge.ts#L860) | Bounded cleanup and exact process-group ownership                                    |
| Manual terminal          | [Core PTY](../../../packages/core/src/pty.ts#L174) and [app terminal](../../../packages/app/src/components/terminal.tsx)                                                          | Immediate standalone use on the selected backend                                     |

Repository searches found ACP server code, but no external-agent ACP client. Adding `devin` to a config or catalog cannot supply that missing transport.

Muse is the smaller transport pattern. Claude Code is the richer reference for streaming, MCP, steering, and durable settlement. Neither protocol parser is suitable for Devin unchanged.

## Two authority models

### Trusted external agent

Devin owns its agent loop, native tools, configuration, subagents, and local conversation state. TurenOS owns user input admission, process supervision, UI events, and its own permission responses.

Show a clear warning before first launch: Devin can access the selected machine under its own policy. Workspace selection and ACP file locations are not an OS security boundary.

Keep this mode unavailable to restricted child tasks, automatic reviewers, background model selection, and unattended automations initially. Those paths assume host-enforced tool grants or can trigger unrequested billable work.

Do not label it read-only merely because TurenOS did not advertise filesystem or terminal capabilities. An agent can use its own implementations.

### Managed host tools

TurenOS owns all tool access, policy checks, durable pre-execution records, plugin interceptors, snapshots, protected outputs, and child-task grants. Devin may call only the private host MCP server.

The existing Claude Code route enforces this by removing native tools and foreign settings. The Muse route adds version-qualified exclusions and an empty transport workspace.

No equivalent Devin setup was qualified in this research. Instructions such as "use only TurenOS tools" are not enforcement. Permission rules and fail-closed hooks are candidates for a spike, not evidence of parity.

If native-tool exclusion cannot be proved, retain the external-agent label. Do not silently weaken the managed-agent contract.

### Documented controls worth testing

The [stable changelog](https://docs.devin.ai/cli/changelog/stable) documents `disabled_tools` in user configuration from `3000.10.21`. It disables named native tools. Per-MCP `disabledTools` also hides tools and rejects calls, according to the earlier release notes.

The [configuration guide](https://docs.devin.ai/cli/reference/configuration/config-file) documents `subagents_enabled: false`, which removes delegation tools. `permissions.deny` can block native tools. `read_config_from` can disable imported configurations, but organization-required cloud plugins still load.

These controls make managed integration plausible. They do not prove an exhaustive allowlist, an immutable host policy, or root system-prompt control. Test unknown tools, dynamic tool changes, imported hooks, and user or organization overrides.

The same guide documents `auto_update: false` for self-managed macOS and Linux installations. Qualify a private integration configuration without changing the user's settings. Do not assume a version pin survives the CLI's default background updates.

## Proposed package changes

These are proposed modules, relative to `packages/core/src/`. They do not exist in this research change.

| Proposed module                                                       | Responsibility                                                                                |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `provider/devin-cli.ts`                                               | Resolve an executable, check its build, and describe installation status without a model call |
| `session/runner/devin-acp.ts`                                         | Supervise the process and use the SDK client for session methods and notifications            |
| `session/external-agent.ts`, only if external mode is needed          | Own the typed external-session association, lifecycle, and authority mode                     |
| `plugin/provider/devin-cli.ts`, if managed provider support qualifies | Register an explicit local provider and authenticated model metadata                          |

Prefer a small Devin client first. Extract a generic external-agent framework only when another client needs the same contract. Do not rename the existing Claude bridge just to prepare for possible reuse.

Expected changes to existing code:

1. Select managed-provider reuse or an explicit external-agent mode after the compatibility spike.
2. Dispatch it from the V2 runner while retaining durable admission and Session ownership.
3. Keep one external agent loop within one explicit `llm.stream(request)` transport turn if using the existing LLM event path.
4. Keep tool callbacks and policy services Location-scoped.
5. Persist a typed Devin session association through Session-owned storage.
6. Add external-agent controls and disclosure in the app through Schema and Protocol contracts.
7. Update the legacy catalog projection only where the app still consumes it.
8. Regenerate Client bindings if public Protocol or Server `HttpApi` changes.

Core must not import Forge or Server runtime code. Client and app-facing contracts must not depend on Core implementation modules. Declare the ACP SDK in the owning package rather than importing its copy through Forge.

An external agent is not merely a model. Adding it only to `fromCatalogModel` would leave authority restrictions, input delivery, foreign state, and automatic helper calls unresolved.

## Delivery stages

### Stage 1: bounded compatibility spike

Use a throwaway repository and an explicit test account. Keep runtime integration disabled.

1. Exercise login and `session/new` with normal permissions.
2. Send a text prompt and verify streaming and terminal stop reasons.
3. Test host permission denial before a harmless write and shell command.
4. Load the saved session in a fresh process and inspect replay behavior.
5. Cancel a long-running harmless command and a background subagent.
6. Change model through advertised ACP configuration.
7. Connect one test MCP server and check tool-call correlation.
8. Test config import controls, shell environment inheritance, and native-tool exclusions.

Only an authorized account test can close these gates. The initialize-only probe does not close them.

### Stage 2: qualified local preview

If host-only enforcement passes, reuse the existing provider and MCP route with qualified controls. Avoid a second execution mode when the managed route meets the requirements.

Otherwise, ship an explicit external-agent session with text, tool cards, permissions, interruption, model controls, and durable session association. Limit that mode to user-started local sessions.

Use the user's CLI login. Do not auto-install, auto-update, import credentials, or fall back to another provider. Installation status and authentication status must remain distinct.

Keep startup capability negotiation. Warn or stop on an unqualified build when behavior affects authority. Do not use `agentInfo.version`, observed as `0.0.0-dev`, as the build gate.

Preserve queue and steer boundary semantics. Do not add private mid-turn extensions until their acknowledgment behavior has independent tests.

### Stage 3: optional TurenOS tool access

Adapt the existing private MCP bridge for Devin's advertised HTTP transport. Serve only the current Session's filtered tool definitions. Use short-lived credentials and revoke them when ownership ends.

Qualify whether Devin persists supplied MCP headers or connection payloads in its own session store. Never persist a reusable host capability token there.

MCP-only calls keep TurenOS policy and settlement. Native Devin calls do not. Present these origins separately and avoid duplicate execution or cards.

Do not enable restricted subagents, goals, or automations until the managed-host-tool requirements pass. Native Devin goals and subagents can otherwise bypass TurenOS budgets and task grants.

## Safety requirements

| Risk                                         | Confirmed basis                                          | Required treatment                                                                 |
| -------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Native side effects bypass host tools        | ACP reports agent execution; callbacks are optional      | Explicit external authority; qualify managed mode separately                       |
| Configuration starts extra code or tools     | Devin imports rules, skills, MCP, hooks, and plugins     | Test import controls; disclose retained organization requirements                  |
| Environment exposes credentials              | Devin documents a login-shell environment snapshot       | Do not assume a filtered spawn environment is full isolation                       |
| Untrusted repository setup                   | Print mode cannot show its trust prompt                  | Keep trust checks; never add `--respect-workspace-trust false` as a silent default |
| Hook failure bypasses a check                | Default hook errors can fail open; fail-closed is opt-in | Test crash, timeout, malformed output, and missing hook paths                      |
| Incomplete sandbox coverage                  | Sandbox protects exec processes, not the whole CLI       | Do not advertise full-agent containment                                            |
| Uncertain delivery after disconnect          | ACP has no TurenOS prompt-ID transaction                 | Reconcile explicitly; do not resend possible side effects                          |
| Cancellation leaves work running             | CLI has background shells and subagents                  | Test lifetime and owned process-group teardown                                     |
| Secrets enter disk logs                      | Devin documents sensitive trace logs and saved sessions  | Redact host streams; review external storage; avoid tracing by default             |
| Cloud task continues after local stop        | Cloud session lifetime is remote                         | Keep cloud opt-in and use a distinct lifecycle                                     |
| Provider charges differ from token estimates | Plans, enterprise ACUs, and extra usage differ           | Preserve reported units; show unknown when unavailable                             |

[Sandbox documentation](https://docs.devin.ai/cli/sandbox) describes macOS Seatbelt and Linux bubblewrap/seccomp. Linux and WSL require `bwrap` and `socat`; native Windows cannot run that sandbox. Read access is broad unless denied. Excluded commands can escape sandbox execution. Network filtering remains unstable.

[System policy documentation](https://docs.devin.ai/cli/enterprise/system-config#behavior-and-failure-modes) says unreadable or malformed policy drops enforcement. Do not rely on that file as a fail-closed TurenOS authorization boundary.

Keep cloud handoff separate. [Handoff](https://docs.devin.ai/cli/handoff) can transfer conversation, repository, branch, and uncommitted changes. [Cloud sessions](https://docs.devin.ai/cli/cloud) can continue after the terminal closes. Do not implement either as an automatic local-error fallback.

## Acceptance tests

| Area           | Required evidence before native preview                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| Discovery      | Missing executable, path with spaces, unsupported build, missing login, expired or rejected login         |
| Framing        | Split UTF-8, split JSON lines, malformed frames, stdout noise, size limits, EOF, and stderr floods        |
| Authentication | Browser success, cancellation, timeout, no tokens in host logs or durable transcript                      |
| Input delivery | Durable admit-before-send, one active prompt, ordered follow-ups, no premature steer promotion            |
| Streaming      | Text, reasoning, plan, tool updates, diffs, unknown content, and all stop reasons                         |
| Permissions    | Denial before side effects; unknown options rejected; pending requests cancelled on interruption          |
| Persistence    | Same backend and Location, fresh-process load, replay barrier, missing session, changed working directory |
| Retry          | Disconnect before send, after send, and after a tool effect; no automatic duplicate side effects          |
| Isolation      | Concurrent Sessions cannot share updates, prompts, grants, MCP credentials, or configuration              |
| Shutdown       | Cancel during model work, tool execution, approval, shell jobs, and native subagent activity              |
| Accounting     | Missing usage, cumulative usage, resumed-session totals, account quotas, no invented zero-cost claims     |
| Platform       | Packaged macOS PATH, Linux dependencies, Windows process trees, WSL placement, and SSH backend ownership  |

Additional managed-mode gates must force native reads, writes, shell tools, hooks, plugins, arbitrary MCP servers, and subagent tools. Each attempt must fail or route through the host's current grants. Tests must include denied paths, symlinks, task write roots, exact command grants, and failed policy loading.

Use existing [Claude runner tests](../../../packages/core/test/session-runner-claude-code.test.ts), [MCP tests](../../../packages/core/test/session-runner-claude-code-mcp.test.ts), and [Muse isolation tests](../../../packages/core/test/session-runner-muse-code-isolation.test.ts) as behavioral references. Add recorded protocol fixtures plus a controlled real-CLI qualification. Fake CLI tests alone cannot prove native-tool exclusion.

## Questions for Cognition

1. Can documented tool exclusions form a supported, fail-closed host-MCP-only mode?
2. Can that mode disable native shell, file, subagent, plugin, hook, and foreign MCP execution without user overrides?
3. Which ACP controls specify system context and disable imported configuration?
4. What stable acknowledgment contract applies to `cognition.ai/midTurnPrompts`?
5. Does cancellation stop native background shells and all descendant agents?
6. Which session data, MCP headers, credentials, and tool results are persisted by ACP?
7. What compatibility policy applies across rapidly changing CLI builds?
8. Which terms permit public TurenOS integration, optional installation, and possible binary redistribution?

## Verification

This research verified executable discovery, version/help output, official package metadata, repository integration points, and ACP initialization. It did not execute the proposed implementation or its acceptance suite.

## Source

- [Core runner](../../../packages/core/src/session/runner/llm.ts), [model routing](../../../packages/core/src/session/runner/model.ts), and [Session storage](../../../packages/core/src/session/sql.ts).
- [Claude bridge](../../../packages/core/src/session/runner/claude-code-bridge.ts), [MCP bridge](../../../packages/core/src/session/runner/claude-code-mcp.ts), and [Muse bridge](../../../packages/core/src/session/runner/muse-code-bridge.ts).
- [Session contract](../../../specs/v2/session.md), [tool contract](../../../specs/v2/tools.md), and [provider/model contract](../../../specs/v2/provider-model.md).
- [Devin permissions](https://docs.devin.ai/cli/reference/permissions), [configuration](https://docs.devin.ai/cli/reference/configuration/config-file), [configuration imports](https://docs.devin.ai/cli/reference/configuration/read-config-from), and [hooks](https://docs.devin.ai/cli/extensibility/hooks/overview).
- [Devin sandbox](https://docs.devin.ai/cli/sandbox), [subagents](https://docs.devin.ai/cli/subagents), [troubleshooting](https://docs.devin.ai/cli/troubleshooting), and [system policy](https://docs.devin.ai/cli/enterprise/system-config).
