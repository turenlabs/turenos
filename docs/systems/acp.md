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

| Option          | Default                                                             | Meaning                                                                                   |
| --------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `--cwd`         | current dir                                                         | Accepted but not used; each ACP session uses the `cwd` in its own request.                |
| `--hostname`    | `server.hostname`, else `0.0.0.0` when mDNS is on, else `127.0.0.1` | Listener for the embedded server.                                                         |
| `--port`        | `server.port`, else `0` (any free)                                  | Listener port.                                                                            |
| `--mdns`        | `server.mdns`, else `false`                                         | Advertise the server over mDNS.                                                           |
| `--mdns-domain` | `server.mdnsDomain`, else `forge.local`                             | mDNS domain name.                                                                         |
| `--cors`        | none                                                                | Extra CORS origins, added to `server.cors`.                                               |
| `--insecure`    | `false`                                                             | Allow a non-loopback hostname without `FORGE_SERVER_PASSWORD`; otherwise startup refuses. |

The `server.*` defaults come from the global [configuration](./configuration.md); a flag given on the command line
always wins.

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
- `authenticate` only checks that the method is `forge-login` and returns success; it performs no login itself. With
  the `terminal-auth` capability the editor is pointed at `forge auth login`.
- The command handler returns when stdin ends, so the editor controls the process lifetime by closing stdin.

## Source

- [`packages/forge/src/cli/cmd/acp.ts`](../../packages/forge/src/cli/cmd/acp.ts)
- [`packages/forge/src/acp/agent.ts`](../../packages/forge/src/acp/agent.ts)
- [`packages/forge/src/acp/service.ts`](../../packages/forge/src/acp/service.ts)
- [`packages/forge/src/acp/permission.ts`](../../packages/forge/src/acp/permission.ts)
- [`packages/forge/src/acp/event.ts`](../../packages/forge/src/acp/event.ts)
- [`packages/forge/src/cli/network.ts`](../../packages/forge/src/cli/network.ts)
- Tests: [`packages/forge/test/acp/`](../../packages/forge/test/acp/), [`packages/forge/test/cli/acp/`](../../packages/forge/test/cli/acp/)
