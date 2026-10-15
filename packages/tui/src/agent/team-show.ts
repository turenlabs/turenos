import { clock } from "../menus/stamp"
import { display } from "../messages"
import { handleOf, replyTarget } from "../team/format"
import type { Answer } from "../team/types"
import { clean, emit, indented, type Run } from "./context"
import { whole, takes } from "./options"
import { readPage } from "./team-tail"
import { activeTask, runDetail, runLine, taskText } from "./team-text"

export async function show(run: Run) {
  const names = takes("team show", run.positionals, [], ["room"])
  const limit = whole("limit", run.values.limit, 30, 1, 100)
  const page = await readPage(run, names[0], limit)
  const state = page.state
  const runs = state.factoryRuns ?? []
  const after = run.values.after
  return emit(
    run,
    {
      room: state.room,
      teammates: state.teammates,
      messages: state.messages,
      tasks: state.tasks,
      ...(state.room.factory ? { factory: state.room.factory } : {}),
      factoryRuns: runs,
      truncated: state.hasMore,
      ...(page.timedOut === undefined ? {} : { status: "timeout" }),
    },
    [
      ...header(state),
      "",
      "teammates:",
      ...(state.teammates.length ? state.teammates.map(teammateLine) : ["  (none)"]),
      "",
      "messages:",
      ...(state.hasMore && after === undefined
        ? [`[earlier messages are not shown${limit < 100 ? "; raise --limit" : ""}]`]
        : []),
      ...(state.messages.length ? state.messages.map((message) => messageText(state, message)) : ["(no messages)"]),
      ...(state.hasMore && after !== undefined
        ? [`[more messages follow; continue with --after ${state.messages.at(-1)?.seq}]`]
        : []),
      ...(page.timedOut === undefined
        ? []
        : [
            `timeout: no message after seq ${after} within ${page.timedOut}s; keep waiting with: turen-tui team show ${state.room.id} --after ${after} --wait${run.flags}`,
          ]),
      ...activeTasks(state, run.flags),
      ...factory(state, run.flags),
    ].join("\n"),
    page.timedOut === undefined ? 0 : 4,
  )
}

function header(state: Answer) {
  const room = state.room
  return [
    `room ${room.id} · ${clean(room.name, 120)}${room.archived ? " · archived" : ""}`,
    ...(room.topic ? [`topic: ${clean(room.topic, 400)}`] : []),
  ]
}

function teammateLine(teammate: Answer["teammates"][number]) {
  return `  @${teammate.handle} ${clean(teammate.name, 120)} · ${clean(teammate.role, 120)} · ${teammate.status}`
}

/**
 * The time and author in column 0, then the text set in by four spaces, as `show` sets in a transcript. A reply's
 * source sits between them, set in by two.
 */
function messageText(state: Answer, message: Answer["messages"][number]) {
  const author =
    message.kind === "teammate" && message.teammateID
      ? handleOf(state.teammates, message.teammateID)
      : message.kind === "system"
        ? "system"
        : clean(message.author, 80)
  const reply = replyTarget(state, message)
  return [
    `${clock(message.time)} ${author}`,
    ...(reply ? [`  ↳ ${reply}`] : []),
    indented(display(message.text, 16_000)),
  ].join("\n")
}

function activeTasks(state: Answer, flags: string) {
  const tasks = state.tasks.filter(activeTask)
  return tasks.length ? ["", "tasks:", ...tasks.map((task) => taskText(task, state.teammates, flags))] : []
}

function factory(state: Answer, flags: string) {
  const config = state.room.factory?.config
  if (!config) return []
  const latest = (state.factoryRuns ?? []).toSorted((a, b) => b.time.created - a.time.created)[0]
  return [
    "",
    `factory: revision ${state.room.factory?.revision} · coordinator ${handleOf(state.teammates, config.coordinatorTeammateID)} · ${config.teammateIDs.length} teammate${config.teammateIDs.length === 1 ? "" : "s"} · ${clean(config.outcome, 200)}`,
    ...(latest ? [runLine("run", latest), ...runDetail(latest)] : ["run: none yet"]),
    ...(latest?.status === "running" ? [`  wait: turen-tui team wait ${latest.id}${flags}`] : []),
  ]
}
