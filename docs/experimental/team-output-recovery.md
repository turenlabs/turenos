# Team output recovery benchmark

Status: benchmark, as of 2026-10-16.

This benchmark measures bounded Team output recovery with synthetic history.
Its results do not establish full-runtime memory acceptance or explain the reported 16 GB incident.

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

| Metric                              |     Baseline Mode Range |         Candidate Range |
| ----------------------------------- | ----------------------: | ----------------------: |
| Sampled peak RSS, bytes             | 348,749,824-368,148,480 | 139,739,136-140,771,328 |
| Post-cleanup RSS, bytes             | 276,414,464-295,813,120 |   67,403,776-68,435,968 |
| Idle endpoint RSS slope, bytes/pass |     1,988,836-4,460,089 |           43,691-81,010 |
| Mean idle latency, ms               |             14.63-21.28 |               7.94-9.00 |
| Post-cleanup heapUsed, bytes        |    1,389,662-18,299,117 |     3,706,438-3,732,854 |
| Post-cleanup external, bytes        |      446,795-17,314,141 |     2,622,934-2,648,246 |
| Decoded rows per idle pass          |                   2,052 |                       0 |
| Decoded bytes per idle pass         |             134,377,528 |                       0 |

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

## Service Regression Continuation

The 2026-10-16 continuation adds `packages/forge/test/team/output-recovery.test.ts`.
The tests call the same complete recovery pass as the production timer.
The runtime change exposes that pass and moves its publication function without changing eligibility or scheduling.
Fixtures use actual TeamWorkspace, SessionV2, database migrations, Session decoding, and publication transactions.
Only Project placement and Session execution use substitutes. No provider call executes.
Projected assistant history models a stopped runner. This is not a provider-execution regression.

Coverage includes 205 responses across three pages, missed events, live leases, late completion behind earlier pages,
concurrent retries, cancelled tasks, paused teammates, Session separation, and final-result source deduplication.
A file-backed test closes and rebuilds the service graph twice to check durable recovery and exact prompt retries.
That test checks service restart, not operating-system process restart.

Run these commands from the candidate worktree's `packages/forge`:

```sh
env FORGE_TEST_KIMI=0 bun test test/team/output-recovery.test.ts --timeout 60000
env FORGE_TEST_KIMI=0 bun test test/team/runtime.test.ts --timeout 60000
bun typecheck
bun run script/team-output-service-workload.ts 3
```

The service workload accepts one optional pass count from 2 through 20. The default is three.
It creates private scratch XDG directories and a file-backed database, then removes them on exit.
It starts the actual production TeamRuntime, including its recovery timer and four-Session concurrency.
Inputs are four Sessions with 128 assistant responses each and 16,384 synthetic tool-output bytes per response.
One additional cancelled task checks publication isolation.
Each churn pass adds one missed response per Session and observes the next real timer interval.
Three additional 31-second idle observations precede service disposal and scratch cleanup.
The default run takes approximately 187 seconds, plus setup and recovery time.
It uses natural GC only. It does not read the live app, credentials, process arguments, or production heaps.

Output contains numeric NDJSON samples and a summary. Runtime logs can also appear on stdout.
Select JSON records containing `harnessSHA256` when collecting samples.
Samples identify UTC, source HEAD, harness hash, Bun version, PID, parent PID, workload, and concurrency.
Memory fields are RSS, heapUsed, heapTotal, external, and arrayBuffers in bytes.
The summary separates durable database/WAL bytes from sampled peak RSS and post-cleanup memory.
It reports an endpoint idle RSS slope in bytes/second. Native allocation ownership remains unavailable.
`observationWindowMs` includes timer waiting. It is not recovery CPU time or provider latency.
Phase sampling can miss intra-pass peaks. No retained-state plateau or calibrated service budget is claimed.

For an actual baseline comparison, use baseline `8a3a968ec635d29ccb02fa5ac383f50b9d7b2171` in a separate isolated worktree.
Apply only these two inspected harness files there, without changing baseline runtime sources:

- `packages/forge/script/team-output-service-workload.ts`
- `packages/forge/test/fixture/team-output-recovery.ts`

Run the same command from each worktree's `packages/forge`, using complete existing dependencies.
The fixture imports each worktree's own TeamRuntime. It does not select a modeled baseline algorithm.
Record each source HEAD, identical harness hashes, and any harness-only worktree changes before comparison.
Keep collected output private. Run three alternating baseline/candidate pairs before calibrating budgets.
This workload does not cover provider execution, real tool execution, prolonged factory churn, or crash recovery.
Those remain independent acceptance requirements.

Local execution on Bun `1.4.2` failed during module loading because `@effect/platform-bun` is missing.
Neither the new service tests nor this workload executed locally. No service memory measurements are available.
Forge typechecking also failed under the existing dependency layout; changed files had no remaining diagnostics.
The existing three SQL regressions still pass with 15 assertions.
Owner for dependency-complete execution: `@quality`, coordinated by `@techlead` through normal CI or an existing complete environment.
Do not install dependencies or treat the authored regressions as passing evidence.
