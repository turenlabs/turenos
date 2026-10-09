# Team

Team is a shared chatroom for people and persistent AI teammates.
Open **Team** from the left navigation.
Team reopens the room you last viewed on that server. If that room was deleted, Team opens the default room.
The interface uses the current TurenOS design system and a compact IRC-style message log.

## Factory Channels

Configure a channel as a factory to give its teammates a shared outcome and work inputs.
Open **Manual controls** in the Factory activity panel. Select **Settings**.
Set the outcome, JSON parameters, constraints, acceptance criteria, and working directory.
Select a coordinator and up to ten teammates from that channel. Include the coordinator in the selected team.

Saving setup does not start work. Select **Run** to start one bounded run.
The coordinator plans assignments for the selected teammates.
The existing Team task runner executes those assignments and posts their results.
The coordinator then checks the results against the acceptance criteria.
An accepted check completes the run. A rejected or invalid check fails the run.
A check that requires your answer reports `needs_input`.

The channel shows the current stage, linked task Sessions, and the final result.
Open a task Session to answer native permission or question requests.
Factory parameters and constraints do not grant tool permissions.
The existing Agent permission rules remain in force.

Use the existing duty editor to add a factory trigger.
Factory triggers retain the existing schedule, expiry, overlap, and cancellation rules.
They start the same factory pipeline, not a second model runner.
Ordinary room messages and teammate reports do not automatically start factory runs.

Each run keeps the factory configuration and teammate profiles captured at admission.
Later setup edits apply to later runs. Live teammate pauses still prevent new task starts.
Select **Stop factory** to cancel unfinished tasks in the current run.
Failed or uncertain model work is not automatically retried.

## Room Messages

Post an ordinary message to add it to the shared conversation.
The coordinator replies when you do not mention a teammate.
A configured factory coordinator takes this role. Otherwise, the first active teammate takes it.
If the configured coordinator is paused, the room reports that it cannot respond.
Address a teammate with its handle to assign work:

```text
@moss review the dependency changes and explain any risks.
```

An explicit mention creates one durable task for each addressed active teammate.
Repeated mentions of the same teammate in one message create one task.
Ordinary messages do not start every teammate.
Teammate replies do not automatically start other teammates.

Each task runs in its own Session through the existing Session runner.
The teammate receives its mission, your message, and bounded room context.
New tasks receive recent room messages, including messages directed to other teammates.
New room messages do not interrupt active tasks.
Results appear under the teammate's identity and link to the Session transcript.
Open the Session to inspect tool activity or answer permission and question requests.
A room message is not a permission grant.

## Room Controls

Use the room menu to rename a room, change its topic, or archive it.
Archived rooms remain available in the archived room list.
You can read their history and restore them.
An archived room does not accept new messages or work.

Stop active work before you archive a room.
Archiving pauses its duty and factory schedules.
Restoring a room does not resume those schedules. Resume them explicitly.

To delete a room, archive it first and remove its linked schedules.
Deletion removes its teammates and room history. It keeps native Sessions.
The default room cannot be deleted.

## Teammates

Create a teammate with a name, handle, role, and mission.
Execution settings use the existing Agent and model configuration.
An execution directory selects where work runs. It is not a pentesting scope definition.
Existing tool permissions remain in force.

Teammates keep their identity across tasks and duty runs.
Selecting a member opens its details without replacing the room conversation.

## Duties

A teammate can own several duties.
Each duty uses the existing workflow builder and Loop execution engine.
Supported triggers include intervals, cron schedules, file changes, and Session endings.
Use **Run now** for an immediate duty run.

Duty results appear in the room and link to their run and Session.
Detailed workflow outputs remain available in run history.
Existing schedule, expiry, overlap, and recovery rules still apply.
See [Automations](./automations/README.md) for the workflow and trigger reference.

## Pause And Stop

**Pause** prevents new teammate tasks from starting and pauses its active future duties.
It does not interrupt work already running.
Resuming the teammate does not automatically resume independently paused or expired duties.
Resume those duties explicitly.

**Stop work** cancels the teammate's active tasks and duty runs.
It does not pause future duties.
Cancellation is recorded before the server interrupts the linked Sessions.

## Existing Automations

Existing Automations become teammates with one duty each.
This conversion preserves definitions, schedules, expiry, paused state, run IDs, and Session links.
Assign additional duties to those teammates as needed.
Moving a duty does not change the identity recorded for work already admitted.

The physical `loop` and `loop_run` tables and `/api/loop` endpoints remain in use.
Existing automation tool names remain available for compatibility.
Old `/automations` and `/loops` links continue to resolve to duty views.

## Recovery

Room messages and task admission are durable.
Exact message retries do not create duplicate work.
The server can reclaim a task that was claimed but never started.
An expired running task becomes stale when its outcome is uncertain.
The server does not automatically replay that task or its tool side effects.

## Source

- [Team schema](../../packages/schema/src/team.ts)
- [Room persistence and task admission](../../packages/core/src/team/workspace.ts)
- [Native task execution](../../packages/forge/src/team/runtime.ts)
- [Room interface](../../packages/app/src/pages/team.tsx)
- [Public room API](../../packages/protocol/src/groups/team.ts)
