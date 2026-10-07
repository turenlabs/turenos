# Automations internals

The process-global Automation scheduler claims due runs from SQLite and executes each run in a Session at its stored Location. A stable Session and prompt identity reconciles admission before provider execution; it does not make provider or tool side effects idempotent. Running work with an unknown outcome becomes `stale` instead of being replayed. For creating and using Automations, see [Automations](./README.md).

The persisted service, tables, and HTTP routes retain the `loop` name for compatibility: `Loop`, `loop`, `loop_run`, and `/api/loop`.

## Storage and claiming

The `loop` table stores definitions and schedules. Each `loop_run` row stores its trigger, execution snapshot, status, lease, Session ID, step cursor, outputs, and error. A unique `(loop_id, scheduled_at)` constraint prevents duplicate scheduled occurrences.

The scheduler does not poll on a timer. It scans once at startup to recover stale leases, then asks `Loop.nextWakeAt` for the earliest time `claimDue` could have work (an active Automation's next run or expiry, a running or claimed run's lease expiry, or a claimed manual run) and sleeps until then, so an idle server takes no write lock. `nextWakeAt` is read-only. A write in this process through `Loop` (create, edit, pause, resume, delete, run, fire, cancel or finish) wakes the scheduler at once, and an empty database or a distant due time still re-reads after at most 60 seconds, which is how a write from another process sharing the database is noticed; a new interval Automation or a manual run created by another process can therefore start up to 60 seconds late. After a scan that claims nothing although a run looked due, the scheduler waits at least 250 ms before looking again, and a failed scan waits one second. Core claims due rows transactionally, marks a new occurrence `skipped` when the same Automation has an active run, and advances the schedule. A missed interval is not replayed once per tick; the next interval is scheduled from the current time. Cron schedules use the Automation's IANA timezone, and their next time is computed from the scheduled time rather than the current time, so after downtime missed cron times are claimed one per scan. Event-triggered Automations have no `next_run_at` and enter through `Loop.fireEvent` on the selected server.

Each claimed run keeps a snapshot of its workflow. Edits to the Automation do not change a run already claimed. Workflow steps execute in order; the run persists each completed step's output and advances its cursor before admitting the next step. A `when` condition can skip a step, and `onFailure: "continue"` records a failed step and proceeds.

## Session execution

The scheduler uses `ses_loop_${run.id}` as the run's Session ID, recording it on the run before execution. It creates or retrieves that Session at the run's stored Location. A one-step run admits `msg_loop_${run.id}`; a workflow step admits `msg_loop_${run.id}_${step.id}` with `resume: false`, then calls `resumePending`. The Session runner owns provider turns and tool execution; the scheduler reads the completed output and updates the run.

Stable prompt IDs reconcile an exact retry of admission if a claimed run is picked up again before execution crosses the provider boundary. They are not sent to the provider as an idempotency guarantee, and they do not suppress a provider request or external tool effect after that work has started.

MCP servers are contacted only when the Session assembles tools for a turn. A configured Automation that never runs does not start them.

## Recovery and leases

A claimed or running row has a five-minute lease, renewed every minute while its scheduler owns the run. An expired **claimed** row can be reclaimed with its existing run and Session identity, step cursor, and outputs, but waits while another run owns the same Automation. Recovery renews at most one claim per Automation in a scan; blocked claims remain durable and do not force immediate scheduler wakeups. An expired **running** row is marked `stale`; it is not restarted automatically because provider or tool effects may already have happened. If execution loses its lease or its outcome is otherwise unknown, the scheduler interrupts local Session ownership and does not replay the turn. Cancellation persists and interrupts the active Session.

Run history exposes `claimed`, `running`, `succeeded`, `failed`, `cancelled`, `skipped`, and `stale` states. Operators must inspect a stale run before deciding whether to create new work.

## Event and API boundaries

File-change triggers match bounded relative globs under the Automation's directory and debounce rapid matches. The scheduler reads the active file-change Automations through `Loop.listFileChange` on each file event. Core caches that list for up to five seconds and clears it after every Automation create, edit, pause, resume of an event Automation, and delete, and after each claim, so another process sharing the database is picked up within the five seconds. Session-end triggers subscribe to `SessionEvent.Step.Ended` and `SessionEvent.Step.Failed`, so they fire at the end of every Session step, and filter outcome, Session ID, and agent; Automation-created Sessions do not trigger them. Both call `Loop.fireEvent` locally, which applies the same overlap rule as scheduled runs. There is no HTTP endpoint for firing an event.

Automation metadata is listed from the selected server's process-global SQLite index. Listing does not open project directories; the run's Location is resolved when execution begins. The [Protocol Loop group](../../../packages/protocol/src/groups/loop.ts) defines the `/api/loop` create, list, get, edit, pause, resume, delete, run, history, and cancellation endpoints and their current payload schemas.

## Limits

The scheduler claims at most 32 runs per scan and scans again immediately while more work is due. The five-minute lease and one-minute renewal are scheduler constants. Definition limits, trigger syntax, and the user-facing workflow are in [Automations](./README.md).

## Source

- [`packages/core/src/loop.ts`](../../../packages/core/src/loop.ts)
- [`packages/forge/src/loop/scheduler.ts`](../../../packages/forge/src/loop/scheduler.ts)
- [`packages/protocol/src/groups/loop.ts`](../../../packages/protocol/src/groups/loop.ts)
