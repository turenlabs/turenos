import { display } from "../messages"
import { stamp } from "../menus/stamp"
import { label } from "../state"
import { handleOf, pathTail, plural, shortID, statusWord } from "./format"
import type { FactoryRun, Room, Task, Teammate, TeamView } from "./types"

/** The factory's setup as lines; a room without one says what a factory is and how to start. A short screen gets one line. `width` is the columns the lines have. */
export function summaryText(room: Room, teammates: readonly Teammate[], short = false, width = 60) {
  const factory = room.factory
  if (!factory)
    return "A factory runs one outcome: the coordinator plans, teammates work, the coordinator checks.\nNot configured. s opens settings."
  const config = factory.config
  if (short)
    return `Outcome ${label(config.outcome, 60)} · coordinator ${handleOf(teammates, config.coordinatorTeammateID)} · ${plural(config.teammateIDs.length, "teammate")}`
  const parameters = Object.keys(config.parameters).length ? JSON.stringify(config.parameters) : ""
  return [
    `Outcome: ${display(config.outcome, 4000)}`,
    `Acceptance criteria: ${display(config.acceptanceCriteria, 4000)}`,
    config.constraints ? `Constraints: ${display(config.constraints, 8000)}` : "",
    parameters ? `Parameters: ${label(parameters, 600)}` : "",
    `Coordinator: ${handleOf(teammates, config.coordinatorTeammateID)}`,
    `Teammates: ${config.teammateIDs.map((id) => handleOf(teammates, id)).join(", ")}`,
    `Directory: ${pathTail(label(config.directory, 4096), width - 11)}`,
    `Revision ${factory.revision}`,
  ]
    .filter(Boolean)
    .join("\n")
}

/** A phase only means something while the run is going; a finished, failed or cancelled run is simply that. */
export function runStage(run: FactoryRun) {
  return run.status === "running" || run.status === "needs_input" ? `${run.status} · phase ${run.phase}` : run.status
}

/** The run's tasks in the order the run made them. */
export function runOwnTasks(view: TeamView, run: FactoryRun) {
  return run.taskIDs.flatMap((id) => view.tasks.find((task) => task.id === id) ?? [])
}

/**
 * The run phase a task belonged to. The run's own messages say it (`planning task`, `Factory assignment for`,
 * `result check`); without them, only a succeeded run with a plan, work and a check is read by position.
 */
export function taskPhase(view: TeamView, run: FactoryRun, task: Task) {
  const request = view.messages.find((message) => message.id === task.messageID)?.text ?? ""
  if (request.endsWith("planning task")) return "plan"
  if (request.endsWith("result check")) return "check"
  if (request.startsWith("Factory assignment for")) return "work"
  const tasks = runOwnTasks(view, run)
  if (run.status !== "succeeded" || tasks.length < 3 || tasks.length !== run.taskIDs.length) return
  const index = tasks.indexOf(task)
  return index === 0 ? "plan" : index === tasks.length - 1 ? "check" : "work"
}

export function taskName(view: TeamView, run: FactoryRun, task: Task) {
  return [taskPhase(view, run, task), handleOf(view.teammates, task.teammateID), statusWord(task.status)]
    .filter(Boolean)
    .join(" · ")
}

/** A run's status and times, and when it needs an answer. */
export function runHead(run: FactoryRun) {
  return [
    `Run ${shortID(run.id)} · ${runStage(run)}`,
    `Created ${stamp(run.time.created)} · updated ${stamp(run.time.updated)}`,
    run.status === "needs_input" ? "Needs your answer: open the task session to answer its request." : "",
  ]
    .filter(Boolean)
    .join("\n")
}

export function runResult(run: FactoryRun) {
  return [
    run.result ? `Result:\n${display(run.result, 32_768)}` : "",
    run.error ? `Error:\n${display(run.error, 8000)}` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

export function runTaskLines(view: TeamView, run: FactoryRun) {
  const tasks = runOwnTasks(view, run)
  return [
    tasks.length ? "Tasks:" : "No tasks yet.",
    ...tasks.map((task) => `  ${taskName(view, run, task)} · session ${shortID(task.sessionID)} · Enter opens`),
  ].join("\n")
}

/**
 * The panel's right pane. On a short screen the selected run's status, result or error lead and the setup shrinks to
 * a line, so the outcome is on screen without scrolling. A notice takes its own first line.
 */
export function panelText(view: TeamView, room: Room, run: FactoryRun | undefined, short: boolean, width?: number) {
  const note = view.panelNote ? `${view.panelNote}\n` : ""
  const setup = summaryText(room, view.teammates, short, width)
  if (!run) return `${note}${setup}\n\nNo runs yet.`
  if (short) return [note, runHead(run), runResult(run), setup, runTaskLines(view, run)].filter(Boolean).join("\n")
  return `${note}${setup}\n\n${[runHead(run), runTaskLines(view, run), runResult(run)].filter(Boolean).join("\n")}`
}

/** Latest runs first; the server may list them in any order. */
export function latestRuns(view: TeamView) {
  return view.factoryRuns.toSorted((a, b) => b.time.created - a.time.created).slice(0, 30)
}
