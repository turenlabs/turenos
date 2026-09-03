# TurenOS Storage subsystem

Status: implemented on stable SQLite/WAL; Turso remains a gated candidate

## Product boundary

TurenOS-owned mutable durable state must be read and written through typed repositories backed by one Storage service. Declarative project configuration, rebuildable caches, telemetry, logs, operating-system bootstrap state, and data owned by external servers remain explicit non-authoritative stores.

The reference vertical slice is:

```text
typed scoped-state request
  -> bounded validation
  -> serialized transactional write
  -> concurrent reader snapshot
  -> compare-and-swap update
  -> restart with the committed value intact
```

The same Storage boundary owns security-integration settings, credentials, Desktop/App preferences, and the remaining TurenOS-owned durable application state.

## Current state

TurenOS has one Core SQLite database with WAL, typed Drizzle tables, ordered TypeScript migrations, one serialized writer, and four read-only readers by default. Existing typed tables store sessions, messages, parts, prompts, projects, workspaces, permissions, accounts, events, and related execution state. The `storage_state` table adds scoped values, revisions, compare-and-swap, and atomic import receipts for TurenOS-owned state that does not yet warrant a dedicated relational table.

The Storage boundary now owns:

- Desktop/App scoped preferences reached through `platform.storage` and the root-authenticated sidecar API.
- Security-integration enablement and declared secrets through reserved internal repositories.
- Provider authentication and durable MCP OAuth credentials through reserved internal repositories.
- Desktop model favorites, variants, session pins, and scoped state through the generated SDK.
- Idempotent import receipts for Electron and security-config imports. Provider and MCP credential files are removed after their encrypted destination is verified.

The duplicate legacy `session_diff` JSON write has been removed from the runtime; turn diffs already live in typed session-message summaries. The old filesystem Storage module remains only for compatibility/error types and recovery tests, not as product-state authority.

Durable state intentionally outside Storage is limited to user-authored configuration, external-system authority, rebuildable caches, logs/telemetry, and filesystem snapshots/blobs. Desktop has no mutable product-state exception before the sidecar: windows restore only after Storage is ready.

### Desktop startup ownership

The Desktop main process uses `desktop/store/product-state-v1` for the default server URL, onboarding completion and legacy-layout eligibility, WSL server definitions, pinch zoom, window IDs and geometry, updater readiness, and each window's last active route. Renderer scoped application state continues through the bounded `platform.storage` bridge. The generic renderer bridge rejects reserved typed stores such as `forge.settings` and `forge.updater` so state cannot acquire a second owner.

| Pre-sidecar value                                                    | Durable   | Authority                   | Reason                                                                                                                                                        |
| -------------------------------------------------------------------- | --------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron app ID and `userData` path                                  | No        | Build/channel configuration | Required to locate the sidecar database; not user product state.                                                                                              |
| Loopback port and Basic Auth password                                | No        | Current process             | Random ephemeral connection material for the child sidecar.                                                                                                   |
| Proxy, CA, and process environment                                   | External  | Operating system/runtime    | Runtime bootstrap input; never copied into product Storage.                                                                                                   |
| Legacy Electron, window-state JSON, and renderer localStorage values | Read-only | Import input only           | Versioned, fingerprinted, destination-wins imports retain the source unchanged. A read failure records no receipt.                                            |
| Legacy Tauri `.dat` values                                           | Read-only | Import input only           | Read directly and merged beneath any Electron value before the same typed Storage import; no Electron staging copy or `tauriMigrated` file marker is written. |
| Existing-install directory observation                               | No        | One-time importer           | Captured as `old-layout-eligible` in the same atomic settings import.                                                                                         |

The sidecar announces readiness, completes database migrations, and accepts typed imports before WSL startup, updater scheduling, or window restoration begins. Geometry writes are flushed before the sidecar is stopped. Legacy draft and workspace files are retained regardless of age, emptiness, or count; startup no longer runs the old destructive cleanup pass. No `electron-store`, `electron-window-state`, Tauri marker, or renderer `localStorage` value remains an active main-process product-state authority. Desktop language bootstrap explicitly uses the async Storage-backed locale source.

## Ownership rules

Storage owns authoritative TurenOS domain state:

- Existing Core SQL state.
- Security-integration desired state and secrets.
- Provider authentication and durable MCP OAuth credentials, preserving existing precedence and redaction rules.
- Durable application preferences that are not required before a TurenOS server is available.
- Desktop user state. Session diffs remain in their existing typed session-message projection without a duplicate scoped value.
- Import receipts, schema migrations, and state revisions.

Storage does not absorb:

- Repository and user-authored `forge.json` / `forge.jsonc` configuration.
- Rebuildable security databases, downloaded binaries, scanner caches, model caches, or temporary files.
- Git snapshot objects and full tool-output payloads. Storage owns typed metadata and retention references for these blobs, while payload bytes remain in a blob/filesystem backend.
- Logs, traces, metrics, crash reports, or other telemetry.
- Remote provider or control-plane state for which TurenOS is only a client.
- Window/process bootstrap state required before the Storage service can start. These values must be minimal, explicitly enumerated, and never treated as domain authority.

## Runtime contract

The Storage service exposes typed domain repositories, not renderer-accessible SQL.

- One serialized write lane owns migrations and mutations.
- A bounded read pool serves concurrent reads after migrations finish.
- Write transactions use one connection from begin through commit or rollback.
- Reader transactions provide one consistent snapshot.
- Foreign keys are enabled on every connection.
- WAL is the production journal mode. Turso MVCC is not enabled while its indexed-database compatibility remains experimental.
- Every mutation that can race a background job carries a persisted revision or generation.
- Domain events are published only after commit.
- Callers never infer persistence from an optimistic UI update.

The initial pool target is one writer and four readers. The pool size is configurable for tests but bounded in production.

## Turso compatibility decision

`@tursodatabase/database` remains a candidate backend, not the default driver. The 0.7.0 compatibility spike passed TurenOS's current schema, indexes, foreign keys, WAL reads, savepoints, rollback, Drizzle CRUD/joins/RETURNING, and a one-writer/two-reader snapshot test on macOS arm64. Promotion is blocked by distribution and lifecycle gaps:

- Bun-compiled TurenOS sidecars cannot load the dynamic native addon.
- Published native packages do not cover TurenOS's macOS x64, Windows arm64, or Linux musl release targets.
- The WASM package is browser OPFS-only and cannot open TurenOS's filesystem database.
- A writable open of an existing SQLite file needs a guarded WAL-sidecar transition.
- The upstream Drizzle transaction wrapper does not reserve the shared connection; TurenOS must retain its own serialized writer and transaction reservation.

TurenOS therefore delivers the multiple-reader benefit first with its existing stable SQLite/WAL driver behind the Storage boundary. A future Turso adapter must be opt-in, use an isolated copied database, retain the original database for rollback, pass the full matrix below, and fail closed on unsupported packages. No silent fallback may occur after the candidate backend has accepted writes.

Upstream references:

- <https://github.com/tursodatabase/turso>
- <https://github.com/tursodatabase/turso/blob/main/COMPAT.md>
- <https://github.com/tursodatabase/turso/blob/main/docs/manual.md>
- <https://docs.turso.tech/sdk/ts/orm/drizzle>

## Migration contract

1. Acquire the process-global migration lock.
2. Open the writer only.
3. Apply the existing Core migration journal and new Storage migrations transactionally.
4. Import each legacy store through a named, versioned importer.
5. Record the importer name, source fingerprint, source revision, and completion time in the database in the same transaction as imported rows.
6. Re-running an importer with the same fingerprint is a no-op.
7. A changed legacy source after a completed import is a conflict unless the importer explicitly defines reconciliation.
8. Open the read pool only after schema and import completion.
9. Delete or archive legacy files only after database verification and only when rollback policy permits it.

An interrupted import must leave either no imported rows or a complete import receipt. A retry must never duplicate scoped state, preferences, credentials, or integration state.

## Integration invariants

- Storage is authoritative for enabled security-integration IDs and secret values.
- Public status exposes secret names and set/unset booleans only.
- Secrets never appear in logs, errors, config responses, renderer caches, or migration receipts.
- The security MCP process receives the minimum environment needed for its enabled integrations at spawn time.
- Disabling an integration prevents new tool use after the committed revision and does not silently re-enable from stale config.
- Declarative MCP configuration remains file-backed; TurenOS-managed integration state must not be written back as user-authored configuration.
- Agent integrations with no persisted state remain explicitly empty rather than gaining placeholder database rows.

## Credential invariants

- Environment-provided credentials remain external runtime authority and are never silently copied into Storage.
- Imported provider and MCP credentials preserve source identity and precedence.
- OAuth attempts and verifier state remain ephemeral unless an explicit crash-resume protocol is added; refresh/access credentials are durable.
- Secret-bearing repository methods are not exposed through generic state or renderer endpoints.
- Database, WAL, backup, and import-source permissions are owner-only where the operating system supports POSIX modes.

## Scoped state invariants

- Global, server, device, workspace, session, window, and draft scopes are distinct and encoded canonically.
- Remote-server state remains authoritative on that remote server and is never silently copied into the local database.
- A window or draft delete cannot remove another window, draft, workspace, or server scope.
- State mutations use compare-and-swap revisions when two readers can write the same key.

## Concurrency and failure tests

Required deterministic coverage:

- Fresh database migration.
- Upgrade from the current SQLite schema with representative session data.
- Repeated and interrupted legacy imports.
- Four concurrent readers while the writer commits scoped-state and session mutations.
- Reader snapshot consistency across a concurrent commit.
- Busy/conflict handling without hidden retries that replay stale intent.
- Conflicting compare-and-swap mutations preserve the committed winner.
- Disable-integration versus MCP spawn.
- Database open, migration, commit, and checkpoint failures.
- Process restart after commit and after an interrupted import.
- Desktop restart showing persisted product state and integration status.
- Cross-platform native-module packaging for macOS, Windows, and Linux.

## Cutover and rollback

The Turso backend must pass the full existing Core database suite and the new Storage contract suite before it becomes the default. The previous SQLite driver remains selectable during the cutover window and must be able to open the same verified database file. No migration may depend on a Turso-only file-format feature during that window.

Rollback changes the driver, not the authoritative data. A failed import leaves legacy input intact. A failed backend initialization must fail closed with an actionable error; it must not create a second empty database.

## Delivery gates

- Storage backend contract and reader-pool tests pass.
- Fresh and upgrade migrations pass on both the rollback driver and Turso.
- Security integration state and secrets run through reserved typed Storage repositories.
- Provider and MCP credentials run through reserved typed Storage repositories.
- Desktop/App mutable scoped state runs through the public bounded Storage API.
- Remaining mutable TurenOS-owned durable state is inventoried and either migrated or explicitly classified outside Storage ownership above.
- A fresh adversarial review has no unresolved P0/P1 findings.
- Schema, Core, TurenOS runtime, SDK, App, and Desktop typechecks/tests pass.
- A packaged or development Desktop restart proves the user-visible persistence flow.
