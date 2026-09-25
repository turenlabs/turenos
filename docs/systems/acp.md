# ACP server

`forge acp` lets an editor that speaks the Agent Client Protocol (ACP) drive TurenOS sessions. The command starts a
local TurenOS server and speaks ACP version 1 as newline-delimited JSON on its own stdin and stdout, so the editor
launches it as a subprocess. MCP servers supplied by the editor are rejected; tools come only from TurenOS
configuration.

## How it works

1. `forge acp` (`packages/forge/src/cli/cmd/acp.ts`) sets `FORGE_CLIENT=acp`, starts the product server with the
   standard network options, and builds a JavaScript SDK client against it with `ServerAuth.headers()`.
2. `AgentSideConnection` from `@agentclientprotocol/sdk` reads ACP requests from stdin and writes responses to stdout.
   `ACP.init` (`packages/forge/src/acp/agent.ts`) maps each request to `ACPService` (`packages/forge/src/acp/service.ts`).
3. `initialize` reports protocol version 1, session load, list, resume, fork, and close, and prompt support for images
   and embedded context. It offers one auth method, `forge-login`. When the client advertises the `terminal-auth`
   capability, the method also names `forge auth login` as the command to run.
4. `newSession` rejects any client MCP servers, snapshots the working directory's agents, models, and config options,
   and creates a TurenOS session with the default agent, model, and variant.
5. Prompts, cancellation, mode (agent) and model changes, and config options go through the SDK client. Session events
   are translated into ACP updates by `event.ts`, `tool.ts`, `content.ts`, and `usage.ts`.
6. A TurenOS permission request becomes an ACP `requestPermission` call with **Allow once**, **Always allow**, and
   **Reject**. If the client cannot show permission requests, or the request fails, TurenOS rejects the call.

## Configuration

| Option       | Default        | Meaning                                                                                   |
| ------------ | -------------- | ----------------------------------------------------------------------------------------- |
| `--cwd`      | current dir    | Accepted but not used; each ACP session uses the `cwd` in its own request.                |
| `--hostname` | `127.0.0.1`    | Listener for the embedded server.                                                         |
| `--port`     | `0` (any free) | Listener port.                                                                            |
| `--insecure` | `false`        | Allow a non-loopback hostname without `FORGE_SERVER_PASSWORD`; otherwise startup refuses. |

Like `forge serve`, the process needs `FORGE_SECRET_VAULT_KEY_ID` and `FORGE_SECRET_VAULT_KEY` outside tests; see
[Secure storage](./secure-storage.md). Models, agents, and permissions come from the normal
[configuration](./configuration.md) of the session directory.

## Verification

```sh
cd packages/forge
bun test test/acp test/cli/acp
```

## Limits

- Editor-supplied MCP servers fail session creation with `McpServersUnsupportedError`.
- Authentication is TurenOS's own login; `authenticate` accepts only `forge-login`.
- The embedded server listens only while the editor keeps stdin open; closing stdin ends the process.

## Source

- [`packages/forge/src/cli/cmd/acp.ts`](../../packages/forge/src/cli/cmd/acp.ts)
- [`packages/forge/src/acp/agent.ts`](../../packages/forge/src/acp/agent.ts)
- [`packages/forge/src/acp/service.ts`](../../packages/forge/src/acp/service.ts)
- [`packages/forge/src/acp/permission.ts`](../../packages/forge/src/acp/permission.ts)
- [`packages/forge/src/acp/event.ts`](../../packages/forge/src/acp/event.ts)
- [`packages/forge/src/cli/network.ts`](../../packages/forge/src/cli/network.ts)
- Tests: [`packages/forge/test/acp/`](../../packages/forge/test/acp/), [`packages/forge/test/cli/acp/`](../../packages/forge/test/cli/acp/)
