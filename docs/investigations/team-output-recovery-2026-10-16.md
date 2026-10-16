# Team Output Recovery

## Scope

Source baseline: `8a3a968ec635d29ccb02fa5ac383f50b9d7b2171`.
Measured candidate: `b4ff73e9eab6b146f03966eeb12b118cc255f783`.
Owner: runtime assignment `job_145743ee2002sB3jEWPtabFZs9`, executed by `@interface`.
Branch: `team-output-memory`.

The old timer loads every message body for each Team Session every 30 seconds.
It also reloads each completed assistant message before publication.
The candidate selects at most 100 unpublished identities per page before loading eligible bodies.
The existing publication transaction still checks task state, room state, teammate state, and exact retries.

Durable publication records replace a process-local high-water mark.
Each pass starts again, so late completion and previously ineligible output remain recoverable.
Task association uses the nearest preceding prompt for a real task in the same Session.
The candidate does not advance a cursor past unpublished output across recovery passes.
No schema migration, public Protocol change, or client generation is required.
The live Step.Ended listener still loads full history. This repair changes the timer only.

## Reproduction

Run these commands from `packages/core` in the candidate worktree:

```sh
bun test test/team-output-recovery.test.ts --timeout 60000
bun run script/team-output-workload.ts baseline
bun run script/team-output-workload.ts candidate
```

The workload accepts exactly one mode argument: `baseline` or `candidate`.
It emits NDJSON to stdout. It uses an isolated in-memory SQLite database.
Inputs are fixed: four Sessions, 256 assistant outputs per Session, 65,536 text bytes per output, and 20 passes.
Each Session starts with one missed output. All older outputs have durable publication records.
Concurrency is one. The production timer retains concurrency four.

The candidate executes the production query from `packages/core/src/team/output-recovery.ts`.
The baseline mode models the old full-history read and duplicate assistant JSON decode.
Both modes use the same synthetic database schema, inputs, and body decoding operation.
This is not a baseline-checkout versus candidate-checkout full-runtime comparison.
The fixture uses only production-equivalent indexes for its selected columns.

Each sample includes UTC, source head, Bun version, PID, workload, phase, latency, decoded rows, and decoded bytes.
It also includes `process.memoryUsage()` fields in bytes: RSS, heapUsed, heapTotal, external, and arrayBuffers.
The summary gives sampled peak RSS, post-cleanup RSS, and an endpoint idle RSS slope in bytes per pass.
The slope compares idle pass 1 with idle pass 19. It is not a long-duration fitted growth rate.
Bun's heap and external counters are runtime reports. Do not add them to RSS or infer native allocation ownership.

## Observed Results

Three serial pairs ran on Bun `1.4.2` at approximately `2026-10-16T16:25Z`.
Each process used natural GC only. No forced GC, heap capture, or live-app operation occurred.

| Metric | Baseline Mode Range | Candidate Range |
| --- | ---: | ---: |
| Sampled peak RSS, bytes | 348,749,824-368,148,480 | 139,739,136-140,771,328 |
| Post-cleanup RSS, bytes | 276,414,464-295,813,120 | 67,403,776-68,435,968 |
| Idle endpoint RSS slope, bytes/pass | 1,988,836-4,460,089 | 43,691-81,010 |
| Mean idle latency, ms | 14.63-21.28 | 7.94-9.00 |
| Post-cleanup heapUsed, bytes | 1,389,662-18,299,117 | 3,706,438-3,732,854 |
| Post-cleanup external, bytes | 446,795-17,314,141 | 2,622,934-2,648,246 |
| Decoded rows per idle pass | 2,052 | 0 |
| Decoded bytes per idle pass | 134,377,528 | 0 |

Each candidate first pass decoded four bodies totaling 262,456 JSON bytes.
Each baseline-mode run decoded 38,988 rows and 2,553,173,032 bytes across its 19 idle passes.
These results support reduced synthetic allocation and RSS, not incident attribution or full-runtime acceptance.
The reported 16 GB incident remains unexplained.

Private numeric artifacts are outside the branch at `.team-repairs/team-output-memory-evidence/` in the shared checkout.
Names are `baseline-1.ndjson` through `baseline-3.ndjson` and `candidate-1.ndjson` through `candidate-3.ndjson`.
The directory has mode `0700`; files have mode `0600`. They contain synthetic metrics, not user message bodies.

## Checks And Limits

The SQL regressions passed: three tests, 15 assertions, zero failures.
They cover page limits, large history, idle recovery, reopened database state, missed output, and exact publication identity.
They also cover task boundaries, foreign Sessions, active leases, cancelled/stale states, errors, and late completion.
They execute the production query, but not the complete TeamWorkspace service or Session decoder.
The workload enforces four first-pass decodes and zero later decodes in candidate mode.

`bun test test/team.test.ts --timeout 60000 --only-failures` failed before tests because `@effect/platform-bun` is missing locally.
Forge's `bun test test/team/runtime.test.ts --timeout 60000 --only-failures` also failed during module loading for that dependency.
`bun typecheck` failed in both Core and Forge under the retained dependency layout.
Diagnostics include missing platform, client, and TUI dependencies, plus incompatible shared-checkout dependency links.
No changed Team source diagnostic remained in the final captured typecheck outputs.
These failures are not package verification passes. No dependency was installed.

The synthetic runs last less than two seconds. They do not establish a long-lived retention plateau.
Sampling can miss intra-pass RSS peaks. JSON.parse is not the full Session schema decoder.
Provider work, cancellation execution, legacy adoption, active ownership, and runtime restart need independent service-level verification.

Provisional same-workload acceptance ceilings are 160 MiB sampled peak RSS and 85 MiB post-cleanup RSS.
These ceilings add margin above this machine's three-run observations. They are not cross-platform CI budgets.
Keep the deterministic zero-idle-body requirement. Calibrate memory and latency gates with independent repeated runs.

Next owner: `@quality`, coordinated by `@techlead`.
Next action: inspect the candidate and rerun the three matched synthetic pairs.
Then run Core Team tests, Forge Team runtime tests, and package typechecks in a complete existing dependency environment.
Add or qualify service-level restart, missed-event, cancellation, and exact-retry coverage before merging.
