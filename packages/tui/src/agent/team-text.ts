import { display } from "../messages"
import { handleOf } from "../team/format"
import type { Answer, Task } from "../team/types"
import { indented } from "./context"

/** What the lines need of a factory run, so every route that returns one fits. */
type Run = { id: string; status: string; phase: string; result?: string; error?: string }

/** A task that is still working, so its session is worth waiting on. */
export const activeTask = (task: Task) => ["queued", "claimed", "running"].includes(task.status)

/** A task, then the command that waits for its session. */
export function taskText(task: Task, teammates: Answer["teammates"], flags: string) {
  return [
    `task ${task.id} · ${handleOf(teammates, task.teammateID)} · ${task.status} · session ${task.sessionID}`,
    `  wait: turen-tui wait ${task.sessionID}${flags}`,
  ].join("\n")
}

export function runLine(label: string, run: Run) {
  return `${label} ${run.id} · ${run.status} · ${run.phase}`
}

/** What a run produced: its result set in by four spaces, so it cannot read as a line of this client's, and its error. */
export function runDetail(run: Run) {
  return [
    ...(run.result ? ["  result:", indented(display(run.result, 16_000))] : []),
    ...(run.error ? [`  error: ${display(run.error, 2000).replace(/\s+/g, " ").trim()}`] : []),
  ]
}
