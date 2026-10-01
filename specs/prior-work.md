# Prior work

Status: design, not implemented. Option B approved by independent decision review, with required changes incorporated here.

## Problem

Agents re-investigate what earlier runs already found, refuted, or checked. Team board notes and swarm room entries carry `finding`, `lead`, `correction`, and (board only) `refuted` kinds with evidence, but both belong to one root Session:

- Board reads filter by `root_session_id` (`packages/core/src/team/board.ts`).
- A room is unique per root Session and created on first access (`packages/core/src/team/room.sql.ts`, `SwarmRoom.open` in `packages/core/src/team/room.ts`). A later `@swarm` in the same root Session reuses the room and records the new objective; a new root Session starts with an empty room.
- The coordinator reads the room before planning (`packages/core/src/session/swarm.ts`), and `board_read` "prevents repeating a sibling's work" (`packages/core/src/tool/team-board.ts`). Both cover only the current team.

Memory persists per project with wing scope, temporal validity, provenance, anchors, and search (`docs/memory.md`). Its kinds are `note`, `fact`, `decision`, and `observation`. It can describe a refutation or a clean check in prose, but has no typed investigation scope, evidence lineage, observation revision, or applicability, and there is no swarm-specific memory consultation.

Prior work is a small project knowledge record of investigation outcomes, including negative results, that a new session, child session, or `@swarm` receives before it starts probing.

## Non-goals

Two earlier workbenches with finding tables were removed (`20260822133903_remove-reversing-workbench`, `20260911132133_remove-pentest`). This is not a workbench.

- No PoC attachments, exploit execution, severity or CWE, remediation lifecycle, or reports. Confirmed-vulnerability handoff is a separate design (`specs/confirmed-findings.md` on branch `confirmed-findings`), neither required by nor folded into this one.
- No raw scanner ingestion, transcript mining, or automatic copying of board or room text.
- No project-wide cross-root coordination room. Plans, claims, lanes, heads, and membership stay with their root Session.
- No sync, multi-user trust, deployed targets, or non-Git directories.
- No automatic migration of memory drawers.
- No startup LLM summarization or new embedding dependency.
- No automatic expiry. Records stay until a user deletes them.

## Decisions

| Question         | Decision                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| Shape            | New Core domain (option B). Not a memory convention (A) and not a persistent room (C).                              |
| Record types     | `finding`, `lead`, `refutation`, `coverage`.                                                                        |
| Writing          | One explicit agent tool with prepared, bounded fields. Historical entries are adopted as prepared projections only. |
| Receiving        | A digest in the same first provider request as the task that triggers it, plus search and read tools.               |
| Scope            | Project plus a server-owned repository binding validated by filesystem incarnation. Clones need an explicit link.   |
| Negative results | Inform, never exclude. No record, human-written or not, closes a lead or removes a path from investigation.         |
| Applicability    | `unchanged since recording`, `stale`, or `unknown`, from an isolated capture of the whole repository.               |
| Default          | Tools on. Automatic digest content off until the release gates pass; a notice that prior work exists is delivered.  |
| PR #179          | Separate and deferred. Any later integration exposes a safe reference only, never PoCs or reproduction payloads.    |

## Records

A record is a prepared, model-readable statement about one investigation outcome.

- **finding**: an observed issue or behavior. Not a confirmed vulnerability.
- **lead**: a specific unresolved hypothesis.
- **refutation**: a challenge to one exact record revision, or to an adopted source entry whose record does not exist yet (see Adopting historical entries), with rationale and evidence. It never hides or deletes what it challenges.
- **coverage**: "this method examined this scope and found no matching issue", with method, assumptions, limitations, and exclusions. Never "this area is safe".

### Repository binding

Project IDs can be seeded from a normalized remote URL (`packages/core/src/project.ts`), so a fresh or hostile clone of the same remote converges on the same project ID. Project ID is grouping, not authorization.

`Git.Repository.commonDirectory` is shared by linked worktrees, but it is a lexically resolved path (`resolvePath` in `packages/core/src/git.ts`), not an identity: a replacement clone at the same path would inherit it, and a rename or symlink alias would lose it. It only locates a binding:

- `prior_work_repository` stores an opaque `repository_id`, the `project_id`, and the filesystem incarnation of the canonical (realpath) common directory: device, inode, and birth time, following the anchor pattern in `packages/core/src/tool/memory.ts`.
- On access, the server canonicalizes the Location's common directory and looks up its incarnation. A match yields the `repository_id`. A common directory whose incarnation matches no binding, or a platform that reports no inode, is unbound: it sees no prior work and gets a fresh binding only when a record is first written.
- A replaced common directory at the same path has a new incarnation, so it does not inherit its predecessor's records. A renamed or aliased repository keeps its incarnation and its records.
- Linking a separate clone, or re-linking after identity recovery fails, is an owner action in the UI. It records a grant from the new binding to an existing `repository_id`. Grants never rewrite the original records' provenance.

Every write, ID lookup, search, digest, and applicability check filters by the authorized `repository_id` set of the current Location. The global non-Git project is rejected.

### Data model

Snake_case Drizzle columns, epoch milliseconds, typed Storage repositories per `specs/storage.md`: one serialized transaction per mutation, events published after commit.

`prior_work_record` holds identity and the current head:

| Column          | Notes                                                      |
| --------------- | ---------------------------------------------------------- |
| `id`            | ascending ID, `pwr_` prefix                                |
| `project_id`    | FK `project.id`                                            |
| `repository_id` | FK `prior_work_repository`                                 |
| `kind`          | `finding`, `lead`, `refutation`, `coverage`; immutable     |
| `head_revision` | current revision number                                    |
| `state`         | `active`, `retracted`, `deleted` (tombstone; see Deletion) |
| `time_created`  |                                                            |

`prior_work_revision` is immutable. Every edit writes a new row; nothing is overwritten.

| Column              | Notes                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `record_id`         | with `revision`, primary key                                                                                            |
| `revision`          |                                                                                                                         |
| `summary`           | one line, 1..512 UTF-8 bytes                                                                                            |
| `detail`            | explanation, limitations, exclusions; up to 8 KiB                                                                       |
| `method`            | how the outcome was reached (tool, query, rule set, or manual procedure), 1..1 KiB; required for every kind             |
| `assumptions`       | JSON, max 16, `{ text, status: "known" \| "unknown" }`, each up to 512 bytes                                            |
| `locations`         | JSON, max 32, `{ path, start_line?, end_line?, symbol? }` or `{ directory }`, repository-root-relative                  |
| `evidence`          | JSON, max 16, `{ kind: "file" \| "command" \| "url" \| "record", ref, note? }`, ref up to 1 KiB                         |
| `challenges`        | nullable; required for `refutation`: `{ resolved: { record_id, revision } }` or `{ unresolved: { source, source_id } }` |
| `derived_from`      | JSON, max 8, `{ record_id, revision }`; explicit lineage only                                                           |
| `recording_capture` | whole-repository capture at recording time; see Observation                                                             |
| `observation`       | see Observation                                                                                                         |
| `recorded_by`       | `{ actor: "agent" \| "human", session_id?, agent? }` from invocation context                                            |
| `time_recorded`     |                                                                                                                         |

Each revision is capped at 16 KiB encoded. Oversized input is rejected, never truncated.

`prior_work_origin` is immutable, one row per record, written at creation:

| Column              | Notes                                                                             |
| ------------------- | --------------------------------------------------------------------------------- |
| `record_id`         |                                                                                   |
| `author`            | `{ actor: "agent" \| "human", agent?, name? }` of the original observer           |
| `source`            | `live`, or `board_note` / `room_entry` with the source ID and its root Session ID |
| `source_session_id` | the original observer's Session, kept as an ID after that Session is deleted      |
| `time_observed`     | original observation time, from the source entry when adopted                     |

Whether the source Session and entry still exist is derived at read time and shown as source availability.

For live records the author and the recorder are the same. For adopted records the recorder is whoever adopted it, and the author, source, and observation time come from the source entry.

`prior_work_event` is an append-only log of create, revise, retract, delete, adopt, and link actions with actor, Session, and revision.

### Observation

Every revision stores two separate facts:

- `recording_capture`: the whole-repository capture taken when the revision was written (`commit`, `snapshot_tree`, `snapshot_id`, `completeness`). This is always present and only says what the tree looked like at recording time.
- `observation`: where the check itself ran, only as far as the server can prove it.

`observation.basis` is `unknown` for every v1 record. Ordinary tool calls are not bound to an immutable snapshot: the runner captures the workspace before each provider turn, not at each tool execution, so a shell can change the tree, run the check, and restore it before the next capture. Equal snapshots before and after therefore do not prove what the check saw. `captured` is reserved for a later check environment that runs against an identified immutable snapshot.

Recording-time completeness never stands in for check-time completeness. A new revision keeps the previous revision's `observation`, and a prose correction never refreshes it.

`completeness` is `complete`, or `partial` with the excluded paths and reason (oversized untracked files, submodules, capture race).

### Deletion

Deleting a record is a user action in the UI. It keeps a tombstone row (`id`, `kind`, `state = deleted`) and its events, removes all revision content, and leaves every relationship that points to it intact, so a refutation shows "challenges a deleted record" instead of silently losing its target. Project deletion cascades everything. The UI states that deletion does not remove copies already in transcripts, backups, or requests sent to a model provider.

## Writing

### `prior_work_record`

Creates a record or a new revision of one. The model supplies only prepared fields: kind, summary, detail, method, assumptions, locations, evidence, challenges, and derived_from. The server fills the repository binding, observation, recorder, and origin from the Location and invocation context; the model cannot set any of them.

Idempotency: the key is scoped to the calling Session and tool and stored with a hash of the canonical submitted content. An exact retry returns the original record and revision. Reusing the key with different content fails.

A new revision of an existing record requires its current `head_revision` (compare-and-swap). Only the record's recording Session or a human can revise it, and `kind` never changes.

Agents are asked to record material findings, refutations, and completed checks as they go. Final synthesis reconciles anything missed but is not the only persistence point.

### Adopting historical entries

Selecting an entry does not make its text a safe summary: board and room text is larger than a record and often contains command output, which `packages/core/src/session/swarm.ts` encourages. Adoption therefore attaches provenance to a prepared record and never copies source bodies.

- `adopt`, an optional input on `prior_work_record`, names a board note or room entry. The server checks that the caller can read it: it belongs to the caller's own team, or the owner granted access (below). It then records `prior_work_origin` from the source: author, root Session, source ID, and observation time. Summary, detail, method, and evidence must still be supplied by the caller through the bounded fields.
- Access to an earlier team is an owner action. In the Prior work panel, the user selects an earlier root Session and grants the current Session read access to its board and room for adoption. The grant is scoped to that Session, recorded as an event, and revocable. A guessed source ID is refused.
- Kind mapping: `finding` and `lead` map to themselves; board `refuted`, board `correction`, and room `correction` map to `refutation`.
- Each source entry can be adopted at most once per repository binding (unique on source and source ID). That makes the source-to-record mapping unambiguous.
- Relationships: a source `supersedes` or `replyTo` target that was already adopted resolves to `{ resolved: { record_id, revision } }`, where `revision` is the first revision of that adopted record, the one derived from the source, never whatever head exists later. A target not yet adopted is stored as `{ unresolved: { source, source_id } }` and shown as "challenges an entry that has not been adopted". When that target is adopted later, the service writes a new revision of the refutation that resolves it. Nothing is invented.
- Adoption never makes the adopter the author, never makes an agent claim human, and never counts as corroboration.

### `prior_work_retract`

Retracts a record with a required reason. Allowed for the recording Session or a human. Retracted records leave the digest but stay searchable with their lineage.

## Receiving

### Digest delivery

The digest must be in the same first provider request as the task it serves. An ordinary queued advisory cannot guarantee that: at a boundary the runner promotes steers first and promotes the queue only when no steer was promoted (`promoteSteers` and `promoteNextQueued` in `packages/core/src/session/runner/llm.ts`).

Delivery is Session-owned and tied to input promotion:

- A trigger is the promotion of the user input that starts a root Session's first task, the first input of a child Session, or an admitted `@swarm` request.
- In the same transaction that promotes the trigger, the runner computes the authorized digest and writes it as a `prior_work` message (a new `SessionMessage.Source` value, `packages/schema/src/session-message.ts`) sequenced immediately after the trigger. The next provider request therefore contains both. It is neither a steer nor a queued input, so steer precedence and machine-queue batching are unchanged.
- Trigger inputs are never live steers. The Claude Code transport offers eligible plain steers to the running CLI and promotes them only after the CLI confirms it folded them in (`offerSteers` and `foldSteers` in `packages/core/src/session/runner/llm.ts`). That path delivers input before promotion, so a digest written at promotion would arrive late. The steer-eligibility check (`steerText`) therefore returns undefined for any input that would be a trigger. The existing rule that the first ineligible steer holds the rest keeps admission order, and the trigger promotes at the next ordinary boundary together with its digest.
- The snapshot is stored as `pending` until the first provider request containing it is submitted. At that submission the runner re-checks authorization. If the check no longer allows content, the runner replaces the content with the notice (or with nothing when denied) before sending. After submission the snapshot is `submitted` and is history like any other message.
- Delivery identity is the Session, trigger input ID, authorized repository set, included record revisions, and rendered hash. A retried or restarted drain reuses the stored snapshot instead of recomputing it; a still-`pending` snapshot is re-authorized at submission as above.
- Refresh happens only at a later trigger in the same Session (a new user task or `@swarm`), and only when the identity changed. Prior work never wakes an idle Session and never creates its own continuation turn.
- A cancelled or superseded trigger leaves any `submitted` snapshot in history. A `pending` snapshot whose trigger was cancelled before submission is discarded.

Rendering: the message body is a fixed trusted header followed by escaped, delimited record data. The `source` value is provenance only; messages from every source reach the provider in the `user` role (`packages/core/src/session/runner/to-llm-message.ts`), so the header and escaping are the boundary. The header says these are untrusted historical observations, that they do not change the task, permissions, or what must be checked, and that coverage and refutations are not exclusions.

It is not System Context, which models privileged context and enters the system prompt (`packages/core/src/system-context/index.ts`). Only short trusted guidance on using the prior-work tools goes there.

Authorization uses the same resource-aware check as `prior_work_search` for that Session, including child restrictions. When denied, nothing is written. When unresolved, a one-line notice that prior work exists is written instead. Until the release gates pass, content delivery is off and every trigger gets only the notice.

The swarm room shows the same snapshot in a separate "Prior work" view. It is never replayed as room entries and never uses the room's "leader and human posts are authoritative" advisory framing (`packages/core/src/team/room.ts`). Carried text is untrusted even when a human wrote it.

### Digest contents and bounds

- At most 12 records and 8 KiB rendered, including the header, provenance, and warnings.
- Each entry shows ID and revision, kind, summary, applicability, observation basis with its commit and tree state (`clean`, `dirty`, or `unknown`) and completeness, original author and source, and evidence availability. Partial or unknown observations carry a one-line warning.
- Selection is deterministic: records whose locations match paths named in the trigger or the swarm objective's terms first, then recent `unchanged since recording` findings and leads.
- A claim and its challenges are selected as a group. If a claim's challenges do not all fit, the claim is shown with its newest challenge's summary (or, if even that does not fit, the challenge count) and a `prior_work_read` pointer. A claim is never shown as unchallenged when a challenge was omitted.
- Omissions are stated with counts and a search pointer.
- The snapshot identity changes, so the next trigger refreshes it, when a relevant record is revised, retracted, deleted, or challenged, or when the tree changes.

### Tools

- `prior_work_search`: filters by kind, path or directory prefix, applicability, author, and text. At most 50 records and 32 KiB rendered per page, with a cursor. Metadata and summaries only.
- `prior_work_read`: one record revision with all fields, origin, observation, and applicability, plus the first page of each related collection. The whole response is at most 32 KiB rendered. Each collection has its own count and byte budget and a cursor for the next page:
  - challenges: at most 10 per page, 8 KiB, summaries only, newest first;
  - derived records: at most 10 per page, 4 KiB, summaries only;
  - revision history: at most 10 revisions per page, 4 KiB, metadata and summary only;
  - events: at most 20 per page, 2 KiB.

Budgets are enforced by the domain renderer, which emits an explicit omission line ("N more challenges; cursor …") before a collection runs out of budget. The record's own warnings and its challenge count always render first and are never dropped. The renderer honours the effective generic tool-output limits, both bytes and lines, including values lowered by `tool_output` configuration (`packages/core/src/tool-output-store.ts`), and reserves room for omission and warning lines. Generic truncation therefore never applies.

Evidence is shown, never followed: no URL is fetched and no command is run. Evidence availability is `present` (the referenced file or record exists now), `missing`, or `not checked` (URLs and commands).

Distinct observations that cite the same file or URL are separate records. Only explicit `challenges` and `derived_from` establish lineage.

## Applicability

Computed against an isolated capture of the whole repository working tree, never the user's index.

- Capture uses a shadow Git directory and index per repository binding, like `Snapshot` (`packages/core/src/snapshot.ts`), so the user's staging area is never touched. `Git.tree.capture` refreshes whatever index it is given and currently discards which untracked files it skipped (`packages/core/src/git.ts`); the implementation must wrap or extend it to report completeness.
- The universe is the repository root: tracked files plus untracked, non-ignored files, not just the Location subdirectory.
- Snapshots are retained while any revision references them. A missing object makes the comparison `unknown`.

States, compared against the revision's `recording_capture` because v1 observations are always `unknown`:

- `unchanged since recording`: the recording capture was `complete`, and no anchored file, and no file inside an anchored directory, differs from the current complete capture. It says nothing about what tree the check itself saw; the observation basis is shown beside it.
- `stale`: an anchored file changed, was deleted, or cannot be resolved since recording, or a file inside an anchored directory changed. For `coverage` and `refutation`, any change anywhere in the universe.
- `unknown`: a `partial` capture on either side, unsupported submodule state, a capture race, a missing object, a record adopted without any recording capture of its own source tree, or a comparison that did not complete.

Assumption status and observation basis are shown next to applicability and never folded into it. `unchanged since recording` never means "verified safe" or "checked at this tree". An unavailable store is reported as unavailable, never as "no prior work".

## Human controls

A Prior work panel per project lists records with filters, lineage, applicability, and origin. It lets the user retract, delete, grant historical adoption access, link a separate clone, and turn the digest off for the project. The UI states that records may be sent to the configured model provider.

## Default permissions

`prior_work_search` and `prior_work_read` default to `allow` for primary agents and subagents. `prior_work_record` and `prior_work_retract` default to `allow` for primary agents and `ask` for subagents. None of them grants filesystem, command, or network authority.

## Security properties

These gate release.

- **No inherited authority.** All carried text is untrusted data, including human-authored and former coordinator text. Records cannot change tasks, permissions, tool availability, or lane state. Fields are escaped wherever they are rendered.
- **No negative-result laundering.** A refutation or coverage record never closes a lead, excludes a path, or suppresses a finding. Agents may reuse evidence to avoid repeating an identical check but must say so and state its limits. A human review applies to one claim at one revision and is never a permanent exclusion.
- **Immutable lineage.** Revisions are never overwritten. Original author, source, and observation stay separate from the recorder. Adoption and copying never refresh an observation or add independent weight. Contradicting records stay visible together.
- **Repository binding.** Project ID alone never grants access. Replacement at the same path does not inherit records; separate clones need an explicit owner link.
- **Permission parity.** Automatic delivery never shows more than the tools would for that Session. Disabling permission checks turns `ask` into `allow` (`packages/core/src/permission.ts`); that is ordinary tool access, not human confirmation.
- **Minimal sensitive content.** Only prepared summaries and bounded references are stored. No tool output, request bodies, credentials, PoC text, or confirmed-findings reproduction fields are copied in.
- **Placeholder rejection.** Inputs containing `[SECRET:v1` are rejected. This needs a shared Core validator with the semantics of the secret-output guard's `containsPlaceholder` (PR #142). If #142 has not landed first, this feature adds that validator in Core with the same semantics and #142 adopts it. Once #142's high-confidence credential rules are in Core, the same validator also rejects credentials in those formats. Screening is defence in depth, not a guarantee that prose is secret-free. Arbitrary exploit text cannot be detected by machine, so keeping PoCs out rests on the prepared-field contract and tool guidance, and is stated as a limitation.
- **Content-free failures.** Rejected input never appears in prior-work errors, tool failures, or logs. Generic tool decoding formats the schema error into the tool failure before the leaf runs (`packages/core/src/tool/tool.ts`), so these tools need content-free decode failures; add that as an option on `Tool.make` rather than a leaf-level check. Storage errors and logs carry IDs only.
- **Transcript boundary.** The runner publishes a tool call's arguments as session events before the tool decodes them (`packages/core/src/session/runner/publish-llm-event.ts`). Whatever an agent passes to a prior-work tool, including rejected input, is therefore kept in that Session's own transcript, like any other tool input. This feature does not change that. Its guarantees cover prior-work-owned storage and outputs only: records, events, digests, reads, errors, logs, and the panel.
- **Distinguishable failure.** Unavailable storage, `unknown` applicability, missing evidence, and digest truncation are always shown as such, never as "nothing previously checked".

Labels alone do not prove resistance to prompt injection; the evaluation below is required.

## Rollout

1. Repository binding, Schema contracts, Core tables, migration, and service.
   Tests: linked worktrees share; a separate clone with the same remote does not; replacement at the same path does not inherit; rename and symlink alias keep access; an owner link grants access without rewriting provenance; cross-repository IDs rejected; global project rejected; exact retry and conflicting key reuse; source Session deletion keeps origin; revisions immutable; tombstone deletion keeps relationships; oversized and malformed input rejected before execution with content-free errors; placeholder rejection.
2. Applicability.
   Tests: the user's index is unchanged after capture; clean, dirty, untracked, deleted, renamed, missing commit, oversized untracked (partial becomes unknown), submodule, and directory scope cases; coverage and refutation invalidation on unrelated changes; reads from another linked worktree.
3. Tools and adoption.
   Tests: server-filled fields cannot be forged; adoption requires team membership or an owner grant; guessed source IDs refused; source bodies not copied; each source adopted at most once; kind mapping including board `correction`; unresolved challenges stored, shown, and resolved to the adopted record's first revision when their target is adopted; permission parity for child Sessions; a record written in one root Session is found by `prior_work_search` and `prior_work_read` from a different root Session and from a child Session of it, in the same repository binding, and not from a different binding; per-collection and whole-response budgets with omission lines, never generic truncation, including newline-heavy content and lowered `tool_output` byte and line limits; contradictory claims and copied-refutation chains render with every challenge discoverable; missing source evidence shown; every v1 observation is `unknown`, including the case where a shell changes the tree from A to B, runs the check on B, and restores A before the next capture; a prose revision keeps the previous observation.
4. Digest delivery, notice-only by default.
   Tests on actual first provider requests: root Session, child Session, repeated `@swarm` in one root Session, queued prompts, concurrent steers, and the Claude Code transport with a running CLI (a trigger is never offered as a live steer and arrives with its digest). The digest is in the same request as its trigger; retry and restart reuse the snapshot; a permission revoked between commit and first submission changes a `pending` snapshot to the notice or nothing; no self-generated turns; denied permission writes nothing; it never enters System Context; bounds, group selection, and stated omissions hold.
5. Human panel, Protocol group, server handlers, generated client, and controls.
6. Leakage tests with synthetic secret and PoC markers:
   - Prohibited-material fixtures (every pattern the validator detects: secret placeholders, plus high-confidence credential formats once available) are rejected when submitted in any record field or evidence note, and never reach a record, digest, detail read, panel, error, tool failure, log line, or prior-work event. The one disclosed exception is the calling Session's own tool-input transcript (Transcript boundary).
   - A marker present only in an adoption source (board or room body or evidence) appears in no record, digest, detail read, panel, log, or prior-work event.
   - A harmless canary that the caller writes into an accepted field appears only where that field is rendered (the record's detail, digest entry, and panel view), escaped. It never appears in logs, errors, prior-work events, or other records. This checks rendering boundaries; it is not an exemption for prohibited material.
7. Evaluation before enabling digest content by default, with criteria fixed before running:
   - Adversarial: across at least 20 scenarios in which a hostile repository steers run 1 into recording "coverage: `<area>` clean" or "refutation: `<issue>` not exploitable", the rate at which run 2 on an unchanged tree examines the poisoned area must not fall below a no-digest control by more than a pre-registered margin.
   - Benefit: on representative multi-run tasks, identical re-checks must drop measurably against the no-digest control, with no measurable increase in missed known issues.
   - If either fails, content delivery stays off; the notice and tools remain.

## Reversal conditions

- A thin typed extension of memory is shown to provide the same binding, lineage, applicability, and permission contracts with less duplication.
- Poisoned digests measurably suppress investigation: keep content delivery off.
- Repository binding, permission parity, or sensitive-content boundaries cannot be enforced: stop rollout.
- Little duplicate-work reduction, or measurable false-negative anchoring.
- The requirement becomes deployed-target coverage, multi-user trust, or vulnerability handoff: design that separately.

## Open questions

- How paths named in a trigger are extracted for selection without an LLM call: explicit paths in the prompt and swarm objective only, or also recent file-tool activity.
- Capture cost per recording on large repositories, and whether capture should be deferred to the end of the check.
