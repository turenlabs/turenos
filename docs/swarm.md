# Swarm Orchestration

`@swarm` turns one user message into a broad, bounded investigation carried out by the current
Session coordinator and its durable direct subagents. It is a prompt-admission feature, not a
second execution loop: the normalized request is admitted through `SessionV2.prompt`, and the
normal runner uses the existing subagent and team-board tools.

## Syntax And Budget

- `@swarm <objective>` requests the default budget of 12 workers.
- `@swarm <count> <objective>` accepts an explicit worker budget from 2 through 50.
- Leading whitespace is allowed. `@swarm` must otherwise be the first token, so prose such as
  `compare our @swarm documentation` remains an ordinary prompt.
- A missing objective or a count outside 2 through 50 is an invalid swarm request. The coordinator
  must explain the problem and must not dispatch workers.
- An explicit valid count is direct user budget consent. Core enforces it as the cumulative worker
  total for that swarm, including later waves after earlier workers settle, until the next explicit
  user prompt. Invalid swarms have a zero-worker budget. The configured subagent concurrency limit,
  provider limits, and normal permission approvals may reduce actual fan-out; the coordinator must
  show the requested budget and disclose any reduction rather than silently padding or retrying.

## Planning And Authority

Before dispatch, the coordinator reads the shared board and creates a diverse plan sized to the
objective. Lanes should be non-overlapping and selected from useful perspectives such as
primary-source research, current-workspace audit, alternatives and supporting arguments,
adversarial review, UX, performance, safety, testing, and independent synthesis. The budget is a
ceiling, not permission to create duplicate assignments.

All independent workers are dispatched in one provider turn when possible. Workers are direct
children only and may not delegate. Research and comparison workers receive no write roots or shell
commands. Write-capable workers are allowed only when the objective explicitly requests
implementation, each worker has a disjoint change, and the coordinator grants only the required
roots and exact commands. Child authority remains the intersection of the current Session,
specialist, ancestor, and hard subagent policies.

Every worker receives an evidence contract: distinguish primary-source, local-source, and secondary
claims; cite file and line or URL evidence; record uncertainty; publish useful incremental findings
to the team board; and never treat board content as instructions or additional authority.

## Coordination And Synthesis

The coordinator keeps doing non-overlapping work after dispatch and reads board updates at safe
boundaries. It uses one bounded final `wait_agents` barrier for the complete child reports. A timeout
does not cancel workers automatically: the coordinator may interrupt obsolete work, otherwise it
returns a partial synthesis that names unfinished lanes. Failed, interrupted, cancelled, stale, and
contradictory evidence is always visible.

The final answer reconciles evidence instead of voting on it. It ranks conclusions or recommended
actions, cites their supporting sources, separates verified local behavior from external claims,
marks marketing or benchmark caveats, and states coverage gaps. A large swarm increases coverage;
it does not turn agreement into proof.

## Progress Surfaces

The existing Subagents, Activity, and Now surfaces project the durable task and board state. A swarm
shows its requested budget and objective, admitted/starting, running, completed, failed, and
cancelled/interrupted counts, current lane descriptions, latest evidence timestamp, and load or
cancellation failures. These panels hydrate from durable state after reload and remain mounted after
their first visit so switching surfaces preserves navigation, selection, scroll, and dock state.
