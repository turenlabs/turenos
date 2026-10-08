import { display } from "../messages"
import { stamp } from "../menus/stamp"
import { label } from "../state"
import { handleOf, statusWord } from "./format"
import type { FactoryRun, Room, Teammate, TeamView } from "./types"

/** The factory's setup as lines; a room without one says how to start. */
export function summaryText(room: Room, teammates: readonly Teammate[]) {
  const factory = room.factory
  if (!factory) return "Not configured. s opens settings."
  const config = factory.config
  const parameters = Object.keys(config.parameters).length ? JSON.stringify(config.parameters) : ""
  return [
    `Outcome: ${display(config.outcome, 4000)}`,
    `Acceptance criteria: ${display(config.acceptanceCriteria, 4000)}`,
    config.constraints ? `Constraints: ${display(config.constraints, 8000)}` : "",
    parameters ? `Parameters: ${label(parameters, 600)}` : "",
    `Coordinator: ${handleOf(teammates, config.coordinatorTeammateID)}`,
    `Teammates: ${config.teammateIDs.map((id) => handleOf(teammates, id)).join(", ")}`,
    `Directory: ${label(config.directory, 300)}`,
    `Revision ${factory.revision}`,
  ]
    .filter(Boolean)
    .join("\n")
}

/** A run: its stage, the tasks it created, and its result or error. */
export function runText(view: TeamView, run: FactoryRun) {
  const tasks = view.tasks.filter((task) => run.taskIDs.includes(task.id))
  return [
    `Run ${label(run.id, 60)} · ${run.status} · phase ${run.phase}`,
    `Created ${stamp(run.time.created)} · updated ${stamp(run.time.updated)}`,
    run.status === "needs_input" ? "Needs your answer: open the task session to answer its request." : "",
    tasks.length ? "Tasks (Enter opens a session):" : "No tasks yet.",
    ...tasks.map(
      (task) =>
        `  ${handleOf(view.teammates, task.teammateID)} ${statusWord(task.status)} · session ${label(task.sessionID, 80)}`,
    ),
    run.result ? `Result:\n${display(run.result, 32_768)}` : "",
    run.error ? `Error:\n${display(run.error, 8000)}` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

/** Latest runs first; the server may list them in any order. */
export function latestRuns(view: TeamView) {
  return view.factoryRuns.toSorted((a, b) => b.time.created - a.time.created).slice(0, 30)
}
