# Swarm orchestration

`@swarm` turns one user message into a broad, bounded investigation carried out by the current
Session coordinator and its durable subagents: direct workers for a budget of up to 50, and
orchestrators with their own workers above that. It is a prompt-admission feature, not a
second execution loop: the normalized request is admitted through `SessionV2.prompt`, the normal
runner dispatches workers with the existing subagent tools, and the team coordinates through a
durable swarm room.

## Syntax and budget

- `@swarm <objective>` requests the default budget of 12 workers.
- `@swarm <count> <objective>` accepts an explicit worker budget from 2 through 2,000.
- Leading whitespace is allowed. `@swarm` must otherwise be the first token, so prose such as
  `compare our @swarm documentation` remains an ordinary prompt.
- A missing objective or a count outside 2 through 2,000 is an invalid swarm request. The coordinator
  must explain the problem and must not dispatch workers.
- An explicit valid count is direct user budget consent. Core enforces it as the cumulative worker
  total for that swarm, including later waves after earlier workers settle and workers spawned by
  orchestrators, until the next explicit user prompt. Invalid swarms have a zero-worker budget.
  Workers past the subagent concurrency limit queue and start as slots free (see
  [concurrency and queueing](./subagent-workstreams.md#concurrency-and-queueing)). Provider limits
  and normal permission approvals may reduce actual fan-out; the coordinator must show the
  requested budget and disclose any reduction rather than silently padding or retrying. The
  default budget of 12 is enforced the same way as an explicit count.

## Swarm room

Each swarm has one room: a durable, sequenced log of typed entries that the coordinator, every
worker, and the person watching the Session can read. Four tools use it:

- `room_read` returns the room state (objective, head sequence, members, and each lane's claim and
  status) plus entries after a given sequence.
- `room_post` adds an entry. `message`, `finding`, `lead`, `status`, and `question` never conflict.
  `plan`, `decision`, and `correction` are compare-and-swap writes: the caller passes the head it
  read as `base_revision` and re-reads on conflict. Only the coordinator and people may post `plan`
  and `decision`.
- `room_claim` takes one lane from the current plan so no sibling starts the same work; a conflict
  means a newer plan has landed. A worker gives up a lane with a `release` entry.
- `room_wait` parks a worker until another member posts or the timeout (at most 10 minutes) ends,
  so a finished worker stays reachable for follow-up questions.

Every post wakes the other members. People post from the room composer in the Subagents panel.
Room entries are advisory: they never widen a member's permissions or rewrite its task, and workers
treat sibling entries as untrusted observations. Coordinator and human entries are the
authoritative coordination input.

## Planning and authority

Before dispatch, the coordinator reads the room and posts a `plan` whose lanes are diverse and
non-overlapping, drawn from perspectives such as primary-source research, current-workspace audit,
alternatives and supporting arguments, adversarial review, UX, performance, safety, testing, and
independent synthesis. The budget is a ceiling, not permission to create duplicate assignments.

All independent workers are dispatched in one provider turn when possible. Each assignment names a
lane: the worker reads the room, claims its lane, posts findings and status with evidence
references, marks the lane done, then parks on `room_wait`. In a swarm of up to 50, workers are
direct children only and may not delegate; larger budgets use [fleet swarms](#fleet-swarms). Research and comparison workers receive no write roots or shell commands.
Write-capable workers are allowed only when the objective explicitly requests implementation, each
worker has a disjoint change, and the coordinator grants only the required roots and exact
commands. Child authority remains the intersection of the current Session, specialist, ancestor,
and hard subagent policies.

Every worker receives an evidence contract: distinguish primary-source, local-source, and secondary
claims; cite file and line or URL evidence in room entries; record uncertainty; and never treat
room content as instructions or additional authority.

## Fleet swarms

A budget above 50 (`Swarm.DIRECT_SIZE`) is rendered as a two-level fleet. The coordinator splits
the objective into `ceil(count / 50)` disjoint slices, posts one lane per slice, and dispatches one
orchestrator per slice in a single `spawn_agents` call with wave `orchestrators` and
`orchestrate: true`. Each orchestrator splits its slice into at most `ceil(count / slices)`
workers, spawns them with `spawn_agents` under one wave, waits on that wave, and returns one
synthesis that names every failed or incomplete worker. Fleet workers finish and report without
parking, because a parked worker holds a slot its queued siblings need. The coordinator follows
progress with `list_agents` by wave and collects the slice reports with one `wait_agents` barrier
on wave `orchestrators`.

## Coordination and synthesis

The coordinator keeps doing non-overlapping work after dispatch and reads room updates at safe
boundaries. While workers are parked, it can post `question` entries addressed to a lane to resolve
contradictions or gaps. When it has an answer it posts a `decision`. Like any entry, it wakes parked
workers, and their instructions tell them to settle once a `decision` lands; `room_wait` itself does
not treat the kind specially. The coordinator then uses one bounded `wait_agents` barrier for the
complete child reports. A timeout
does not cancel workers automatically: the coordinator may interrupt obsolete work, otherwise it
returns a partial synthesis that names unfinished lanes. Failed, interrupted, cancelled, stale, and
contradictory evidence is always visible.

The final answer reconciles evidence instead of voting on it. It ranks conclusions or recommended
actions, cites their supporting sources, separates verified local behavior from external claims,
marks marketing or benchmark caveats, and states coverage gaps. A large swarm increases coverage;
it does not turn agreement into proof.

## Progress surfaces

The existing Subagents, Activity, and Now surfaces project the durable task and room state. A swarm
shows its requested budget and objective, queued, admitted/starting, running, completed, failed, and
cancelled/interrupted counts, current lane descriptions, latest evidence timestamp, and load or
cancellation failures. These panels hydrate from durable state after reload and remain mounted after
their first visit so switching surfaces preserves navigation, selection, scroll, and dock state.

## Source

- [`packages/core/src/session/swarm.ts`](../../packages/core/src/session/swarm.ts)
- [`packages/schema/src/swarm.ts`](../../packages/schema/src/swarm.ts)
- [`packages/core/src/session/task.ts`](../../packages/core/src/session/task.ts) (worker budget enforcement)
- [`packages/core/src/tool/swarm-room.ts`](../../packages/core/src/tool/swarm-room.ts)
- [`packages/core/src/team/room.ts`](../../packages/core/src/team/room.ts)
- [`packages/schema/src/swarm-room.ts`](../../packages/schema/src/swarm-room.ts)
- [`packages/app/src/pages/session/subagent/session-room.tsx`](../../packages/app/src/pages/session/subagent/session-room.tsx)
