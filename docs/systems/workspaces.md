# Workspaces

Workspaces are an experimental control plane in the legacy `packages/forge` runtime. A workspace is a named place
where a project's sessions can run, such as a git worktree or a target a plugin provides, and requests can be routed to
it. The HTTP API and local routing are always registered; `FORGE_EXPERIMENTAL_WORKSPACES` gates event sync, and with it
remote routing. That flag follows the umbrella `FORGE_EXPERIMENTAL`, which the legacy runtime treats as on unless set to
`false`. Session V2 treats an explicit workspace ID as reserved for future placement.

## How it works

1. Workspaces are rows in the `workspace` table (`packages/core/src/control-plane/workspace.sql.ts`): ID, adapter
   type, name, branch, directory, adapter-specific `extra` data, and owning project.
2. A workspace adapter (`packages/forge/src/control-plane/types.ts`) implements `configure`, `create`, `remove`,
   `target`, and optionally `list`. The built-in `worktree` adapter creates a git worktree
   (`packages/forge/src/control-plane/adapters/worktree.ts`); plugins can register more.
3. `target` resolves a workspace to a local directory or a remote URL with headers. `Workspace.startSync` connects to
   that target and replays its events locally. When the target is unavailable it retries with exponential backoff capped
   at 2 minutes, and it reports `connecting`, `connected`, `disconnected`, or `error` status. With sync off, a request
   routed to a remote workspace fails with `503`.
4. The legacy routing middleware
   (`packages/forge/src/server/routes/instance/httpapi/middleware/workspace-routing.ts`) picks a workspace from the
   session's workspace or the `workspace` query parameter. The Session V2 Location reference
   (`packages/server/src/location.ts`) also accepts the `x-forge-workspace` header. The proxy strips that header before
   forwarding (`packages/forge/src/server/proxy-util.ts`).
5. `EventV2Bridge` emits sync envelopes only for eligible durable aggregates, and a peer replays the exact encoded event
   rather than editing projections. See [Trust and scope boundaries](../architecture/trust-boundaries.md#event-and-sync-boundary).

## HTTP API

All routes are under `/experimental/workspace`:

| Method and path   | Purpose                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `GET /adapter`    | List available adapters.                                                                   |
| `GET /`           | List workspaces for the project.                                                           |
| `POST /`          | Create a workspace with an adapter.                                                        |
| `POST /sync-list` | Add workspaces that adapters list but the project does not have yet (matched by name).     |
| `GET /status`     | Current sync status of each workspace.                                                     |
| `DELETE /:id`     | Remove a workspace through its adapter.                                                    |
| `POST /warp`      | Move a session into a workspace (or back with `id: null`), optionally copying its changes. |

## Configuration

`FORGE_EXPERIMENTAL_WORKSPACES` enables event sync and the workspace filter on session lists. It defaults to the value of
`FORGE_EXPERIMENTAL`, which is on unless set to `false`; set `FORGE_EXPERIMENTAL_WORKSPACES=false` to turn sync off. A
created workspace process receives `FORGE_WORKSPACE_ID`, `FORGE_EXPERIMENTAL_WORKSPACES=true`, and the parent's
OpenTelemetry exporter variables. See [Environment variables](./configuration.md#environment-variables).

## Verification

```sh
cd packages/forge
bun test test/control-plane/workspace.test.ts test/server/httpapi-workspace.test.ts test/server/workspace-routing.test.ts
```

## Limits

- Experimental and legacy-runtime only; Session V2 placement ignores explicit workspace identity for now.
- Session task aggregates and other protected ownership records are never synced.
- A remote target is trusted to the extent of the headers its adapter supplies.

## Source

- [`packages/forge/src/control-plane/workspace.ts`](../../packages/forge/src/control-plane/workspace.ts)
- [`packages/forge/src/control-plane/types.ts`](../../packages/forge/src/control-plane/types.ts)
- [`packages/forge/src/control-plane/adapters/worktree.ts`](../../packages/forge/src/control-plane/adapters/worktree.ts)
- [`packages/core/src/control-plane/workspace.sql.ts`](../../packages/core/src/control-plane/workspace.sql.ts)
- [`packages/core/src/control-plane/move-session.ts`](../../packages/core/src/control-plane/move-session.ts)
- [`packages/forge/src/server/routes/instance/httpapi/groups/workspace.ts`](../../packages/forge/src/server/routes/instance/httpapi/groups/workspace.ts)
- [`packages/forge/src/server/routes/instance/httpapi/middleware/workspace-routing.ts`](../../packages/forge/src/server/routes/instance/httpapi/middleware/workspace-routing.ts)
- [`packages/server/src/location.ts`](../../packages/server/src/location.ts)
