# Durable subagent workstreams

TurenOS's V2 subagent tools use a durable, bidirectional workstream rather than
making the parent delegate all work and wait for one final answer. A parent can
start children, continue its own work, and receive incremental observations
through the shared [swarm room](./swarm.md#swarm-room). Every child of one root
Session shares that root's room, whether or not the team was started with
`@swarm`.

## The basic flow

```text
parent                         child                         swarm room
  |                              |                               |
  |-- room_post (plan) --------------------------------------->|
  |-- spawn_agent -------------->|                               |
  |<-- admission, not completion |                               |
  |                              |-- room_read / room_claim ---->|
  |                              |-- room_post (finding) ------->|
  |<-- queued room advisory ---------------------------------------|
  |-- send_agent (steer) ------->|                               |
  |                              |-- room_post (status: done) -->|
  |                              |-- room_wait (parked) -------->|
  |-- room_post (decision) ----------------------------------->|
  |                              |-- final report                |
  |-- wait_agents (optional) --->|                               |
```

`spawn_agent` returns after the child prompt is durably admitted. It does not
wait for the child provider turn or final result. The default guidance tells
the parent to use the time after spawning for independent work and to read the
room before repeating a sibling's investigation.

## Tool roles

The coordination tools (`room_read`, `room_post`, `room_claim`, `room_wait`)
are described in [Swarm orchestration](./swarm.md#swarm-room). The task tools
below manage the children themselves. `list_agents`, `peek_agent`, and
`agent_doc` are deferred, so a Session loads them with `tool_load` before
calling them.

### `spawn_agent`

Starts one bounded child assignment and returns a durable task ID, child
Session ID, and current task view. `model` is optional: an omitted model uses
the child agent's configured default, then the parent Session's model.
`write_roots` (up to 16 existing directories inside the active workspace) and
`commands` (up to 32 exact, complete shell strings) grant edit and shell
authority; omitting both makes the child read-only. A spawn fails with an
active-limit error when the Session already runs its configured maximum of
concurrent children (`subagents.max_concurrent`).

The child prompt is followed by a fixed workstream protocol that tells the
child to read the room, claim its lane when a plan exists, post findings as
they are ready, mark its lane done, and park on `room_wait` until a `decision`
or a lane release.

### `send_agent`

Sends additional durable instructions to an existing direct child, or, from a
child, to a sibling's task ID found with `list_agents`. The message promotes at
the target's next provider-turn boundary. Exact tool-call retries reconcile
without duplicating the prompt.

### `wait_agents`

Waits for selected direct children to reach terminal states and returns their
complete durable reports. This is an explicit final-report barrier, not the
normal step after spawning. The default timeout is 2 minutes and the maximum is
10 minutes. A timeout returns snapshots while children remain active; it does
not cancel them. When every still-running child is parked on `room_wait`, the
call returns early with `parked: true` so the parent can post a `decision` or
release lanes and wait again.

### `interrupt_agent`

Stops an obsolete or off-track direct child. The interrupt intent is persisted
first, then local execution gets 5 seconds to stop before cancellation is
committed. A timeout is reported and leaves the intent retryable rather than
pretending that the child stopped.

### `list_agents`

Lists up to 32 tasks: the caller's siblings (when it is a child) and its direct
children, keeping active tasks and the newest terminal ones. Result and error
previews appear only for terminal tasks and are capped at 4,096 characters.

### `peek_agent`

Tails a running direct child's transcript: user prompts, assistant text and
reasoning excerpts, and tool calls with their name, status, and input. Tool
output bodies are never included. It returns 8 entries by default and at most
20, each summary clipped to 400 characters and the whole reply to 8 KiB.

### `agent_doc`

Returns the definition of the caller's own agent or a named agent: name,
description, mode, and the workspace `.forge/agent/<agent>.md` file when one
exists. It pairs with the [agent improvement](./agent-improvement.md) tools,
which the same tool set includes.

### `notify_parent`

Sends one advisory message of at most 8,192 characters directly to the durable
parent Session. It exists only in a task-owned child's tool set. The child
protocol reserves it for blockers and decisions the parent must make; routine
findings belong in the room.

## Parent protocol

The default guidance (`packages/core/src/agent/guidance.ts`) tells the parent
to:

1. Post a `plan` with named lanes so workers can claim a lane instead of
   colliding.
2. Spawn independent children in the same provider turn, in waves no larger
   than the concurrency limit, with disjoint write roots.
3. Keep doing non-overlapping work after admission.
4. Steer running children with `send_agent` and observe them with `peek_agent`.
5. Run at most one adversarial review, only for a concrete high-risk boundary.
6. Delegate exact verification to `qualification`.
7. Interrupt obsolete children with `interrupt_agent`.
8. Post a `decision` to release parked workers, then use `wait_agents` only
   when complete terminal reports are needed.

A prompt that asks a child to post does not mean an entry exists; only
`room_read` or an arriving advisory confirms it. A room entry is an
incremental observation, not a terminal report: `wait_agents` returns the
child's final result.

## Delivery and recovery

- Room entries are persisted before `room_post` returns. Every post queues an
  advisory `SessionInput` (source `swarm_room`, queue delivery) for each other
  live member, so explicit user steers keep priority.
- A member with an undelivered room advisory gets no second one; the room log
  is the record and the advisory only prompts a read. An entry addressed to a
  member or its lane bypasses this coalescing.
- `notify_parent` advisories (source `subagent_advisory`) and child settle
  notices (source `subagent_settle`) arrive the same way, at the parent's next
  provider-turn boundary, without interrupting in-flight work.
- On startup, unpromoted subagent advisories from the previous process are
  cancelled rather than replayed; the task state stays readable through
  `list_agents` and `wait_agents`.

Room content is untrusted observation data. It cannot change the parent task,
permissions, filesystem authority, or tool authority.

## Tool availability

Subagent tools are filtered by agent depth, configured specialist visibility,
and permission rules. The guidance injected into a Session lists the tools and
specialists currently available to that Session, and that list is
authoritative: a tool absent from it cannot be called. The maximum depth is 1
(`MAX_DEPTH` in `packages/core/src/session/task.ts`), so a child never gets
`spawn_agent`. At that depth the guidance still lists the permitted room tools,
`list_agents` and `send_agent` for reaching siblings, and `notify_parent`.

## Verification

Run tests from the package directory, not the repository root:

```bash
cd packages/core
bun test test/session-task.test.ts test/tool-subagent.test.ts test/swarm-room.test.ts
bun test test/simulator/subagent.test.ts test/simulator/turn-matrix.test.ts
bun typecheck
```

## Scope boundary

This protocol applies to the durable V2 `spawn_agent` path. The legacy
`packages/forge/src/tool/task.ts` implementation uses the process-local
`BackgroundJob` path and a foreground wait; it has no room or incremental
updates.

## Source

- [`packages/core/src/tool/subagent.ts`](../../packages/core/src/tool/subagent.ts)
- [`packages/core/src/tool/swarm-room.ts`](../../packages/core/src/tool/swarm-room.ts)
- [`packages/core/src/team/room.ts`](../../packages/core/src/team/room.ts)
- [`packages/core/src/session/task.ts`](../../packages/core/src/session/task.ts)
- [`packages/core/src/session/execution/local.ts`](../../packages/core/src/session/execution/local.ts)
- [`packages/core/src/agent/guidance.ts`](../../packages/core/src/agent/guidance.ts)
- [`packages/forge/src/tool/task.ts`](../../packages/forge/src/tool/task.ts)
- Contract: [`specs/v2/subagent-fleet.md`](../../specs/v2/subagent-fleet.md)
- Tests: [`packages/core/test/tool-subagent.test.ts`](../../packages/core/test/tool-subagent.test.ts), [`packages/core/test/session-task.test.ts`](../../packages/core/test/session-task.test.ts), [`packages/core/test/swarm-room.test.ts`](../../packages/core/test/swarm-room.test.ts)
