# TurenOS Memory

TurenOS Memory is a local, durable store for project knowledge that should survive individual Sessions. Agents use native TurenOS tools to retrieve and record decisions, facts, observations, preferences, constraints, and diagnosed failure causes. Memory is stored in TurenOS's SQLite database and remains independent of the transcript that produced it.

## Origin And Attribution

TurenOS's **wings, rooms, and drawers** organization is inspired by the original [MemPalace project](https://github.com/MemPalace/mempalace). MemPalace introduced the palace metaphor in which people and projects are wings, topics are rooms, and verbatim source content lives in drawers.

TurenOS is an independent implementation rather than an embedded copy or runtime dependency. The current TurenOS design differs in several important ways:

| TurenOS                                                                          | MemPalace                                                       |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Native tools in the TurenOS `ToolRegistry`                                       | MCP, CLI, and Python interfaces                                 |
| SQLite relational tables plus FTS5, with optional local Potion vectors           | Pluggable retrieval backends, with semantic retrieval available |
| Identifier-aware BM25 retrieval by default, with optional local hybrid retrieval | Semantic and hybrid retrieval                                   |
| Explicit agent or human writes                                                   | Conversation and file mining workflows are available            |
| Provenance and temporal validity on every drawer                                 | A broader palace, graph, diary, and memory-stack model          |
| Project wing derived from trusted TurenOS `Location`                             | User-configured and mined palace taxonomy                       |

The upstream project and its documentation remain the authoritative source for MemPalace itself:

- [MemPalace on GitHub](https://github.com/MemPalace/mempalace)
- [The Palace concepts](https://mempalaceofficial.com/concepts/the-palace.html)

## Data Model

```text
Wing: project, person, or engagement
  -> Room: a topic within the wing
    -> Drawer: one durable, verbatim claim
```

### Wings

A wing is the visibility boundary. Every drawer stores its `wing_id` directly, and every drawer read, search, list, update, or deletion names the wings it is allowed to access. An empty scope returns no data.

Native agent tools do not accept wing IDs from the model. TurenOS derives the project wing from the current `Location`:

- Locations with a stable TurenOS project identity use that identity.
- Non-Git directories and Git repositories whose identity cannot yet be resolved use a machine-local hash of the directory so unrelated directories do not share the global project wing.

### Rooms

Rooms organize a wing into topics such as `core`, `desktop`, `deployment`, or `quality-gate`. Room slugs are unique within a wing. Normal service writes verify that the selected room belongs to the selected wing.

### Drawers

A drawer stores:

- `kind`: `note`, `fact`, `decision`, or `observation`
- title and verbatim body
- optional repository-relative path and symbol anchors
- provenance: asserting agent or human, source, Session ID, and optional commit
- a temporal validity window
- an optional link to the drawer that superseded it
- creation and update timestamps

Bodies are stored verbatim. TurenOS does not summarize the only durable copy during ingestion.

## Temporal Claims

Facts and decisions can change. Supersession writes a new drawer and closes the previous drawer's validity window instead of overwriting history:

```text
old drawer: valid from T1 until T2, superseded by new drawer
new drawer: valid from T2, currently active
```

Normal search returns drawers valid at the requested point in time. Historical search can therefore answer what TurenOS believed before a later correction.

An administrative edit in Settings is different from supersession. It corrects the stored record in place and uses `timeUpdated` as an optimistic concurrency token so a stale form cannot overwrite a newer edit.

## Retrieval

The default retrieval backend is SQLite FTS5. It indexes title, body, repository-relative path components, path basename, and symbol.

The tokenizer emits whole identifiers and their components:

```text
sessionRunner  -> sessionrunner, session, runner
session_runner -> session_runner, session, runner
HTTPServer     -> httpserver, http, server
```

Queries are tokenized, deduplicated, bounded, and joined with `OR` so partial overlap can retrieve a drawer. Search then:

1. Removes corpus-wide terms that carry no useful BM25 ranking signal once the corpus is large enough.
2. Applies the allowed wing and optional room scope in SQL.
3. Applies temporal validity before limiting results.
4. Ranks matches with FTS5 `bm25()` and returns a higher-is-better score.

Lexical retrieval remains the baseline. Exact terms, identifiers, paths, symbols, and known vocabulary work best. Conceptual queries that share few terms with a drawer can opt into the local Potion hybrid path described below.

When `semantic_memory.enabled` is true in the server's global configuration, `memory_search` keeps FTS5 as its fallback and adds a local 256-dimensional Potion embedding index. The model is downloaded lazily into the TurenOS cache, verified against a pinned revision, and never sends memory text off-device. Drawer vectors are derived in-memory state rebuilt from the durable drawers; durable drawers, scope filtering, temporal validity, provenance, and FTS5 remain authoritative. Disable the setting to return to the zero-download lexical path. The cached model is retained for a future re-enable.

## Native Agent Tools

Memory is built into TurenOS; it is not an MCP integration.

| Tool            | Permission      | Purpose                                                         |
| --------------- | --------------- | --------------------------------------------------------------- |
| `memory_search` | `memory.read`   | Search the current project wing                                 |
| `memory_read`   | `memory.read`   | Read one scoped drawer by ID                                    |
| `memory_write`  | `memory.write`  | Write a durable project claim with agent and Session provenance |
| `memory_forget` | `memory.forget` | Permanently delete one scoped drawer                            |

The shared System Context instructs agents to search when prior decisions or constraints may matter, and to write only stable information likely to help a later Session. Agents should not store secrets, routine progress, transient state, or facts already maintained in source-controlled documentation.

Default and general agents receive the normal memory capabilities. Read-oriented specialist subagents such as Explore, Worker, Research, and Adversarial Review can search and read but cannot write or forget by default. Hidden utility agents do not receive memory access.

## Automations And Subagents

Loop occurrences and subagents create ordinary `SessionV2` Sessions and execute through the same location-scoped runner and `ToolRegistry` as interactive Sessions. They therefore use the same project memory tools and permission rules; there is no separate Loop memory database or MCP bridge.

Memory access remains explicit. TurenOS does not currently mine every transcript or automatically extract a memory after every turn.

## Settings

Open **Settings -> General -> Memory -> Manage** to inspect and administer memory.

The **Semantic memory** switch in the same section is off by default. Enabling it downloads approximately 30 MB of the Potion model and uses additional process memory for the derived vector index. The model cache is stored under the TurenOS cache directory and is retained when the switch is disabled. It is a server-owned setting, so the selected TurenOS server controls the model cache and retrieval behavior for its clients.

The manager supports:

- wing and room selection
- filtering the loaded drawer list
- creating human-authored drawers
- correcting drawers with optimistic concurrency
- permanently deleting drawers after confirmation

The Settings API is an owner-facing administrative surface over the server's memory store. Agent tools remain project-scoped even though Settings can navigate all known wings.

## HTTP API

```text
GET    /api/memory/wing
POST   /api/memory/wing
GET    /api/memory/room
POST   /api/memory/room
GET    /api/memory
POST   /api/memory
PATCH  /api/memory/:drawerID
DELETE /api/memory/:drawerID
```

The generated JavaScript SDK exposes these routes under `client.v2.memory`. The generated Promise and Effect clients expose the group as `memories`.

## SQLite Storage

The relational source of truth consists of:

```text
memory_wing
memory_room
memory_drawer
```

The rebuildable lexical index consists of:

```text
memory_drawer_fts
memory_drawer_fts_vocab
```

The FTS virtual tables are created idempotently when the Memory layer starts rather than through Drizzle migrations. This ensures fresh and upgraded databases take the same path. `Memory.reindex()` rebuilds the complete index transactionally from `memory_drawer`; no transcript replay is required.

When semantic memory is enabled, the pinned Potion model is cached under:

```text
<TurenOS cache directory>/memory-embeddings/potion-base-8M/<revision>/
```

The current semantic vectors are process-local derived state. They are rebuilt from the paginated durable drawers when a location's semantic service needs them and are discarded when that service closes.

TurenOS configures its database with WAL journaling, full synchronous writes, foreign keys, secure deletion, a busy timeout, and read-only query connections. On non-Windows platforms, TurenOS also applies owner-only `0600` permissions to the database, WAL, and shared-memory files.

The database path is channel-specific unless `FORGE_DB` overrides it:

```text
latest, beta, prod -> <TurenOS data directory>/forge.db
dev                -> <TurenOS data directory>/forge-dev.db
local              -> <TurenOS data directory>/forge-local.db
```

Use SQLite's read-only mode for manual inspection:

```bash
sqlite3 -readonly /path/to/forge-dev.db \
  "SELECT w.name, r.slug, count(d.id)
   FROM memory_wing w
   JOIN memory_room r ON r.wing_id = w.id
   LEFT JOIN memory_drawer d ON d.room_id = r.id
   GROUP BY w.id, r.id
   ORDER BY w.name, r.slug;"
```

Do not edit the FTS tables directly. Use the service operations or rebuild the index through `Memory.reindex()`.

## Limits

- Drawer title: 512 characters
- Drawer body: nominally 256,000 bytes
- Anchor path: 4,096 characters
- Anchor symbol: 512 characters
- Searchable query prefix: 32,000 characters; later input is ignored
- Search terms: 512 distinct terms
- Default search results: 10
- Maximum search results: 200
- Settings list: latest 200 matching drawers

The current body check is based on JavaScript string length rather than encoded UTF-8 byte length. Multi-byte text can therefore occupy more bytes than the nominal limit.

## Important Invariants

- Drawer and FTS writes, updates, and explicit deletion happen in one SQLite transaction.
- Drawer IDs are stable, allowing the lexical index to be rebuilt.
- Session provenance is not a foreign key; deleting a Session does not delete the memory it produced.
- Repository anchors are intended to be relative and portable. Native agent tools reject POSIX absolute and parent-traversing paths; stricter cross-platform validation at every administrative/import boundary remains hardening work.
- A normal read path cannot search every wing accidentally.
- FTS is secondary data. `memory_drawer` remains authoritative.

## Known Hardening Work

The current implementation is usable, but the following persistence work remains important before large multi-user deployments:

- Require supersession to close exactly one active predecessor or roll back the replacement.
- Replace timestamp-only optimistic concurrency with a monotonic revision.
- Prevent project deletion from cascading through durable memory.
- Ensure room, wing, and project cascades cannot leave orphaned FTS content.
- Add a database-level composite constraint for drawer room/wing ownership.
- Add indexes for management ordering and `superseded_by` cleanup.
- Enforce the body limit in encoded UTF-8 bytes.
- Enforce repository-relative, POSIX-normalized anchors in the shared schema and every administrative/import path.
- Persist the derived semantic vector index and add explicit model/index status and removal controls.
- Design durable reconciliation for a process crash after a memory mutation commits but before its tool result settles.

## Source

- [`packages/core/src/memory/index.ts`](../../packages/core/src/memory/index.ts)
- [`packages/core/src/memory/fts.ts`](../../packages/core/src/memory/fts.ts)
- [`packages/core/src/memory/semantic.ts`](../../packages/core/src/memory/semantic.ts)
- [`packages/core/src/tool/memory.ts`](../../packages/core/src/tool/memory.ts)
