# Developer catalog runtime

The Developer Catalog is built into the monorepo. `services/catalog/manifests/` holds the canonical manifests
(data sources, skills, MCP servers, tools); `packages/extensions` compiles them into `src/generated.ts` at
build time, and the server returns catalog items plus installed runtime state from `GET /api/extension`.
There is no remote catalog endpoint.

## Dynamic Installation

For catalog entries with no packaged runtime requirement — prompt-only skills and generic hosted MCPs — the
renderer submits the catalog manifest with `Extension.Update`. The server validates and stores that manifest
beside the extension's desired state, then rehydrates it on restart. Skill content is scanned by Vigil at
install; reviewed manifests are recognized by digest in `packages/forge/src/skill/vigil.ts`.

Installed manifests participate in the same MCP lifecycle, endpoint qualification, reviewed tool allowlist, lazy
`mcp_search`/`mcp_load` broker limits, and result redaction as other built-in MCP integrations.

Native tools and local MCP processes still require their audited adapters and packaged artifacts in the same
TurenOS release; a manifest alone cannot install binaries or supply runtime code.

## Read Path

The renderer emits these `[developer-catalog]` phases with one catalog-load `operationID`:

1. `catalog.load.started`
2. `catalog.load.completed`
3. `catalog.load.failed`

Catalog traces contain counts and elapsed time. They never contain credentials or extension configuration values.

## Update Path

Every renderer action creates an `operationID` and sends it as transient `Extension.Update.operationID`.
It is not persisted in desired extension state.

The renderer emits:

1. `extension.update.requested`
2. `extension.update.completed` or `extension.update.failed`
3. `extension.update.settled`

The server uses the same `operationID` in these structured messages:

1. `Extension HTTP update received`
2. `Extension activation update started`
3. `Extension activation update completed`, including the desired revision and whether it changed
4. `MCP Extension update started`
5. contribution disconnect, runtime reset, reconciliation, OAuth, and sibling-tombstone phase messages
6. `MCP Extension update completed` or a phase-specific failure
7. `Extension HTTP update completed` or `Extension HTTP update failed`

Search both renderer and sidecar logs for the same `operationID` to reconstruct one click.

## State Machine

`Enable` and `Connect` are separate commands:

- `Enable` sends `{ enabled: true }`. It admits the extension, returns immediately, and may discover that
  authorization is required. It never opens a browser.
- `Connect` sends `{ enabled: true, connect: true }`. Only this explicit command may begin interactive OAuth.
- `Disable` sends `{ enabled: false }`. It synchronously tombstones managed network access, records Disabled,
  disconnects best-effort, and resets the current directory's MCP runtime cache. Sibling transports remain allocated
  until normal lifecycle cleanup, but the shared tombstone rejects their requests immediately; no project instance is
  rebooted for an MCP toggle.

Desired-state revisions fence observations. A background task from an older revision cannot overwrite a newer
card state. Fiber interruption caused by disable, reconfiguration, or instance disposal is cancellation, not a
user-visible failure.

## Runtime Ownership

Extension HTTP requests never own MCP connection or OAuth work. Each directory's MCP `InstanceState` owns a keyed
`FiberMap`; the HTTP handler enqueues `extension:<manifest-id>` and returns. The worker survives the request, duplicate
operations replace the same key, and resetting the MCP state interrupts every owned worker and callback wait.

Each location re-evaluates enabled managed contributions when its tool inventory is requested. Missing managed clients
start in the instance-owned `FiberMap`, and every connection settlement publishes `ToolsChanged` so already-materialized
tool registries refresh instead of remaining permanently empty.

MCP toggles must not call project-wide instance disposal. Disable revokes and aborts managed network access
process-wide, resets only the current MCP state, and lets sibling location resources close through their normal
lifecycle.

At desktop startup, Home hydrates session directories incrementally and cancels remaining hydration when route restore
unmounts it. Global server readiness waits only for project identity; config, provider, and path queries are independent
and must not delay restored-tab navigation.

## Troubleshooting

1. Find `extension.update.requested` in the renderer log and copy its `operationID`.
2. Search the sidecar log for that ID.
3. Confirm the HTTP, activation, and MCP revision values agree.
4. If the card remains Connecting, locate the last contribution or reconciliation phase.
5. If the sidecar exits, inspect desktop `main.log`, `server.log`, and `utility.log` for `parent sent stop command`,
   `child-process-gone`, exit code, and respawn outcome. A clean parent stop is not a crash.
6. Never diagnose from a raw `Cause([Interrupt(...)])`: expected interruption is logged as cancellation and must
   not be persisted as Failed.

## Related pages

- [Skill quality benchmark](./skill-quality.md): the review rubric every catalog skill must pass.
- [Threat intelligence feed rights](./feed-licenses.md): which threat feeds the catalog may admit and how their data is handled.

## Source

- [`services/catalog/manifests`](../../../services/catalog/manifests)
- [`packages/extensions/script/generate.ts`](../../../packages/extensions/script/generate.ts)
- [`packages/extensions/src/validate.ts`](../../../packages/extensions/src/validate.ts)
- [`packages/core/src/extension.ts`](../../../packages/core/src/extension.ts)
- [`packages/forge/src/skill/vigil.ts`](../../../packages/forge/src/skill/vigil.ts)
