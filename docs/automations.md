# Automations

Automations are durable local workflows that run Agent and Skill steps on a schedule and deliver their results inside TurenOS. They use the canonical local TurenOS server and are independent of the conversation that created them.

For the scheduler, lease model, storage, and local HTTP surface behind them, see
[Automations internals](./automations-internals.md).

## Create An Automation

Open **Automations** from the left rail. The builder provides reusable starter blueprints for common workflows, including daily briefings, CI failure triage, and documentation drift.

The builder is a node canvas: the schedule trigger, each workflow step, and TurenOS delivery appear as connected nodes. Selecting a node opens its configuration in the inspector panel, and the `+` connectors insert a step at that position. Saved Automations have two tabs: **Editor** for the canvas and **Runs** for run history. The sidebar list shows each Automation's most recent run status.

An Automation contains:

- **Schedule trigger**: a fixed interval using `s`, `m`, `h`, or `d`, with a minimum of 60 seconds.
- **Workflow steps**: one to twelve ordered Agent or Skill steps. Steps can be added, removed, and reordered in the builder.
- **Project**: the local project and permission boundary used by every step.
- **Agent, model, and effort**: workflow-level execution choices. A model that advertises reasoning
  tiers also offers an **Effort** selector.
- **Per-step execution**: any step may override the agent, model, or effort in its inspector under
  **Execution**. A step that selects nothing inherits the Automation's own choices.
- **TurenOS delivery**: every run is a Session whose transcript contains each step and its final result.

Project is optional. When it is left blank, the Automation runs from TurenOS's default global data directory and that resolved directory is stored with the Automation and each run. This is useful for prompts that do not need a repository; Agent and Model choices remain available without selecting a project.

The composer also supports a one-step quick create command:

```text
/automation 30m Check CI and summarize actionable failures
```

## Asking An Agent

Mention `@automations` in the composer to point an agent at this surface. The mention is a reference to the surface itself, not a snapshot: it tells the agent that Automations exist and which tools read and change them, and the agent reads the current state when it runs.

Agents work through three tools:

- `automation_list` reads every Automation with its status, interval, and steps.
- `automation_create` creates one from a name, an interval, and ordered steps. Each step is an agent turn, or a skill turn when it names a skill. Step binding IDs are derived from step names using the same rule the builder uses.
- `automation_update` renames, re-intervals, or replaces the steps of an existing Automation, and pauses, resumes, or deletes it.

Creating or changing an Automation goes through the permission system under the `automation_create` and `automation_update` actions, so agent-created schedules are approvable like any other durable side effect. An Automation created without an explicit directory runs in the session's own project directory.

## Blueprints

Blueprints are ready-to-edit workflow starters rather than hidden scheduled jobs. Selecting a blueprint fills its name, interval, and ordered steps; the Automation is not created until **Create automation** is pressed.

The built-in catalog currently includes:

- Blank
- Daily briefing
- CI failure triage
- Docs drift

## Step Data Bindings

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

This follows the same product pattern as Hermes Automation Blueprints while keeping creation, editing, execution, and delivery inside TurenOS.

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

## Durability And Recovery

Automation definitions and runs are stored in SQLite. Existing installations retain the physical `loop` and `loop_run` table names as an internal migration detail.

- Claimed work can be recovered with the same Session and message identities.
- Running work with an expired lease becomes stale and is not replayed automatically when provider or tool side effects are ambiguous.
- Missed intervals coalesce into one overdue occurrence rather than replaying every missed tick.
- Cancellation is persisted and interrupts the active TurenOS Session.

## Limits

- Minimum interval: 60 seconds.
- Maximum workflow steps: 12.
- Maximum active Automations: 50.
- Maximum lifetime: seven days from creation.
- Overlap policy: skip.

## Local Server Boundary

Automation management always targets the canonical local server. Listing Automations reads the process-global SQLite index without opening project directories. Project filesystem and catalog access occur only while configuring or executing a workflow.

The HTTP and generated SDK surfaces currently retain `/api/loop` naming for storage and client compatibility. `/automations` is the canonical in-app product route; legacy `/loops` links redirect there.
