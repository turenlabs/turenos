# Automations internals

This is the engine reference for Automations: scheduling, durability, storage, and the
local HTTP surface. For how to build and run one in the app, see [Automations](./automations.md).

Automations are durable scheduled runs that execute on the local TurenOS server. Each occurrence
creates a fresh Session, capturing output and errors in the run history, and survives restarts
independently of the conversation that created it.

The durable identifiers are still `loop`: the tables are `loop` and `loop_run`, the routes are
under `/api/loop`, and the service is `Loop`. Those names are load-bearing for existing installs
and are deliberately unchanged; only the product surface was renamed.

## Overview

An Automation encapsulates:

- A **prompt** that runs unchanged on each execution
- A **project directory** where the run executes
- An optional **agent** (CLI, GUI explorer, code agent, etc.) and **model** (Claude, Sonnet, etc.)
- A **schedule** — an interval, a cron expression, or a local event trigger — plus an **expiration** date
- Durable **run history** with status, timing, and errors

The Automation scheduler polls the database every 5 seconds, claims due occurrences atomically via SQLite's transaction guarantee, spawns a child Session, and persists output and status. Each run is isolated: if a run takes longer than the interval, the next due tick is recorded as `skipped`, not queued. If the sidecar crashes mid-run, recovery uses the same Session ID and message ID, so provider and tool side effects are idempotent.

## Create an Automation

Open **Automations** from the sidebar. The form accepts:

- **Name**: a short identifier for the Automation (e.g. "Daily CI sweep")
- **Steps**: 1 to 12 ordered Agent or Skill steps that run in a fresh Session with its own tools and context; nothing from the prior run is carried over
- **Project**: the local project directory; the Automation runs in that directory's context
- **Schedule**: exactly one trigger — an **Interval** (a fixed duration between occurrences using `s`, `m`, `h`, or `d`, e.g. `5m`, `1h`, `1d`; minimum 60 seconds), a **Cron** expression (five fields `minute hour day month weekday`, at most 120 characters, e.g. `0 9 * * MON-FRI`), or a local **Event** trigger (file-change or session-end). Cron fire times follow the **Timezone** (an IANA name such as `America/New_York`, default `UTC`). Editing accepts at most one of a new interval, cron expression, or event trigger and replaces the previous schedule
- **Agent**: optional selection of a specific Agent to run the prompt. If unset, the system default is used. Once set, every occurrence uses that Agent
- **Model**: optional selection of a specific model/provider pair (e.g. Claude Opus from Anthropic). If unset, the system default is used. Once set, every occurrence uses that model

Once created, the Automation appears in the list with its next scheduled run time. The **Run now** button starts an immediate execution without affecting the schedule. The **Pause** and **Resume** buttons pause the Automation without deleting it; resuming recomputes the next run from its schedule (one interval out, the next cron occurrence, or no scheduled time for event triggers). **Delete** removes the Automation entirely.

## Run History

Each Automation displays a **Run history** showing every scheduled and manual execution:

- **Scheduled**: a tick that was due and claimed by the scheduler
- **Manual**: a run triggered by the **Run now** button
- **Event**: a run fired by a matching file-change or session-end event
- **Status**: `claimed` (waiting to start), `running` (in progress), `succeeded` (completed normally), `failed` (error), `cancelled` (explicit cancellation), `skipped` (overlapped with an active run, or an event that arrived while one was active), `stale` (lease expired before completion)
- **Time**: when the run was created, started, and completed
- **Error**: if present, the exception or cancellation reason
- **Cancel**: available while claimed or running; stops the active Session and marks the run cancelled

## Quick Create

The composer supports a one-step quick command:

```text
/automation 1h Check CI status and report failures
```

This creates an Automation with the given interval and prompt, using your current project directory. The Automation is paused until you open it to confirm settings.

## Mentioning Automations

Mention `@automations` in the composer to point an agent at the Automations surface. The mention gives agents access to:

- `automation_list`: read every Automation with its status, schedule, and next run time
- `automation_create`: create a new Automation from a name, one trigger (interval, cron, or local event), and 1 to 12 ordered steps with optional per-step `when` / `on_failure`
- `automation_update`: edit name, schedule, agent, model, or steps on an existing Automation, or pause, resume, or delete it via its status

Immediate runs and run cancellation live in the app and the HTTP API below, not in agent tools. Agent actions go through the permission system, so agent-created Automations are approvable like any durable side effect.

## Execution

Each due occurrence follows these steps:

1. The scheduler claims the occurrence transactionally
2. A fresh child Session is created with a deterministic ID
3. The prompt is admitted with the selected agent and model
4. Output, errors, and run status are persisted atomically
5. The run status and error are visible in the Automation's run history

### Step Conditions

Each workflow step carries optional `when` (at most 2000 characters) and `onFailure` (`"stop"` or `"continue"`, default `stop`). There is no `"skip"` policy value. Before a step runs, its `when` bindings resolve against earlier step outputs and the trigger payload; a blank or missing condition always runs, otherwise the step is skipped when the resolved value, trimmed and lowercased, is one of `""`, `false`, `0`, `no`, `off`, `skip`, `null`, or `undefined`. A failed step with `onFailure: "continue"` records its error on the step and the run proceeds; any other failure fails the run.

### Overlap Policy

Only one occurrence of the same Automation can run concurrently. If a due occurrence is claimed while an earlier one is still running, the due occurrence is recorded as `skipped`. This prevents runaway cascades when a run takes longer than the interval.

### Missed Intervals

If an Automation is paused, the server is down, or the sidecar is offline, scheduled occurrences are missed. When the scheduler resumes, it does not replay every missed tick. Instead, it schedules the next occurrence one interval after the current time. This prevents catch-up storms when many ticks are overdue.

For example, if an Automation runs every hour and is paused for 8 hours, the next occurrence is scheduled one hour from now, not eight times in succession.

### Durability and Recovery

- Automation definitions and runs are stored in SQLite
- Claimed work recovers using the same Session and message IDs, so provider and tool side effects are idempotent
- Running work with an expired lease (5 minutes) becomes `stale` and is not retried automatically when side effects are ambiguous
- Explicit cancellation persists and interrupts the running Session

## Limits

- **Minimum interval**: 60 seconds
- **Cron expression**: five fields, at most 120 characters
- **Maximum active Automations**: 50 globally, and 10 per project directory (directory plus workspace)
- **Maximum lifetime**: 7 days from creation
- **Overlap policy**: skip (no concurrent runs)

## Local Server Boundary

Automation management always targets the canonical local sidecar. Listing Automations and their metadata reads a process-global SQLite index without opening or monitoring project directories. Project context is resolved only when configuring the Automation or at the moment of execution.

The HTTP API routes use `/api/loop` naming for internal compatibility. The canonical app route is `/automations`; legacy `/loops` links redirect there.

## Execution Context

Each Automation run has access to:

- **Tools**: the same tools available in a normal Session (file access, terminal, MCP servers, etc.)
- **Agent and model**: the selections made when creating the Automation, or the system default if none were specified
- **Project directory**: the directory selected when creating the Automation
- **Prompt**: exactly as entered when the Automation was created (can be edited later, but existing runs keep the original)

MCP servers are contacted lazily the first time a run's turn assembles tools, so an MCP server is never started unless an Automation actually uses it.

## Technical Architecture

### Storage

Automation definitions and runs are stored in SQLite tables:

- **`loop`** table: Automation metadata (name, prompt, directory, agent, model, status, schedule, expiration, timestamps)
- **`loop_run`** table: Individual run records with status, lease info, session ID, errors, and timestamps

The tables are indexed by:

- `(status, next_run_at)` for efficient due-work queries
- `(status, lease_expires_at)` for stale-lease detection
- `(loop_id, scheduled_at)` unique constraint to prevent duplicate occurrences

### Scheduling and Claiming

The scheduler wakes every 5 seconds and:

1. **Queries** `LoopTable` where `status = 'active'` and `next_run_at <= now()`, ordered by due time
2. **Inserts** a new row into `LoopRunTable` with `status = 'claimed'` and an owner ID
3. **Atomically claims** via the unique `(loop_id, scheduled_at)` constraint—only one owner succeeds
4. **Updates** the Automation's `next_run_at` to `now() + interval` for interval schedules, or to the next cron occurrence for cron schedules

If a due occurrence is inserted while an active run exists, the new row is inserted with `status = 'skipped'`.

Event Automations never appear in the due query: they are stored active with `next_run_at = null` and gain runs only through the core `fireEvent` call. Resuming a paused cron Automation recomputes its next run from the cron expression; resuming an event Automation restores it with no next run time.

### Durability and Recovery

**Durable Session Identity:**
Each run uses a deterministic Session ID derived from the Automation ID and scheduled time. If the sidecar crashes after the Session is created but before it completes:

1. The scheduler polls the `lease_expires_at` column
2. If the lease has expired (5-minute default), the run is marked `stale`
3. If the run was claimed but never created a Session (no session_id), it can be reclaimed and restarted
4. If the run has a session_id, that Session is reused—the scheduler retrieves it and continues

**Idempotent Message Submission:**
Each Run constructs a prompt message ID via `msg_loop_${run.id}`. If the same run is re-admitted after a crash, the provider sees the same message ID and skips duplicate tool calls.

**Atomic State Transitions:**

- Creation: Automation record inserted with `status = 'active'` in a single transaction
- Claiming: Run record inserted with `status = 'claimed'`, or `status = 'skipped'` if overlap detected
- Completion: Run marked `succeeded`, `failed`, `cancelled`, or `stale` with final error and timestamp

### Session Creation

When a claimed run is ready to start:

1. A child Session is created with the Automation's selected agent and model
2. The prompt is admitted with the message ID `msg_loop_${run_id}`
3. Output and errors are streamed into the Session
4. The Session completion is captured as the run's `time_completed`

### Lease Model

Each claimed or running row has a lease:

- **`lease_owner`**: identifier of the scheduler or worker claiming the run
- **`lease_expires_at`**: Unix timestamp when the lease expires (typically 5 minutes from now)

Renewal happens every 1 minute while a run is active. If a renewal fails or the clock advances past `lease_expires_at`:

- The run is marked `stale` and is not retried (to avoid duplicate side effects in ambiguous scenarios)
- A human operator must investigate the run history and manually clean up or recreate the work

### Overlap Policy

Automations enforce `skip` overlap: at most one occurrence of an Automation runs concurrently.

When claiming work:

1. Check if any other run for the same Automation has `status` in `('claimed', 'running')`
2. If yes, insert the new occurrence with `status = 'skipped'` and do not start it
3. If no, insert with `status = 'claimed'` and proceed

This prevents cascading runaway execution when a run's duration exceeds the interval. Event deliveries use the same rule: `fireEvent` on an Automation with an active run records the event as `skipped`.

### Event Triggers

Event Automations replace the ticking schedule with a local trigger stored as `trigger_type` / `trigger_config`:

- **file-change** (`paths`, optional `debounceMs`): 1 to 20 relative glob patterns, each 1 to 256 characters, never absolute, never escaping the directory (`..`), and limited to `[A-Za-z0-9_.\-/*?{}[\]!+,@()|]`. The scheduler maps each changed file to a path relative to the Automation's directory, drops files outside it, and fires only on pattern match. Matches within `debounceMs` (default 1000, 0 to 60000) coalesce into one run per Automation, and the run payload carries `{ file, event: "change", directory }`.
- **session-end** (`outcomes`, `sessionID`, `agent`, all optional): fires when a local session in the Automation's directory ends with a matching outcome (`success` / `failure`), session, and agent. Omitted filters match anything; the scheduler's own Automation runs (`ses_loop_*`) never fire it. Event payloads are limited to 20 fields and 8000 serialized characters.

Both arrive through the core `fireEvent` call, which rejects a trigger-type mismatch, applies the session-end filter, and records `skipped` on overlap. `fireEvent` is local to the sidecar: the HTTP API below exposes create/list/get/edit/pause/resume/delete/run-now/run-list/run-get/run-cancel only, with no event endpoint.

### Time Zone Handling

Interval schedules are measured in absolute duration (seconds). Cron schedules instead fire on wall-clock time in the Automation's IANA `timezone` (default `UTC`; unrecognized names are rejected): the scheduler resolves the next matching minute in that zone, so occurrences follow local time. Event triggers carry a timezone field but do not tick, so it has no scheduling effect for them.

## Querying and Listing

Automation metadata is read from a **global process-wide SQLite index** without requiring Location middleware or project directory access. Listing `/api/loop` returns all Automations across all projects, each with:

- ID, name, prompt, selected agent/model, schedule, status
- Project directory (stored as plain text in the `loop` table)
- Next scheduled run time
- Creation and update timestamps

Directory context is resolved only when:

- Creating or editing an Automation (to validate the directory exists)
- Executing a run (to set the child Session's working directory)

This separation allows Automation management to be independent of project state and filesystem availability.

## API Routes

All Automation operations target the local sidecar:

- `GET /api/loop` → list all Automations (global index)
- `POST /api/loop` → create (requires `location`, `name`, `prompt`, `intervalSeconds`, optional `agent`, `model`)
- `GET /api/loop/:loopID` → fetch one Automation's metadata
- `PATCH /api/loop/:loopID` → edit name, prompt, interval, agent, model, expiration
- `POST /api/loop/:loopID/pause` → pause the Automation (next run not scheduled until resumed)
- `POST /api/loop/:loopID/resume` → resume (next run scheduled one interval from now)
- `DELETE /api/loop/:loopID` → delete the Automation and all its runs
- `POST /api/loop/:loopID/run` → trigger an immediate run (not affected by paused status)
- `GET /api/loop/:loopID/run` → list all runs (sorted by scheduled time, newest first)
- `GET /api/loop/:loopID/run/:runID` → fetch one run's details
- `POST /api/loop/:loopID/run/:runID/cancel` → stop an active run and mark it cancelled

There is deliberately no event endpoint: `fireEvent` exists only on the core `Loop` service and is driven by the local scheduler's file watcher and session listeners.

Agent and model are stored as `Agent.ID` and `Model.Ref` (opaque serialized objects) and are passed through to the child Session's `ModelOptions`.
