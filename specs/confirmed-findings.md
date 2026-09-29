# Confirmed findings

Status: design, not implemented

## Problem

An agent that finds and confirms a vulnerability in a project has nowhere durable to put it. The handoff engineering needs is: what is wrong, where, at which commit, how to reproduce it, a working proof of concept, and whether it has been fixed. Today there is no project-level record with a lifecycle for that:

- Memory (`packages/schema/src/memory.ts`) has `note`, `fact`, `decision`, and `observation` drawers with repo/path/commit/symbol anchors (`packages/core/src/memory/sql.ts`), but no severity, status, or attachments. `memory_search` is an explicit, permission-checked search over the current project, so a PoC stored there would be returned to any later task in the same project that searches for related terms.
- Team board notes (`packages/schema/src/team-board.ts`, `evidence`) and swarm room entries (`packages/schema/src/swarm-room.ts`, `evidenceRefs`) have a `finding` kind but are scoped to one run's root Session.
- Scanner results from the security MCP (`packages/forge/src/security/types.ts`) are retained only as ordinary tool output in session history and the tool-output store. There is no per-project finding record or triage state.

Confirmed findings gives a manually confirmed vulnerability a durable, per-project record with a human-owned status and a sealed PoC that no agent tool returns.

## Non-goals

Two earlier workbenches with their own finding tables were removed: the reversing workbench (`20260822133903_remove-reversing-workbench`: cases, findings, evidence) and the pentest workbench (`20260911132133_remove-pentest`: runs, executions, HTTP sessions, findings, evidence, reports, model usage). This design must not grow back into either.

- No runs, orchestration, swarm integration, HTTP session capture, or report generation beyond exporting one finding.
- No scanner output. Recording scanner results is the findings ledger's job (`specs/findings-ledger.md`, shelved, in the `findings-ledger` worktree).
- No sync, sharing, or multi-user triage. Findings are a local working record for one install.
- No PoC execution by TurenOS, and no agent read access to stored PoCs, in v1.
- No deployed targets (URLs, hosts), and no findings outside a Git repository. v1 findings are about code in the project repository.
- No direct export to GitHub issues or advisories.
- No binary PoC attachments. v1 attachments are UTF-8 text.
- No protection against code running as the same OS user. See Threat model.

## Decisions

| Question                       | Decision                                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Separate domain or memory kind | Separate Core domain. Memory has no lifecycle, and memory search would return PoCs to later tasks in the project. |
| Agent read access to PoCs      | None in v1. No tool returns PoC content, whatever permission settings are.                                        |
| PoC storage                    | Sealed with the existing secret vault (`SecretVault.sealBytes`). Other fields are plaintext.                      |
| Export                         | Markdown only (clipboard or file). GitHub private security advisories later; public issues never.                 |
| Target                         | Code only: a Git-backed project, a commit, repository-root-relative paths.                                        |
| Who changes status             | Humans, through authenticated API routes. No agent tool changes status. Agents draft findings and append notes.   |
| Scope                          | Per project (`project.id`), enforced on every lookup. The global non-Git project is rejected.                     |
| Threat model                   | Agents acting through supported tools. Same-user code execution and direct database access are out of scope (v1). |

## Threat model

v1 guarantees that **no supported agent tool performs a human action**: confirming, transitioning, editing a non-draft finding, changing PoCs after drafting, deleting, reading PoC content, or exporting. That holds whatever the permission configuration, because none of those operations exists as a tool.

It does not guarantee that a human performed an API call. Anything running as the same OS user can bypass the server:

- An approved shell or PTY command, a local MCP server, or an in-process plugin (which receives an authenticated client, `packages/forge/src/plugin/index.ts`) runs with the user's authority.
- The SQLite database is owner-writable, so such a process can change plaintext rows directly without the vault key.
- A loopback server may run with no password, in which case the authorization middleware passes every request (`packages/forge/src/server/routes/instance/httpapi/middleware/authorization.ts`, `authorizationLayer`).

The findings routes therefore **require server authentication even on loopback**: when no server password is configured, every findings route fails closed with an explanatory error instead of inheriting the pass-through. The desktop sidecar always configures a password, so the app is unaffected. This keeps an unauthenticated local process, including one an agent launches, from calling the routes on a passwordless `forge serve`. It does not stop a same-user process that can read the password from memory or edit the database. Containment of agent execution is a separate design.

Actor, session, and project on every event are derived from the invocation context (tool context for agents, the authenticated route for humans), never from request fields.

### Why human actions are routes, not asked tools

`PermissionV2` turns every `ask` into `allow` when permission checks are disabled (`packages/core/src/permission.ts`, the `checks.enforced()` branch), and an `always` reply saves a rule for later calls. A tool gated only by a permission ask provides no guarantee for users who disable checks, so human actions are not tools at all.

## Architecture

- Wire contracts in `packages/schema/src/finding.ts`.
- A Core domain in `packages/core/src/finding/`: Drizzle tables, a Location-scoped service, and the agent tools registered through `Tools.Service`.
- Endpoint contracts in `packages/protocol/src/groups/finding.ts` and handlers in `packages/server/src/handlers/finding.ts`, following the `memory` group. Not only in the legacy Forge route tree. Regenerate `packages/client` with `bun run generate`.

`agent_improvement_proposal` (`packages/core/src/agent/improvement.sql.ts`) is precedent for durable agent-authored records with revisions. It is not precedent for a human-only boundary: agents can adjudicate and apply those proposals through tools (`packages/core/src/tool/agent-improvement.ts`).

All mutations follow the Storage contract (`specs/storage.md`): one serialized transaction per mutation, consistent reader snapshots, events published after commit.

## Data model

Snake_case Drizzle columns. Timestamps are epoch milliseconds. All tables cascade on project delete. Every limit below is enforced in the Core service as well as the wire schema, and measured in UTF-8 bytes.

### `finding`

Current state of one finding.

| Column              | Notes                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------- |
| `id`                | ascending ID, `fnd_` prefix                                                             |
| `project_id`        | FK `project.id`, cascade delete; never the global project                               |
| `title`             | single line, 1..256 bytes                                                               |
| `severity`          | `critical`, `high`, `medium`, `low`, `info`                                             |
| `cwe`               | nullable, `CWE-<n>`                                                                     |
| `summary`           | what is wrong, 1..16 KiB                                                                |
| `impact`            | what an attacker gains, up to 16 KiB                                                    |
| `repro_steps`       | ordered steps, 1..64 KiB                                                                |
| `locations`         | JSON array, max 50, of `{ path, start_line?, end_line?, symbol? }` (below)              |
| `draft_commit`      | commit of the Location's repository when drafted, set by the server                     |
| `draft_dirty`       | boolean; the working tree had uncommitted changes when drafted                          |
| `status`            | see Status                                                                              |
| `source`            | `agent` or `human` (who created it)                                                     |
| `author_session_id` | nullable, set null on session delete                                                    |
| `revision`          | integer, bumped by every mutation including PoC changes; compare-and-swap on all writes |
| `deleted`           | boolean tombstone; see Deletion                                                         |
| `time_created`      |                                                                                         |
| `time_updated`      |                                                                                         |

`locations[].path` is repository-root-relative (the same convention as memory's `anchor_path`), at most 1 KiB, normalized, with no `..` segments, no absolute paths, and no NUL. `symbol` is at most 256 bytes. `start_line <= end_line`, both positive. Paths are labels in v1; nothing reads files through them.

### `finding_event`

Append-only history. Rows are never updated or deleted except by project cascade.

| Column         | Notes                                                                           |
| -------------- | ------------------------------------------------------------------------------- |
| `id`           | ascending ID                                                                    |
| `finding_id`   | FK `finding.id`                                                                 |
| `revision`     | the finding revision this event produced; unique with `finding_id`              |
| `type`         | `created`, `edited`, `status`, `note`, `poc_added`, `poc_removed`, `deleted`    |
| `actor`        | `agent` or `human`, from invocation context                                     |
| `session_id`   | nullable; agent events record the session                                       |
| `from_status`  | nullable, for `status` events                                                   |
| `to_status`    | nullable, for `status` events                                                   |
| `body`         | reason, note text, or edit summary, up to 16 KiB, plain text                    |
| `commit`       | nullable; the commit a note or status change refers to                          |
| `attestation`  | nullable JSON, for confirmation and verification events only (see Confirmation) |
| `time_created` |                                                                                 |

Agent notes are limited to 200 per finding. There is no user identity column in v1; add one when multi-user exists rather than storing a constant.

### `finding_poc`

Zero to ten PoC attachments per finding, enforced inside the mutation transaction.

| Column         | Notes                                                                            |
| -------------- | -------------------------------------------------------------------------------- |
| `id`           | ascending ID                                                                     |
| `finding_id`   | FK `finding.id`                                                                  |
| `filename`     | sanitized basename, 1..128 bytes, no path separators, no control characters      |
| `bytes`        | plaintext size computed by the server, at most 256 KiB                           |
| `sha256`       | hex digest of plaintext computed by the server                                   |
| `sealed`       | `SecretVault.sealBytes("finding-poc", "<finding_id>/<poc_id>", content)`         |
| `source`       | `agent` or `human`, from invocation context                                      |
| `removed`      | boolean; removal hides the attachment, keeps the row for history and attestation |
| `time_created` |                                                                                  |

Content must be valid UTF-8. There is no stored media type; downloads are always served as `text/plain; charset=utf-8` attachments.

The vault derives a key per scope and binds scope and key as AES-GCM additional data, so a sealed value copied onto another finding's row fails to open. 256 KiB fits in one sealed value under the vault's 1 MiB limit.

PR #172 (closed, unmerged) proposed a startup check that opens one sealed value from every table holding vault envelopes, and noted that a table missing from its list is never checked. If that check or a successor lands, `finding_poc` must be registered in it.

### Deletion

Deleting a finding is human-only and soft: it sets `deleted`, drops the sealed content of its PoCs, and records a `deleted` event. The finding and its history remain for the audit trail and are hidden from default lists. Hard deletion happens only through project cascade. Deleting a row does not erase copies in transcripts, exports, or backups.

## Status

```text
draft -> confirmed -> fixed -> verified_fixed
confirmed -> reported -> fixed
draft | confirmed | reported -> rejected
fixed | verified_fixed | rejected -> confirmed   (reopen)
```

- Every transition is human-only, requires a reason and the current `revision`, and is recorded as a `status` event in the same transaction that updates the row.
- `reported` is optional, for findings handed to another team.
- `fixed` and `verified_fixed` require a commit.

### Confirmation

Confirming binds the human decision to exactly what was reviewed. The `status` event's `attestation` records:

- the finding `revision` the human was looking at (the request fails if it has moved),
- the IDs and `sha256` of every non-removed PoC at that revision,
- the commit the human confirms against. It defaults to `draft_commit`, and a draft with `draft_dirty` set cannot be confirmed until the human supplies a commit.

Confirmation requires non-empty `repro_steps` and at least one PoC, or an explicit human reason recorded for why there is none.

`verified_fixed` records the same attestation against the fixed commit, meaning a human re-ran the reproduction there.

A human edit to `summary`, `impact`, `repro_steps`, `locations`, or PoCs after confirmation is recorded as `edited` and marks the attestation stale in the UI until the human re-confirms. Title, severity, and CWE edits do not.

## Agent tools

Registered as Location-scoped built-ins with normal permission handling. The service resolves the project from the Location, rejects the global project, and filters every ID lookup by that project.

- `finding_draft`: creates a `draft` with its PoC attachments in one call. The server fills `draft_commit` and `draft_dirty` from the Location's repository. Returns the finding ID. There is no later tool for adding PoCs; a human adds them through the UI.
- `finding_list`: at most 50 results per page with a cursor, filtered by status, severity, and path prefix. Metadata only.
- `finding_read`: one finding with its locations, repro steps, and the latest 50 events, with a cursor for older ones. Each PoC appears only as `{ id, filename, bytes, sha256, source }`.
- `finding_note`: appends a `note` event, optionally with a commit, for example "no longer reproduces at `<sha>`".

Findings enter model context only through these tools. They are not an automatic context source and are not indexed by memory search.

Text returned by `finding_read` is untrusted evidence, including after human confirmation. Confirmation validates a vulnerability claim, not any instructions embedded in its text.

### Interaction with secret-safe tool output

Open PR #142 (`specs/secret-output-guard.md` on `secret-output-guard`) masks supported credential formats in tool output as `[SECRET:v1:<rule>:<fingerprint>]` references. It is not general data-loss prevention: unknown formats and encodings pass through. Consequences here:

- `finding_read` output passes through that guard like any tool output. Credentials in narrative fields may be masked for the model; that is best effort, not a confidentiality guarantee for those fields.
- An agent that saw a credential only in masked form will copy the reference, not the value, into a PoC, which then fails. `finding_draft` and `finding_note` reject input using #142's `containsPlaceholder` (it matches `[SECRET:v1`, including truncated markers), rather than a separate check.

## Disclosure contract

| Data                                       | Stored    | Agent tools return | Human UI and export |
| ------------------------------------------ | --------- | ------------------ | ------------------- |
| PoC content                                | sealed    | never              | yes                 |
| Title, summary, impact, repro steps, notes | plaintext | yes                | yes                 |
| Locations, commits, status, event metadata | plaintext | yes                | yes                 |
| PoC metadata (filename, bytes, sha256)     | plaintext | yes                | yes                 |

Narrative fields are model-readable by design, so repro steps must not contain live credentials: a PoC should take credentials from the operator's environment or use synthetic ones. The UI says so on the draft and confirm forms.

Sealing protects only the attachment envelope. It does not protect:

- the drafting session's own history, which contains the `finding_draft` arguments, including PoC content;
- files an agent wrote while developing the PoC;
- exports, and earlier backups or transcripts containing plaintext copies.

Sensitive-path handling:

- Validation and decryption errors on findings routes carry no request content. The existing schema-error middleware includes up to 1 KiB of the rejection reason in the response and logs (`packages/forge/src/server/routes/instance/httpapi/middleware/schema-error.ts`), so findings routes that accept PoC content or narrative must use content-free errors. A test must submit an invalid PoC containing a marker and assert the marker appears in no response or log line.
- No request or response body from findings routes is logged.
- PoC download and export responses set `Cache-Control: no-store` and `Content-Disposition: attachment`, with `X-Content-Type-Options: nosniff`.
- Export is treated as a PoC read: human-only, authenticated, and recorded as an event.

## HTTP API and UI

Routes in the Protocol `finding` group, all requiring authentication (see Threat model), all scoped by project:

- list findings; get a finding with a page of events and PoC metadata
- create a finding (human-authored)
- edit a finding (compare-and-swap on `revision`)
- transition status (reason required; attestation for confirmation and verification)
- add or remove a PoC (compare-and-swap on `revision`); download a PoC
- delete a finding (soft)
- export a finding as markdown

Minimal UI: a findings panel per project with status and severity filters, a detail view with the event timeline, and the status actions. Anything written by an agent is labelled as such, and a stale attestation is shown on the finding.

PoC content is shown as escaped plain text in a monospace block, or offered as a download. There is no run button. No agent- or repository-controlled field is rendered as markdown or HTML in the UI.

## Export

Export writes one consistent snapshot of a finding (a single read transaction) as markdown for engineering. The report structure is generated by TurenOS; every field inside it is untrusted:

- Title, severity, CWE, status, commits, and locations are escaped as literal inline text, so they cannot produce links, images, HTML, or headings. Newlines in single-line fields are rejected at input.
- Summary, impact, repro steps, and notes are emitted as fenced blocks, as are PoCs.
- Each fence is backticks of length `max(3, longest backtick run in the content + 1)`, starts and ends on its own line, and has no info string derived from input.
- The export header states that it contains working exploit material.

Tests run exports containing HTML, remote image and link syntax, backtick runs, and multi-line titles through the markdown parser used for verification and assert no active element is produced.

## Security properties

- **No agent tool performs a human action**, independent of permission settings. Human actions are authenticated routes that fail closed without a server password. Same-user code execution is out of scope; see Threat model.
- **Stored PoCs are not returned to the model** by any tool. See Disclosure contract for what sealing does not cover.
- **Human confirmation is bound to evidence**: a specific revision, PoC digest set, and commit.
- **Repository-steered drafts.** A hostile repository can steer an agent into drafting a fake finding or attaching a destructive "PoC" that a human later runs. Drafts are inert until confirmed, agent authorship is always visible, TurenOS never executes PoCs, and finding text stays untrusted after confirmation.
- **Project identity is grouping, not trust.** A project ID can be derived from repository configuration, and fresh clones of the same remote converge on it (`packages/core/src/project.ts`). A hostile repository claiming a known remote would see that project's findings through the agent tools. Opening a repository is already a trust decision; the UI shows which project a finding belongs to.
- **History is append-only**, and every row change emits an event in the same transaction.
- **No public disclosure path.** v1 export is local markdown only.
- **Bounded storage and responses**: byte limits on every field, per-finding caps on PoCs and agent notes, and paginated reads.

## Rollout

1. Schema contracts, Core tables, migration, and service. Tests: status machine, attestation and staleness, compare-and-swap on edits and PoC changes, attachment and note caps under concurrency, soft delete, cascade, project predicates on every lookup (cross-project IDs, global project rejected, two worktrees of one repository), seal/open round trip, and cross-row seal swap failing.
2. Agent tools. Tests: no tool output contains PoC bytes; no tool can change status, including with permission checks disabled; placeholder rejection; pagination bounds.
3. Protocol group, server handlers, generated client, and UI panel. Tests: every route fails closed without a server password; no content in validation errors or logs; response headers; an agent shell command against a passwordless loopback server is refused.
4. Markdown export with the escaping and fence tests above.

Later, not in this design:

- A human-started re-verification session that deliberately passes a PoC to an agent.
- Promoting a findings-ledger scanner finding into a confirmed finding.
- GitHub private security advisory export.
- Deployed targets (URLs, hosts) using the memory `engagement` wing as precedent.
- Containment of agent execution, which would allow a stronger human-only guarantee.

## Open questions

- Whether `finding_draft` should refuse drafting on a dirty working tree, rather than requiring a commit at confirmation.
- Retention for `rejected` and deleted findings, once the deletion contract has been used in practice.
