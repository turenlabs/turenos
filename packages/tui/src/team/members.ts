import { matchesKey } from "../keys"
import { display } from "../messages"
import { openPicker, type Choice } from "../picker"
import { label } from "../state"
import type { TeamAction, TeamOperations } from "./actions"
import { confirm } from "./confirm"
import { dutiesOf, openDuties } from "./duties"
import { memberForm } from "./member-form"
import { act } from "../automations/manage"
import { loadedRoom, online, reloaded } from "./selection"
import { viewOf, type Task, type Teammate, type TeamContext } from "./types"

const LIVE: Task["status"][] = ["queued", "claimed", "running"]
const KEYS = "↑↓ choose · Enter menu · a add · r refresh · Esc close"

/** `M` opens the room's teammates. */
export function memberActions(ctx: TeamContext, ops: TeamOperations): TeamAction[] {
  return [
    {
      key: "M",
      name: "Room teammates",
      description: "Add, edit, pause, stop or give duties to teammates",
      run: () => openMembers(ctx, ops),
    },
  ]
}

/** One row per teammate; the rows are those of the last draw, so a poll cannot change what Enter opens. */
export function openMembers(ctx: TeamContext, ops: TeamOperations) {
  const room = loadedRoom(ctx)
  if (!room) return
  const picker = openPicker(ctx.renderer, ctx.dialogs, {
    title: `# ${label(room.name, 40)} › Teammates`,
    choices: [],
    keys: KEYS,
  })
  if (!picker) return
  const fill = () => {
    const view = viewOf(ctx.state)
    picker.text.content = view.teammates.length
      ? `${view.teammates.length} in this room${room.archived ? " · archived: read-only" : ""}.`
      : "No teammates yet. a adds one."
    picker.fit()
    picker.set(
      view.teammates.map(
        (mate): Choice => ({
          name: row(ctx, mate),
          description: label(display(mate.mission, 200).split("\n")[0] ?? "", 150),
          run: () => memberMenu(ctx, ops, mate),
        }),
      ),
    )
  }
  fill()
  const select = picker.dialog.key
  picker.dialog.key = (key) => {
    if (matchesKey(key, "a")) {
      if (!online(ctx, "adding a teammate")) return true
      ctx.dialogs.close(false)
      memberForm(ctx, { back: () => openMembers(ctx, ops), saved: () => afterChange(ctx, ops) })
      return true
    }
    if (!matchesKey(key, "r")) return select?.(key) ?? false
    ctx.say("Refreshing teammates…")
    void ops.sync().then(() => ctx.state.modal === picker.dialog && fill())
    return true
  }
}

function row(ctx: TeamContext, mate: Teammate) {
  const view = viewOf(ctx.state)
  const active = view.tasks.filter((task) => task.teammateID === mate.id && LIVE.includes(task.status)).length
  return `@${label(mate.handle, 32)}  ${label(mate.name, 40)} · ${label(mate.role, 40)} · ${mate.status} · ${active} active tasks · ${dutiesOf(view, mate).length} duties`
}

/** Reloads the room, then shows the teammates again. */
function afterChange(ctx: TeamContext, ops: TeamOperations) {
  reloaded(ctx, ops, () => openMembers(ctx, ops))
}

function memberMenu(ctx: TeamContext, ops: TeamOperations, mate: Teammate) {
  const room = viewOf(ctx.state).room
  if (!room) return
  const back = () => openMembers(ctx, ops)
  const writable = !room.archived
  const handle = `@${label(mate.handle, 32)}`
  const choices: Choice[] = [
    ...(writable
      ? [
          {
            name: "Edit",
            description: "Name, role, mission, directory, agent, model",
            run: () =>
              memberForm(ctx, { mate, back: () => memberMenu(ctx, ops, mate), saved: () => afterChange(ctx, ops) }),
          },
          {
            name: mate.status === "paused" ? "Resume" : "Pause",
            description:
              mate.status === "paused" ? "New tasks can start again" : "No new tasks start; running work continues",
            run: () => pause(ctx, ops, mate),
          },
          { name: "Stop work", description: "Cancels its active tasks and duty runs", run: () => stop(ctx, ops, mate) },
        ]
      : []),
    {
      name: "Duties",
      description: "Automations this teammate owns",
      run: () => openDuties(ctx, ops, mate, () => memberMenu(ctx, ops, mate)),
    },
    { name: "Open latest task session", description: "The newest task's session", run: () => latestSession(ctx, mate) },
  ]
  openPicker(ctx.renderer, ctx.dialogs, { title: `${handle} › ${label(mate.name, 40)}`, choices, back, height: 18 })
}

function pause(ctx: TeamContext, ops: TeamOperations, mate: Teammate) {
  if (!online(ctx, "changing the teammate")) return
  const status = mate.status === "paused" ? "active" : "paused"
  act(
    ctx,
    `@${label(mate.handle, 32)}`,
    status === "paused"
      ? "Paused. Running work continues."
      : "Resumed. Paused duties stay paused until you resume them.",
    () => ctx.connection.client.team.teammateEdit({ teammateID: mate.id, status }),
    () => void ops.sync(),
  )
}

function stop(ctx: TeamContext, ops: TeamOperations, mate: Teammate) {
  confirm(ctx, {
    title: `@${label(mate.handle, 32)} › Stop work`,
    warning:
      "Cancels its active tasks and duty runs. It does not pause future duties. Work already done stays in its sessions.",
    word: "stop",
    verb: "stop work",
    back: () => memberMenu(ctx, ops, mate),
    done: () => void ops.sync(),
    run: async () => {
      if (!ctx.state.connected) throw new Error("Reconnect before stopping work.")
      await ctx.connection.client.team.teammateStop({ teammateID: mate.id })
      ctx.say("Stopped the teammate's work.")
    },
  })
}

function latestSession(ctx: TeamContext, mate: Teammate) {
  const latest = viewOf(ctx.state)
    .tasks.filter((task) => task.teammateID === mate.id)
    .toSorted((a, b) => b.time.created - a.time.created)[0]
  if (!latest) return ctx.say(`@${label(mate.handle, 32)} has no tasks yet.`)
  ctx.openSession(latest.sessionID)
}
