# Automations

Automations are durable workflows that run Agent and Skill steps on a schedule and deliver their results inside TurenOS. They run on the currently selected configured TurenOS server and are independent of the conversation that created them.

For the scheduler, lease model, storage, and HTTP surface behind them, see
[Automations internals](./internals.md).

## Create an Automation

Open **Automations** from the left rail. The builder provides reusable starter blueprints for common workflows, including daily briefings, CI failure triage, and documentation drift.

The builder is a node canvas: the schedule trigger, each workflow step, and TurenOS delivery appear as connected nodes. Selecting a node opens its configuration in the inspector panel, and the `+` connectors insert a step at that position. Saved Automations have two tabs: **Editor** for the canvas and **Runs** for run history. The sidebar list shows each Automation's most recent run status.

An Automation contains:

- **Trigger**: an interval schedule, a cron schedule, or a server event trigger (file-change or session-end). Intervals use `s`, `m`, `h`, or `d`, with a minimum of 60 seconds.
- **Workflow steps**: one to twelve ordered Agent or Skill steps. Steps can be added, removed, and reordered in the builder.
- **Project**: the selected server's project and permission boundary used by every step.
- **Agent, model, and effort**: workflow-level execution choices. A model that advertises reasoning
  tiers also offers an **Effort** selector.
- **Per-step execution**: any step may override the agent, model, or effort in its inspector under
  **Execution**. A step that selects nothing inherits the Automation's own choices.
- **TurenOS delivery**: every run is a Session whose transcript contains each step and its final result.

Project is optional. When it is left blank, the Automation runs from the selected server's default global data directory and that resolved directory is stored with the Automation and each run. This is useful for prompts that do not need a repository; Agent and Model choices remain available without selecting a project.

## Composer commands

Two slash commands create a recurring prompt without opening the builder. Both take an interval of
`<integer><s|m|h|d>` of at least 60 seconds, reject prompts with attachments, and turn on the Automations surface if it
was off. The composer recognizes them only in normal mode and only while the new layout designs setting
(`settings.general.newLayoutDesigns`) is on; otherwise the text is sent as an ordinary prompt.

```text
/automation 30m Check CI and summarize actionable failures
/loop 30m Check CI and summarize actionable failures
/loop stop
/loop
```

- `/automation <interval> <prompt>` creates a one-step Automation named after the prompt.
- `/loop <interval> <prompt>` asks for confirmation, then creates a loop named `Loop: <prompt>` in the current project
  that runs with the composer's current agent, model, and variant.
- `/loop stop` pauses the project's only active Automation, whether or not `/loop` created it, and cancels its
  in-flight run. When several are active it opens Automations to choose one; when none is, it says so.
- `/loop` or `/loop list` opens Automations for the current project.

Automation and loop runs are sessions with the origin `automation`; their Session IDs are `ses_loop_<run ID>`. The Home
session library keeps them out of **All**, which shows only sessions you started, and groups them under the **Loops**
filter.

## Asking an agent

Mention `@automations` in the composer to point an agent at this surface. The mention is a reference to the surface itself, not a snapshot: it tells the agent that Automations exist and which tools read and change them, and the agent reads the current state when it runs.

Agents work through three tools:

- `automation_list` reads every Automation with its status, schedule, and steps.
- `automation_create` creates one from a name, exactly one trigger (an interval, a cron expression, or a server file-change / session-end event trigger), and ordered steps. Each step is an agent turn, or a skill turn when it names a skill. Step binding IDs are derived from step names using the same rule the builder uses. A step may also carry a `when` condition and an `on_failure` policy (see below).
- `automation_update` renames, reschedules (interval, cron, or event trigger), or replaces the steps of an existing Automation, and pauses, resumes, or deletes it.

Creating or changing an Automation goes through the permission system under the `automation_create` and `automation_update` actions, so agent-created schedules are approvable like any other durable side effect. An Automation created without an explicit directory runs in the TurenOS default global data directory.

## Blueprints

Blueprints are ready-to-edit workflow starters rather than hidden scheduled jobs. Selecting a blueprint fills its name, interval, and ordered steps; the Automation is not created until **Create automation** is pressed.

The built-in catalog currently includes:

- Blank
- Daily briefing
- CI failure triage
- Docs drift

## Schedule and event triggers

An Automation fires on exactly one trigger: an interval, a cron schedule, or a server event. Switching trigger kinds later replaces the schedule; an Automation never combines them.

**Cron schedules** use five fields — `minute hour day month weekday`, at most 120 characters — for example `0 9 * * MON-FRI` for 9am on weekdays. Fields accept `*`, lists (`1,15`), ranges (`9-17`, `MON-FRI`), and steps (`*/5`, `9-17/2`; steps run from 1 to 59). Month names (`JAN`–`DEC`) and weekday names (`SUN`–`SAT`) are case-insensitive, and `7` means Sunday just like `0`. When both day-of-month and day-of-week are restricted, a day matching either one fires.

Cron fire times follow the Automation's IANA timezone (for example `America/New_York`); the default is `UTC`. Editing an Automation accepts at most one of a new interval, a new cron expression, or a new event trigger, and clears the previous schedule.

**File-change triggers** watch the Automation's own directory on its selected server: each of 1 to 20 relative glob patterns (at most 256 characters each, never absolute and never escaping the directory, e.g. `src/**/*.ts`) is matched against files changed under that directory, and files outside it are ignored. The matcher supports `*`, `?`, and `**` path segments. The validator also accepts characters such as `{}`, `[]`, and `!`, but the matcher treats them as literal characters, not brace, class, or negation syntax. Rapid changes coalesce: after the last matching change, the Automation waits out its debounce (`debounceMs`, default 1000 ms, 0 to 60000 ms) before firing once.

**Session-end triggers** fire each time a Session step on the selected server in the Automation's directory ends (`success`) or fails (`failure`), not once when the whole Session finishes. Optional filters narrow which events count: `outcomes` (`success` and/or `failure`), a `sessionID`, and/or an `agent`. Omitted filters match anything, and the scheduler's own Automation runs never fire it. An `agent` filter also passes when the Session has no recorded agent, and a Session whose directory cannot be resolved matches every session-end Automation regardless of directory.

Event Automations have no ticking schedule: they stay active with no next run time until a matching event fires. If an event arrives while an earlier occurrence is still running, it is recorded as `skipped`, exactly like an overlapping interval tick. Events are delivered by the scheduler on the selected server — there is no network trigger source.

## Step data bindings

Every step's binding ID is derived from its name (for example, `Gather updates` becomes `steps.gather_updates`). Renaming a step re-derives its ID and rewrites any bindings that referenced it, so existing references keep resolving.

Every completed step persists an immutable output containing display text, strict JSON when the response is valid JSON, and file/output artifacts. Later steps can insert that data with the builder's **Insert data** controls or type bindings directly. When a previous run produced JSON output, the inspector also offers that output's properties as one-click bindings:

```text
{{ steps.research.output }}
{{ steps.research.output.repository }}
{{ steps.audit.artifacts }}
{{ trigger.type }}
{{ trigger.scheduledAt }}
{{ trigger.payload.repository }}
```

`output` resolves to parsed JSON when available and otherwise to the step's final text. Objects, arrays, and artifacts are serialized as JSON when inserted into a prompt. A step may reference only earlier steps, and malformed or forward references are rejected when the Automation is saved.

The selected project path is available as `trigger.payload.repository` and `trigger.payload.directory`. Future event triggers can add more fields under the same `trigger.payload` namespace without changing workflow expressions.

## Step conditions

A step may carry two flow-control fields:

- `when`: an optional condition string. Bindings in it are resolved first, and the step is skipped when the result is blank or falsy: `""`, `false`, `0`, `no`, `off`, `skip`, `null`, or `undefined` (case-insensitive). Omit it to always run. At most 2000 characters.
- `on_failure`: exactly `stop` or `continue`. `stop` fails the run at that step; `continue` records the error on the step and runs the next one. Omit it to stop. There is no `skip` policy — overlapping occurrences are what get recorded as `skipped`. A `when` condition that fails to evaluate is handled the same way as a failed step.

The agent tools spell the failure policy `on_failure`; the stored workflow and the `/api/loop` payloads spell it `onFailure`. They are the same field. The builder has no controls for `when` or the failure policy, but it keeps both when it saves a step, so set them through an agent or the API.

## Execution

Each occurrence snapshots the complete workflow before execution. Editing an Automation never changes a run that was already claimed.

The scheduler:

1. Claims one occurrence transactionally.
2. Records and creates a deterministic child Session.
3. Admits each workflow step with a stable message identity.
4. Captures and atomically persists each step's text, JSON, and artifacts with the recovery cursor.
5. Resolves explicit data bindings before admitting the next step.
6. Loads a selected Skill at the start of its step.
7. Stores the terminal run result and exposes step outputs plus **Open in agent chat** from run history.

Different Automations may run concurrently. One Automation never overlaps itself; a due occurrence is recorded as skipped while an earlier occurrence remains active.

Automation steps run with the same tools an ordinary Session has, including tools hosted by enabled MCP Extensions. Managed MCP servers are contacted the first time a turn assembles its tools, so an Automation that never runs never starts them.

## Durability and recovery

Automation definitions and runs are stored in SQLite. Existing installations retain the physical `loop` and `loop_run` table names as an internal migration detail.

- Claimed work can be recovered with the same Session and message identities.
- Running work with an expired lease becomes stale and is not replayed automatically when provider or tool side effects are ambiguous.
- Missed intervals coalesce into one overdue occurrence rather than replaying every missed tick.
- Cancellation is persisted and interrupts the active TurenOS Session.

## Limits

- Minimum interval: 60 seconds.
- Cron expression: five fields, at most 120 characters.
- Maximum workflow steps: 12.
- Maximum active Automations: 50 overall, and 10 per project directory.
- Maximum lifetime: seven days from creation. An expiry can be set earlier but never extended past that. When it passes, the Automation's status becomes `expired`: it stops firing, and edits are rejected with "Loop has expired". To keep the workflow running, create a new Automation from it.
- Overlap policy: skip.

## Server selection

Automation management targets the server selected in the **Run on** control. Each configured server owns its own Automation definitions and scheduler. Listing Automations reads that server's process-global SQLite index without opening project directories. Project filesystem and catalog access occur only while configuring or executing a workflow on the selected server.

The HTTP and generated SDK surfaces currently retain `/api/loop` naming for storage and client compatibility. `/automations` is the canonical in-app product route; legacy `/loops` links redirect there.

## Source

- [`packages/core/src/loop.ts`](../../../packages/core/src/loop.ts)
- [`packages/forge/src/loop/scheduler.ts`](../../../packages/forge/src/loop/scheduler.ts)
- [`packages/core/src/tool/automation.ts`](../../../packages/core/src/tool/automation.ts)
- [`packages/app/src/pages/loops.tsx`](../../../packages/app/src/pages/loops.tsx)
