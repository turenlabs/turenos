import { factoryOutput } from "@turenlabs/client/team"
import { display } from "../messages"
import { clock } from "../menus/stamp"
import { label } from "../state"
import type { FactoryRun, Message, Task, TeamView, Teammate } from "./types"

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

/** A path cut to `max` columns from the left, at a slash, so its last folders stay: `…/data/forge`. */
export function pathTail(path: string, max: number) {
  if (path.length <= max) return path
  const tail = path.slice(1 - max)
  const slash = tail.indexOf("/")
  return `…${slash >= 0 ? tail.slice(slash) : tail}`
}

/** `1 duty`, `2 duties`; `many` is for nouns that do not take an s. */
export function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`
}

export function statusWord(status: Task["status"]) {
  return statusWords[status]
}

export function handleOf(teammates: readonly Teammate[], id: string) {
  const handle = teammates.find((teammate) => teammate.id === id)?.handle
  return handle ? `@${handle}` : `@${label(id, 24)}`
}

/** The room as plain text, oldest message first, each followed by the state of the tasks it created. */
export function roomLog(view: TeamView) {
  const linked = new Set(
    view.tasks
      .filter((task) => view.messages.some((message) => message.id === task.messageID))
      .map((task) => task.sessionID),
  )
  const closing = closingRuns(view)
  const lines = [
    ...(view.room?.archived ? ["Archived · read-only. Restore does not resume paused schedules.", ""] : []),
    ...(view.teammates.length || view.room?.archived
      ? []
      : ["No teammates yet. Press M, then a, to add one; teammates answer posts and take tasks.", ""]),
    ...(view.hasMore ? ["↑ Earlier messages: PageUp at the top or [ loads them.", ""] : []),
    ...(view.messages.length
      ? view.messages.flatMap((message) => [
          ...entry(view, message, linked),
          ...(closing.get(message.id) ?? []).map(closingLine),
        ])
      : ["No messages yet."]),
  ]
  return lines.join("\n")
}

function entry(view: TeamView, message: Message, linked: ReadonlySet<string>) {
  const [first = "", ...rest] = display(logText(view, message), MESSAGE_VIEW).split("\n")
  const head = `${clock(message.time)} ${author(view, message)}`
  const lines = [
    message.kind === "system" ? `${head} ${first}` : `${head}  ${first}`,
    ...rest.map((line) => INDENT + line),
  ]
  const tasks = view.tasks.filter((task) => task.messageID === message.id)
  // The desktop draws tool cards and attachments for a teammate's reply; the session view already does. A session
  // a task line already names needs no second pointer.
  const output =
    message.kind === "teammate" &&
    message.sessionID &&
    message.sourceMessageIDs?.length &&
    !linked.has(message.sessionID)
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
    plural(view.teammates.length, "teammate"),
    run ? `factory: ${stage[run.phase]} (run ${shortID(run.id)})` : "",
  ]
    .filter(Boolean)
    .join(" · ")
}

/** Run IDs are long; the last eight characters tell runs apart. */
export function shortID(id: string) {
  return id.length > 8 ? `…${id.slice(-8)}` : id
}

const SETTLED: FactoryRun["status"][] = ["succeeded", "failed", "cancelled", "stale"]
const checkWords = { accepted: "accepted", rejected: "rejected", needs_input: "needs input" }

/**
 * A message as the log prints it. The coordinator's plan and verdict are JSON for the server; people read them as
 * one line. System lines that name a factory run carry the short run ID. Stored text is not changed.
 */
export function logText(view: TeamView, message: Message) {
  if (message.kind === "system")
    return message.text.replace(/(Factory run )(\S{9,})/g, (_, lead, id) => lead + shortID(id))
  if (message.kind !== "teammate") return message.text
  const output = factoryOutput(message.text)
  if (output?.kind === "plan")
    return `plan: ${output.assignments.map((item) => `${handleOf(view.teammates, item.teammateID)} "${label(item.prompt, 32)}"`).join(", ")}`
  if (output?.kind === "check") return `check: ${checkWords[output.status]} — ${output.summary}`
  return message.text
}

/** For each message that ends a settled run's part of the log: the run, which then gets a closing line. */
export function closingRuns(view: TeamView) {
  const closing = new Map<string, FactoryRun[]>()
  view.factoryRuns
    .filter((run) => SETTLED.includes(run.status))
    .forEach((run) => {
      const requests = new Set(view.tasks.filter((task) => run.taskIDs.includes(task.id)).map((task) => task.messageID))
      const last = view.messages.findLast(
        (message) =>
          message.text.includes(run.id) ||
          requests.has(message.id) ||
          message.sourceMessageIDs?.some((id) => requests.has(id)),
      )
      if (last) closing.set(last.id, [...(closing.get(last.id) ?? []), run])
    })
  return closing
}

export function closingLine(run: FactoryRun) {
  return `${clock(run.time.updated)} · Factory run ${shortID(run.id)} ${run.status}`
}
