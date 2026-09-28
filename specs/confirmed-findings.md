# Confirmed findings

Status: design, not implemented

## Problem

An agent that finds and confirms a vulnerability in a project has nowhere durable to put it. The handoff engineering needs is: what is wrong, where, at which commit, how to reproduce it, a working proof of concept, and whether it has been fixed. Today that lands in one of three places, none of which fits:

- Memory (`packages/schema/src/memory.ts`) has `note`, `fact`, `decision`, and `observation` drawers. There is no severity, status, or attachment, and `memory_search` injects entries into unrelated sessions by relevance, which is exactly where a working exploit must not go.
- Team board and swarm room notes (`packages/schema/src/team-board.ts`, `swarm-room.ts`) have a `finding` kind and an `evidence` field, but they are scoped to one run's root Session.
- Scanner `Finding` values (`packages/forge/src/security/types.ts`) are shown to the model and discarded.

Confirmed findings gives a manually confirmed vulnerability a durable, per-project record with a human-owned status and a PoC stored sealed, never returned to the model.

## Non-goals

Two earlier workbenches with their own finding tables were removed: the reversing workbench (`20260822133903_remove-reversing-workbench`: cases, findings, evidence) and the pentest workbench (`20260911132133_remove-pentest`: runs, executions, HTTP sessions, findings, evidence, reports, model usage). The pentest one was dropped as over-scoped. This design must not grow back into either.

- No runs, orchestration, swarm integration, HTTP session capture, or report generation beyond exporting one finding.
- No scanner output. Recording scanner results is the findings ledger's job (`specs/findings-ledger.md`, shelved, in the `findings-ledger` worktree).
- No sync, sharing, or multi-user triage. Findings are a local working record for one install.
- No PoC execution by TurenOS, and no agent read access to stored PoCs, in v1.
- No deployed targets (URLs, hosts). v1 findings are about code in the project repository.
- No direct export to GitHub issues or advisories.

## Decisions

| Question                       | Decision                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Separate domain or memory kind | Separate Core domain. Memory search would pull PoCs into context, and memory has no status lifecycle.        |
| Agent read access to PoCs      | None in v1. No tool returns PoC content, whatever permission settings are.                                   |
| PoC storage                    | Sealed with the existing secret vault (`SecretVault.sealBytes`).                                             |
| Export                         | Markdown only (clipboard or file). GitHub private security advisories later; public issues never.            |
| Target                         | Code only: project, commit, affected paths.                                                                  |
| Who changes status             | Humans only, through the HTTP API. Agents draft findings and append notes, including "looks fixed" evidence. |
| Scope                          | Per project (`project.id`).                                                                                  |

## Architecture

A Core domain in `packages/core/src/finding/` with Drizzle tables, a typed Location-scoped service, and agent tools registered through `Tools.Service` alongside the other built-ins. Human-only operations are HttpApi routes on the instance server, generated into `packages/client` with `bun run generate`. Public wire contracts live in `packages/schema/src/finding.ts`. This follows the Schema -> Core/Protocol -> Server dependency direction.

The agent-proposes, human-decides split follows the precedent of `agent_improvement_proposal` (`packages/core/src/agent/improvement.sql.ts`), with one difference: here no agent tool can move a finding out of `draft`, not even behind a permission ask.

### Why human-only operations are routes, not asked tools

`PermissionV2` turns every `ask` into `allow` when permission checks are disabled (`packages/core/src/permission.ts`, the `checks.enforced()` branch), and an `always` reply saves a rule for later calls. A tool gated only by a permission ask therefore provides no guarantee for users who disable checks. Confirming, transitioning, deleting, and reading PoC content are not agent tools at all.

## Data model

Snake_case Drizzle columns. Timestamps are epoch milliseconds. All tables cascade on project delete.

### `finding`

Current state of one finding.

| Column              | Notes                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------- |
| `id`                | ascending ID, `fnd_` prefix                                                           |
| `project_id`        | FK `project.id`, cascade delete                                                       |
| `title`             | 1..256 chars                                                                          |
| `severity`          | `critical`, `high`, `medium`, `low`, `info`                                           |
| `cwe`               | nullable, `CWE-<n>`                                                                   |
| `summary`           | what is wrong, 1..16 KiB                                                              |
| `impact`            | what an attacker gains, up to 16 KiB                                                  |
| `repro_steps`       | ordered steps, up to 64 KiB                                                           |
| `locations`         | JSON array of `{ path, start_line?, end_line?, symbol? }`, workspace-relative, max 50 |
| `commit`            | commit SHA the finding was confirmed against                                          |
| `dirty`             | boolean; working tree had uncommitted changes when drafted                            |
| `status`            | see Status                                                                            |
| `source`            | `agent` or `human` (who created it)                                                   |
| `author_session_id` | nullable, set null on session delete                                                  |
| `revision`          | integer, bumped on every change; used for compare-and-swap                            |
| `time_created`      |                                                                                       |
| `time_updated`      |                                                                                       |

### `finding_event`

Append-only history. Rows are never updated or deleted except by project cascade.

| Column         | Notes                                                             |
| -------------- | ----------------------------------------------------------------- |
| `id`           | ascending ID                                                      |
| `finding_id`   | FK `finding.id`, cascade delete                                   |
| `type`         | `created`, `edited`, `status`, `note`, `poc_added`, `poc_removed` |
| `actor`        | `agent` or `human`                                                |
| `session_id`   | nullable; agent events record the session                         |
| `from_status`  | nullable, for `status` events                                     |
| `to_status`    | nullable, for `status` events                                     |
| `body`         | reason, note text, or edit summary, up to 16 KiB, plain text      |
| `commit`       | nullable; the commit a note or status change refers to            |
| `time_created` |                                                                   |

There is no user identity column in v1. The only human writer is the authenticated local user through the HTTP API. Add a user column when multi-user exists rather than storing a constant.

### `finding_poc`

Zero or more PoC attachments per finding.

| Column         | Notes                                                                    |
| -------------- | ------------------------------------------------------------------------ |
| `id`           | ascending ID                                                             |
| `finding_id`   | FK `finding.id`, cascade delete                                          |
| `filename`     | sanitized basename, 1..128 chars, no path separators                     |
| `media_type`   | declared type, informational only                                        |
| `bytes`        | plaintext size, at most 256 KiB                                          |
| `sha256`       | hex digest of plaintext                                                  |
| `sealed`       | `SecretVault.sealBytes("finding-poc", "<finding_id>/<poc_id>", content)` |
| `source`       | `agent` or `human`                                                       |
| `time_created` |                                                                          |

The vault derives a key per scope and binds scope and key as AES-GCM additional data, so a sealed value copied onto another finding's row fails to open. The 256 KiB cap sits well under the vault's 1 MiB value limit, so each PoC is one sealed value (no chunking). At most 10 PoCs per finding.

`finding_poc.sealed` is a new table holding vault envelopes. Open PR #172 adds `VaultVerification` (`packages/core/src/database/vault-verification.ts`), which checks every listed store before startup and states that a store missing from its list is never checked. Whichever lands second must add `finding_poc` to that list with scope `finding-poc` and key `<finding_id>/<id>`.

## Status

```text
draft -> confirmed -> reported -> fixed -> verified_fixed
draft | confirmed -> rejected
fixed | verified_fixed | rejected -> reopened -> confirmed
```

- Every transition is human-only and requires a reason, recorded as a `status` event.
- `fixed` and `verified_fixed` require a commit. `verified_fixed` means a human re-ran the reproduction against that commit.
- Edits to a non-draft finding are human-only and recorded as `edited` events with a summary of the changed fields.
- Transitions use `revision` for compare-and-swap, so two UI tabs cannot silently overwrite each other.

## Agent tools

Registered as Location-scoped built-ins. Normal permission handling applies to all of them; none of them can change status.

- `finding_draft`: creates a `draft` finding with optional PoC attachments. The server fills `commit` and `dirty` from the Location's repository, not from agent input. Returns the finding ID.
- `finding_list`: bounded list with filters on status, severity, and path prefix. Returns metadata only.
- `finding_read`: returns one finding with its locations, repro steps, and event history. Each PoC appears only as `{ id, filename, bytes, sha256, source }`.
- `finding_note`: appends a `note` event, optionally with a commit. This is how an agent reports "no longer reproduces at `<sha>`".

An agent may attach PoCs to a `draft` it authored in the same session. After that, PoC changes are human-only.

There is no agent tool to confirm, transition, edit a non-draft, delete, or read PoC content, and none is added when permission checks are disabled.

`finding_list` and `finding_read` are not wired into memory search or any automatic context source. Findings enter model context only when an agent calls these tools.

### Interaction with secret-safe tool output

Open PR #142 (`specs/secret-output-guard.md` on `secret-output-guard`) masks credentials in tool output as `[SECRET:v1:<rule>:<fingerprint>]` references. Two consequences:

- `finding_read` output passes through that guard like any tool output, so credentials in repro steps are masked for the model. The stored finding keeps the original text and the human UI shows it.
- An agent that saw a credential only in masked form will write the reference, not the value, into a PoC. A PoC containing a reference does not work. `finding_draft` rejects PoC content and repro steps containing `[SECRET:v1:` with an explanatory error, matching #142's rejection of placeholders in mutation inputs. It never tries to resolve references back to originals.

## HTTP API and UI

Routes under the instance HttpApi:

- list findings; get a finding with its events and PoC metadata
- create a finding (human-authored)
- edit a finding (compare-and-swap on `revision`)
- transition status (reason required; commit required where noted)
- add or remove a PoC; download a PoC (opens the sealed value)
- export a finding as markdown

Minimal UI: a findings panel per project with status and severity filters, a detail view with the event timeline, and the status actions. Anything written by an agent is labelled as such.

PoC content is shown as escaped plain text in a monospace block, or offered as a download. There is no run button. No agent- or repository-controlled field is rendered as markdown or HTML, so a finding cannot load remote images, links, or scripts in the UI.

## Export

One finding to markdown: title, severity, CWE, status, commit, locations, summary, impact, repro steps, and PoCs inline as fenced code. Each fence is one backtick longer than the longest backtick run in its content, so a PoC cannot close its own fence and inject markdown into the report.

Export includes the PoC content by design, since it is the engineering handoff. The UI states that the export contains working exploit material before copying or saving it.

## Security properties

- **Stored PoCs are not returned to the model.** No tool returns PoC content, and findings are not an automatic context source. Two limits: the drafting session already holds the PoC, because its `finding_draft` call arguments are part of that session's durable history; and nothing stops an agent from writing a PoC to disk itself while working. Both are outside this feature.
- **Human-only status.** Status changes, non-draft edits, and PoC reads are HTTP routes, not agent tools. This depends on agent processes not holding server credentials, which PR #144 fixed (`delete process.env.FORGE_SERVER_PASSWORD` in `packages/forge/src/server/auth.ts`). The implementation must add a regression test that an agent shell cannot call the findings routes.
- **Repository-steered drafts.** A hostile repository can steer an agent into drafting a fake finding or attaching a destructive "PoC" that a human later runs. Drafts are inert until a human confirms them, agent authorship is always visible, and TurenOS never executes PoCs.
- **Encrypted at rest.** PoCs often contain live tokens or cookies, and the database is copied by imports and backups. PoC content is sealed with the install's vault key; metadata is not.
- **No silent history rewrite.** `finding_event` is append-only; `finding` holds only current state and every change to it emits an event.
- **No public disclosure path.** v1 export is local markdown only. A direct GitHub integration must target private security advisories, never public issues.
- **Bounded inputs.** Every text field and attachment has a size cap, and filenames are sanitized basenames.

## Rollout

1. Schema contracts, Core tables, migration, and service with tests (status machine, compare-and-swap, cascade, seal/open round trip, cross-row seal swap fails).
2. Agent tools: `finding_draft`, `finding_list`, `finding_read`, `finding_note`. Tests assert no tool output contains PoC bytes and no tool can change status, including with permission checks disabled.
3. HttpApi routes, generated client, the agent-shell regression test, and the UI panel.
4. Markdown export with fence sizing tests.

Later, not in this design:

- A human-started re-verification session that deliberately passes a PoC to an agent.
- Promoting a findings-ledger scanner finding into a confirmed finding.
- GitHub private security advisory export.
- Deployed targets (URLs, hosts) using the memory `engagement` wing as precedent.

## Open questions

- Whether `finding_draft` should refuse, or only flag, drafting when the working tree is dirty.
- Whether an agent should be able to attach additional PoCs to a human-confirmed finding as a proposal the human accepts, rather than only via notes.
- Retention: whether `rejected` findings should be purged after N days, and whether their PoCs should be dropped sooner.
