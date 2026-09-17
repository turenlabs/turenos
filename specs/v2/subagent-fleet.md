# Subagent Fleets

## Goal

A single orchestrating agent must be able to admit, order, and reconcile more than a thousand durable subagent tasks without spending a provider turn per admission and without a capacity failure ever losing work. "1k+ subagents" is an admission target, not a concurrency target: every active child is a whole Session with its own provider stream and tool subprocesses, so the active pool stays bounded by `subagents.max_concurrent` while the admitted backlog sits in a durable queue.

## Task Lifecycle

`SessionTask.Status` gains `queued` ahead of `starting`:

```text
queued -> starting -> running -> completed | failed | interrupted
queued -> cancelled
terminal -> queued   (send resume at capacity)
queued -> running    (resumed-task promotion)
```

- `queued` means the task row and its pending `spawn` operation are durable but `resumeSpawn` has not run: the child Session does not exist yet, no prompt input has been admitted, and nothing consumes a provider stream. `queued` is not an active status — it does not count against `countActive`, cannot settle, and `authorizeRun` rejects it like any non-running state.
- `spawn` never fails for capacity. When the configured active limit is full, the task is admitted as `queued` and `spawn_agent` returns immediately with `status: "queued"`. `ActiveLimitError` remains only as the projection's hard-cap defect guarding `MAX_ACTIVE_PER_ROOT` active rows.
- Promotion claims a queued task as `queued -> starting`, then runs the existing `resumeSpawn` — child Session creation, prompt admission, applied operation, `starting -> running` — unchanged. Claiming before side effects keeps the existing activation rule (`-> running` requires an applied `spawn` or `send` operation) intact.
- `send` to a terminal task at capacity takes the same queue: the follow-up input is admitted to the existing child Session's durable inbox unpromoted and the task transitions `terminal -> queued` carrying its applied `send` operation. Promotion of a resumed task is `queued -> running` with no new operation — the applied `send` already on record authorizes the activation — followed by a wake; the child drain promotes the pending inbox input at its normal boundary. Cancelling a resumed-but-queued task must also retire the unpromoted inbox row (`time_cancelled`) so a cancelled child never wakes to stale work.
- `send` to a `queued` task is rejected like `send` to `starting`: the queued prompt has not reached a safe boundary. Prompt amendment for queued work is a follow-up.

## Promotion

`SessionTaskV2.promote(rootSessionID)` promotes the oldest queued tasks in `time.created, id` order while `countActive(rootSessionID)` is below the configured limit, and returns the child Session IDs to wake. Promotion runs under `roots.withLock(rootSessionID)` so it serializes with spawn, send, interrupt, and settle exactly like the limit check it replaces. The service stays global and returns identities; the caller that owns `SessionExecutionControl` performs the wakes.

Drivers, in order of coverage:

1. **Inline on freed slots.** Every transition that removes a task from the active set — `settleRun`/`settle` terminal transitions and interrupt/cancel completions — runs a promotion pass before returning. The drain settlement path in `SessionExecutionLocal` wakes promoted children alongside the existing parent settle advisory; tool-driven interrupt paths wake them through `control` the same way `spawn` does today.
2. **A process-global promotion fiber.** `SessionExecutionLocal` runs a scoped fiber that awaits the task-changed signal and the `PRAGMA data_version` external-change poll — the same dual wake `wait` already uses — and promotes any root with queued tasks and free capacity. This covers process restart, writes committed by another process, and the zero-active backlog case where no terminal transition exists to trigger inline promotion.

`MAX_TASKS_PER_ROOT` (10,000) bounds non-terminal tasks per root; `spawn` beyond it fails with `QueueLimitError` as an ordinary `ToolFailure`. `subagents.max_concurrent` keeps its meaning — the promotion ceiling — and `resolveActiveLimit` still clamps it to `MAX_ACTIVE_PER_ROOT`.

## Orchestrator Depth

`MAX_DEPTH` becomes two. Depth alone is not the grant: a task-owned Session may spawn only while its owning task is `running` **and** that task's authority carries `orchestrate: true`, a grant recorded at spawn time.

- `Authority` gains `orchestrate: Schema.Boolean` (default false). `spawn_agent`/`spawn_agents` accept `orchestrate: true` for a direct child, gated by a distinct `orchestrate` permission action so policy can forbid delegation-of-delegation independently of `spawn_agent`.
- `spawnable` becomes `!owner || (owner.depth < MAX_DEPTH && owner.authority.orchestrate === true)`; a depth-two task never sees `spawn_agent`.
- The active pool remains per **root**: an orchestrator, its workers, and the root's own direct children share the same `subagents.max_concurrent` slots. A running orchestrator occupies one slot; its workers draw the rest. `MAX_ACTIVE_PER_ROOT` therefore still bounds a root graph at fifty-one live Sessions.
- `descendants`/`cancelTree` gain a real one-level traversal by `parentTaskID` — interrupting an orchestrator cancels its workers first. Depth is still bounded so traversal cannot recurse.
- `ancestorPermissionSets` accumulation is unchanged: an orchestrator's workers inherit the same permission narrowing as any nested spawn.

## Waves

`Info.wave` is an optional bounded string (`MAX_WAVE_NAME_LENGTH` = 64) recorded at spawn, stored in a `wave` column indexed on `(parent_session_id, wave)`. A wave is a tag, not an entity: it is scoped to the parent session, resolved at call time, and may be reused after a wave drains.

- `spawn_agent`/`spawn_agents` accept `wave`.
- `wait_agents` accepts `wave` as an alternative to `task_ids`: resolve the caller's non-terminal direct children in that wave, then apply the existing barrier. Output gains `{ queued, running, terminal }` counts alongside `timed_out`/`parked`.
- `interrupt_agent` accepts `wave`: queued members cancel immediately with no sessions to stop; running members go through the durable interrupt machinery unchanged.
- `list_agents` gains `wave` and `status` filters plus an aggregate `counts` field, so a thousand-task graph is readable without paging 32-row previews.

## Batch Spawn

`spawn_agents` admits a bounded `items` array (`MAX_SPAWN_BATCH` = 256) of `{ agent, prompt, description, wave?, model?, write_roots?, commands?, orchestrate? }` in one tool call. `Actor` gains an optional `item` discriminator (`NonNegativeInt`) so each element reconciles as an independent durable operation under one tool call; `operationByActor`, the actor claim table, and `actorKey` key on the full `(sessionID, assistantMessageID, toolCallID, item)` tuple.

A retried batch re-executes per item: applied operations return their recorded task, pending operations resume, and domain failures (unknown agent, denied permission, queue limit) surface per item in `{ results: [{ index, task_id?, error? }] }` rather than failing the batch. Per-item limits — prompt bytes, write roots, commands — are unchanged.

## Recovery

`reconcile` leaves `queued` tasks and their pending `spawn` operations intact: a queued spawn never began side effects, and `resumeSpawn` is already idempotent on the preallocated child Session identity and message ID, so the promotion fiber re-drives it after restart. `starting` and `running` tasks still settle as `interrupted` exactly as today. This strictly improves on current behavior, where a spawn racing a crash loses the task.

## Surface Updates

- Subagent guidance replaces "a further spawn fails until one settles" with queued-admission semantics, teaches orchestrators the wave and batch workflow, and makes "avoid nested delegation" conditional on the absent `orchestrate` grant rather than universal.
- `spawn_agent`'s description shifts from "returns after its prompt is durably admitted" to "returns after the task is durably admitted"; `queued` is a normal, model-visible status.
- `SessionEvent.Task.Updated` already carries the complete task; `queued` and `wave` reach clients without new event types. Queue depth is presentable as first-class UI state.
- `@swarm` stays at `Swarm.MAX_SIZE = 50`. Its workers now queue-and-promote instead of hitting the active-limit failure; fleet-scale fan-out goes through orchestrators, not `@swarm`.

## Rate Limits

The admission queue bounds how many provider streams exist; it does not pace them. Process-wide transport pacing — a shared `llm.stream` concurrency budget optionally fed by the `x-ratelimit-remaining`/`retry-after` headers `RequestExecutor` already parses — is the follow-up that protects provider quota across roots. The mechanisms stay separate: queue at the task layer, pace at the transport layer.

## Follow-Ups

- Provider pacing and rate-limit-aware scheduling, per the section above.
- `send` to a `queued` task as prompt amendment rather than rejection.
- Per-parent fairness in promotion order; unmodified FIFO lets one orchestrator's flood starve a sibling parent's queue.
- Wave priorities and in-place reorder.
- Clustered placement. Queued tasks are placement-free until promotion — the child Session does not exist — which is the natural hook for remote execution when clustering lands.
