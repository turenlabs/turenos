import { display } from "../messages"
import { clock } from "../menus/stamp"
import { label } from "../state"
import type { Message, Task, TeamView, Teammate } from "./types"

const statusWords: Record<Task["status"], string> = {
  queued: "queued",
  claimed: "claimed",
  running: "running",
  succeeded: "done",
  failed: "failed",
  cancelled: "cancelled",
  stale: "stale",
}

/** Message text is cut here; the server allows more than a terminal log should print for one entry. */
const MESSAGE_VIEW = 4000
/** "HH:MM " is six columns, so continuation lines line up under the author. */
const INDENT = "      "

export function statusWord(status: Task["status"]) {
  return statusWords[status]
}

export function handleOf(teammates: readonly Teammate[], id: string) {
  const handle = teammates.find((teammate) => teammate.id === id)?.handle
  return handle ? `@${handle}` : `@${label(id, 24)}`
}

/** The room as plain text, oldest message first, each followed by the state of the tasks it created. */
export function roomLog(view: TeamView) {
  const lines = [
    ...(view.room?.archived ? ["Archived · read-only. Restore does not resume paused schedules.", ""] : []),
    ...(view.hasMore ? ["↑ Earlier messages: PageUp at the top or [ loads them.", ""] : []),
    ...(view.messages.length ? view.messages.flatMap((message) => entry(view, message)) : ["No messages yet."]),
  ]
  return lines.join("\n")
}

function entry(view: TeamView, message: Message) {
  const [first = "", ...rest] = display(message.text, MESSAGE_VIEW).split("\n")
  const head = `${clock(message.time)} ${author(view, message)}`
  const lines = [
    message.kind === "system" ? `${head} ${first}` : `${head}  ${first}`,
    ...rest.map((line) => INDENT + line),
  ]
  const tasks = view.tasks.filter((task) => task.messageID === message.id)
  // The desktop draws tool cards and attachments for a teammate's reply; the session view already does.
  const output =
    message.kind === "teammate" && message.sessionID && message.sourceMessageIDs?.length
      ? [`  ↳ full output in session ${label(message.sessionID, 80)} (t, then Enter)`]
      : []
  return [...lines, ...output, ...tasks.map((task) => taskLine(view, task))]
}

function author(view: TeamView, message: Message) {
  if (message.kind === "system") return "·"
  if (message.kind === "teammate" && message.teammateID) return handleOf(view.teammates, message.teammateID)
  return label(message.author, 40)
}

function taskLine(view: TeamView, task: Task) {
  const failure = task.error && task.status === "failed" ? ` · ${label(task.error, 100)}` : ""
  return `  → ${handleOf(view.teammates, task.teammateID)} ${statusWord(task.status)}${failure} · session ${label(task.sessionID, 80)}`
}

/** The line under the room title: topic, teammate count and the factory stage while a run is active. */
export function roomContext(view: TeamView) {
  const run = view.factoryRuns.find((item) => item.status === "running")
  const stage = { plan: "planning", work: "working", check: "checking", done: "finishing" }
  return [
    view.room?.topic ? label(view.room.topic, 150) : "",
    `${view.teammates.length} teammates`,
    run ? `factory: ${stage[run.phase]} (run ${label(run.id, 40)})` : "",
  ]
    .filter(Boolean)
    .join(" · ")
}
