# Tool registry

Session V2 has one representation for a local tool and one place where a tool call executes. Every built-in, application,
and MCP tool is a `Tool.make(...)` value registered with a scope; each provider turn materializes the tools that apply
to that Session, and `ToolRegistry.Materialization.settle` is the only execution boundary. Hiding a tool from the list
is catalog visibility, not authorization: permission checks happen inside the tool when it runs.

## Registration

| Layer              | Scope                        | Holds                                                                                                   |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `ApplicationTools` | process, shared by Locations | Tools registered by an embedding host, such as `tools.register(...)` on `@turenlabs/sdk-next`           |
| `Tools`            | Location                     | Built-in tools and other Location producers, registered with `Tools.Service.register({ [name]: tool })` |
| MCP (`McpTool`)    | Location, per Session        | Tools from connected MCP servers, registered when a turn assembles its tools                            |
| Session tools      | one turn                     | Tools passed for a single materialization                                                               |

When two registrations use the same name, the latest active one in the same scope wins, a Location registration beats
an application registration, and closing a registration reveals the next active one. A call captures the tool it
resolved when settlement starts, so a later registration never changes a call already running.

## Materialization

For each provider turn the registry:

1. collects the effective registrations;
2. removes every tool whose permission action is denied outright: in some applicable ruleset, the last rule matching the
   action is a `deny` on resource `*`;
3. advertises full definitions for ordinary tools and catalogs deferred tools by name and description only.

Most tools use their own name as the permission action; `edit`, `write`, and `apply_patch` share the `edit` action, and
`shell_job` uses the `bash` action, so a whole-tool `bash` deny also hides it.

A call is settled against the registration it was advertised with. If that registration has since been replaced or
closed, the call returns `Stale tool call: <name>` and nothing executes; a name that was never advertised returns
`Unknown tool: <name>`.

## Deferred tools

A tool made with `deferred: true` (or `Tool.withDeferred`) stays callable but its schema isn't sent until selected, which
keeps rarely used capabilities out of context. The model finds deferred tools with `tool_search` and selects one with
`tool_load`; the selected definition appears on the next provider turn. `mcp_search` and `mcp_load` are hidden aliases
over the MCP subset. A direct call to a deferred tool that wasn't selected still executes, and any allow rule other than
the catch-all `*` whose action pattern matches the tool keeps it inline.

## Interceptors

Registered interceptors run inside settlement, for every call that reaches a real tool (subagent calls included):

- **Before** sees the raw provider arguments. It can deny the call, whose reason becomes the tool error, or replace the
  arguments, which are then decoded by the tool's own schema.
- **After** sees the settled result and can only append notes to the model-visible output. Notes are dropped for denied
  calls; on a failed call they are appended to the error text. An individual interceptor may still choose to stay
  silent on errors, as the quality gate does.

Each phase has a 30-second budget shared by all interceptors, not per interceptor. An interceptor that throws, fails, or
runs out of budget has no effect and the call proceeds; interruption still propagates. Batou and the quality gate are
interceptors. Output is bounded: at most 8 notes per call, 4,000 characters per note, and 2,000 characters for a deny
reason.

[`specs/v2/session.md`](../../specs/v2/session.md) says notes are dropped for failed calls, which disagrees with the code
described above.

## Output

Tools return complete domain output. Settlement bounds the model-visible copy (2,000 lines or 50 KiB by default) and
writes oversized output to a managed file, as described in the
[architecture constraints](../architecture/README.md#operational-constraints).

## Built-in tools

Session V2 registers its built-ins through `BuiltInTools.node` (`packages/core/src/tool/builtins.ts`) plus per-turn
session tools supplied by `SessionToolSnapshot`. The legacy runtime builds its list in
`packages/forge/src/tool/registry.ts`. "Deferred" means the schema is withheld until `tool_load` selects the tool.

| Tool                                                                                           | Purpose                                                                                                          | Runtime       | Deferred                    | Source                                                                                                                          |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `read`, `glob`, `grep`                                                                         | Read files and search the workspace                                                                              | V2 and legacy | no                          | `packages/core/src/tool/read.ts`, `glob.ts`, `grep.ts`; `packages/forge/src/tool/read.ts`, `glob.ts`, `grep.ts`                 |
| `edit`, `write`, `apply_patch`                                                                 | Mutate workspace files                                                                                           | V2 and legacy | no                          | `packages/core/src/tool/edit.ts`, `write.ts`, `apply-patch.ts`; `packages/forge/src/tool/edit.ts`, `write.ts`, `apply_patch.ts` |
| `bash`                                                                                         | Run a shell command (V2 admits it as a [shell job](./shell-jobs.md))                                             | V2 and legacy | no                          | `packages/core/src/tool/bash.ts`; `packages/forge/src/tool/shell.ts`                                                            |
| `shell_job`                                                                                    | Observe or cancel the Session's shell jobs                                                                       | V2 (session)  | no                          | `packages/core/src/tool/shell-job.ts`                                                                                           |
| `webfetch`, `websearch`                                                                        | Fetch a URL; search the web through Exa or Parallel                                                              | V2 and legacy | no                          | [Web tools](./web-tools.md)                                                                                                     |
| `code_search`                                                                                  | Ranked code search over the Location index                                                                       | V2            | no                          | `packages/core/src/tool/code-search.ts`                                                                                         |
| `todowrite`, `question`, `skill`                                                               | Todo list, user questions, skill loading                                                                         | V2 and legacy | no                          | `packages/core/src/tool/todowrite.ts`, `question.ts`, `skill.ts`; `packages/forge/src/tool/todo.ts`, `question.ts`, `skill.ts`  |
| `get_goal`, `create_goal`, `update_goal`                                                       | Session goal state                                                                                               | V2            | no                          | `packages/core/src/tool/goal.ts`                                                                                                |
| `reflection_state`, `reflection_read`, `reflection_complete`                                   | Durable predictions and hypotheses                                                                               | V2            | no                          | `packages/core/src/tool/reflection.ts`                                                                                          |
| `memory_search`, `memory_read`, `memory_write`, `memory_forget`                                | Project [memory](./memory.md)                                                                                    | V2            | `memory_forget` only        | `packages/core/src/tool/memory.ts`                                                                                              |
| `automation_list`, `automation_create`, `automation_update`                                    | [Automations](./automations/README.md)                                                                           | V2            | yes                         | `packages/core/src/tool/automation.ts`                                                                                          |
| `whiteboard_read`, `whiteboard_update`                                                         | [Session whiteboard](./whiteboard.md)                                                                            | V2            | yes                         | `packages/core/src/tool/whiteboard.ts`                                                                                          |
| `browser_*` (start, navigate, status, intercept, decide, history, flow, replay, stop)          | [Security Browser](./security-browser.md)                                                                        | V2            | yes                         | `packages/core/src/tool/security-proxy.ts`                                                                                      |
| `rosetta_exec`                                                                                 | [Rosetta execution](./rosetta-exec.md)                                                                           | V2            | yes                         | `packages/core/src/tool/rosetta-exec.ts`                                                                                        |
| `hexview`, `decompile`, `yara_scan`, `carve_embedded`, and the offline analysis families       | [Offline security tools](./offline-security-tools/README.md)                                                     | V2            | yes, except `follow_stream` | `packages/core/src/tool/builtins.ts` and the `*-tools.ts` files it imports                                                      |
| `inspect_change`                                                                               | Yolk impact inspection, only while the `turenlabs/yolk` extension is enabled                                     | V2            | no                          | `packages/core/src/tool/yolk.ts`                                                                                                |
| `lobby_room_context`                                                                           | Room history for [Lobby](./lobby.md) sessions only                                                               | V2 (session)  | no                          | `packages/core/src/tool/lobby-room-context.ts`                                                                                  |
| `tool_search`, `tool_load` (`mcp_search`, `mcp_load` hidden aliases)                           | Select deferred tools                                                                                            | V2 (session)  | no                          | `packages/core/src/tool/session-snapshot.ts`, `broker.ts`                                                                       |
| `spawn_agent`, `spawn_agents`, `send_agent`, `wait_agents`, `interrupt_agent`, `notify_parent` | [Subagent workstreams](./subagent-workstreams.md)                                                                | V2 (session)  | no                          | `packages/core/src/tool/subagent.ts`                                                                                            |
| `list_agents`, `peek_agent`, `agent_doc`                                                       | Inspect sibling and child subagents                                                                              | V2 (session)  | yes                         | `packages/core/src/tool/subagent.ts`                                                                                            |
| `room_read`, `room_post`, `room_claim`, `room_wait`                                            | [Swarm](./swarm.md) room coordination                                                                            | V2 (session)  | no                          | `packages/core/src/tool/swarm-room.ts`                                                                                          |
| `propose_agent_improvement`, `adjudicate_agent_improvement`, `apply_agent_improvement`         | [Agent improvement](./agent-improvement.md)                                                                      | V2 (session)  | no                          | `packages/core/src/tool/agent-improvement.ts`                                                                                   |
| `handoff_session`                                                                              | Hand the conversation to a new Session                                                                           | V2 (session)  | yes                         | `packages/core/src/tool/handoff.ts`                                                                                             |
| `terminal`                                                                                     | The Session's shared interactive terminal; always offered, provisioned on first use                              | V2 (session)  | no                          | `packages/core/src/tool/session-snapshot.ts`                                                                                    |
| `harness_review_request`                                                                       | Ask the Automatic Harness reviewer to look at this Session; top-level Sessions only, when the harness is present | V2 (session)  | no                          | `packages/core/src/session/harness.ts`                                                                                          |
| `harness_*`                                                                                    | Enabled, read-only tools from the Session's harness snapshot, run as confined CodeMode programs                  | V2 (session)  | no                          | `packages/core/src/session/harness.ts`                                                                                          |
| `task`                                                                                         | Legacy subagent task                                                                                             | legacy        | no                          | `packages/forge/src/tool/task.ts`                                                                                               |
| `repo_map`                                                                                     | Repository overview                                                                                              | legacy        | no                          | `packages/forge/src/tool/repo_map.ts`                                                                                           |
| `workspace_symbol`, `references`, `incoming_calls`, `definition`                               | LSP-backed symbol navigation                                                                                     | legacy        | no                          | `packages/forge/src/tool/lsp-symbol.ts`                                                                                         |
| `lsp`                                                                                          | Raw LSP operations, while `FORGE_EXPERIMENTAL_LSP_TOOL` is on                                                    | legacy        | no                          | `packages/forge/src/tool/lsp.ts`                                                                                                |
| `execute`                                                                                      | [CodeMode](./codemode/README.md); only while MCP tools are visible, unless `FORGE_EXPERIMENTAL_CODE_MODE=false`  | legacy        | no                          | `packages/forge/src/tool/code-mode.ts`                                                                                          |
| `plan_exit`                                                                                    | Leave plan mode; CLI client only, while `FORGE_EXPERIMENTAL_PLAN_MODE` is on                                     | legacy        | no                          | `packages/forge/src/tool/plan.ts`                                                                                               |

The legacy `FORGE_EXPERIMENTAL_*` flags are read through `packages/forge/src/effect/runtime-flags.ts`, where an unset
`FORGE_EXPERIMENTAL` counts as on, so these tools are present unless the flag is set to `false`. The legacy registry
advertises `question` only to the app, CLI, and Desktop clients or when the question tool is enabled explicitly, and it
never advertises `edit` and `apply_patch` to the same model; see [Shell tool routing](./shell-tool-routing.md).

`packages/core/src/tool/team-board.ts` defines `board_post` and `board_read`, but no runtime registers them; agents
coordinate through the swarm room tools.

## Limits

- The registry performs no execution authorization; each tool checks permission itself. A tool that never asks, such as
  the Security Browser tools, can only be hidden with a whole-tool `deny`, not gated with `ask`.

## Source

- [`packages/core/src/tool/tool.ts`](../../packages/core/src/tool/tool.ts)
- [`packages/core/src/tool/registry.ts`](../../packages/core/src/tool/registry.ts)
- [`packages/core/src/tool/tools.ts`](../../packages/core/src/tool/tools.ts)
- [`packages/core/src/tool/application-tools.ts`](../../packages/core/src/tool/application-tools.ts)
- [`packages/core/src/tool/broker.ts`](../../packages/core/src/tool/broker.ts)
- [`packages/core/src/tool/interceptor.ts`](../../packages/core/src/tool/interceptor.ts)
- [`packages/core/src/tool/mcp.ts`](../../packages/core/src/tool/mcp.ts)
