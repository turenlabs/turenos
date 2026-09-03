# Developer Catalog Runtime

The Developer Catalog has two contracts that meet in the renderer:

1. The server returns installed runtime state from `GET /api/extension`.
2. An optional external endpoint returns discovery metadata from `registry.json`, with the paginated
   `/v1/extensions` API retained only as a 403/404 compatibility fallback.

The renderer merges external manifests by manifest ID. A matching server item remains authoritative for
`enabled`, `status`, credentials, configuration, and mutability. An external-only generic hosted MCP can be
installed dynamically; native tools, local MCP processes, credential-injecting MCPs, and skills still require
runtime adapter or packaged content support in a TurenOS release.

## Dynamic MCP Installation

The renderer projects an eligible external manifest onto TurenOS's runtime schema before sending it to the server.
The server validates and stores that manifest beside the extension's desired state, then rehydrates it on restart.
Installed manifests participate in the same MCP lifecycle, endpoint qualification, reviewed tool allowlist, lazy
`mcp_search`/`mcp_load` broker limits, and result redaction as built-in MCP integrations.

Dynamic installation is deliberately narrower than the catalog schema:

- Only generic HTTPS hosted MCP contributions using `none` or OAuth authentication are accepted.
- Dynamic contributions are read-only. Catalog-declared write tools are removed until signed publisher policy can
  safely extend runtime permissions.
- Every dynamic MCP tool call requires explicit user confirmation because an unsigned catalog cannot prove that an
  upstream action is actually read-only.
- The server ignores catalog adapter authority and derives `mcp:<contribution-id>` itself.
- Catalog trust labels are display metadata, not publisher authentication; dynamic entries run as community trust.
- A version is immutable. Updates may increase semver and tool metadata, but cannot change endpoint, authentication,
  contribution identity, configuration, or credential bindings.
- Community tool descriptions, schema annotations, and server instructions are not admitted into agent context.

External native tools and skills remain visible with an explicit compatibility reason instead of a generic preview
message. Their manifests cannot install binaries or supply a `SKILL.md` body by themselves.

## Read Path

The renderer emits these `[developer-catalog]` phases with one catalog-load `operationID`:

1. `catalog.load.started`
2. `catalog.server-list.completed`
3. `catalog.registry.requested`
4. `catalog.registry.responded`
5. `catalog.registry.loaded`
6. `catalog.registry.fallback` when static loading returns 403 or 404
7. `catalog.api.requested`, `catalog.api.responded`, and `catalog.api.page.loaded` for compatibility pages
8. `catalog.external-merge.completed` or `catalog.load.completed`
9. `catalog.load.failed`

Catalog traces contain URLs, status codes, counts, and elapsed time. They never contain credentials or
extension configuration values.

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
