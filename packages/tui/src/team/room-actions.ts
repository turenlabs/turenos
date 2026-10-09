import { linkedBlocker, roomDeleteBlocker, roomSchedules } from "@turenlabs/client/team"
import { markFocus } from "../automations/focus"
import { enterAdvances } from "../dialogs/fields"
import { display } from "../messages"
import { openPicker } from "../picker"
import { refused } from "../server"
import { label } from "../state"
import type { TeamAction, TeamOperations } from "./actions"
import { confirm } from "./confirm"
import { applyRoom, leaveRoom, loadedRoom, online } from "./selection"
import { finite, viewOf, type Room, type TeamContext } from "./types"

/** New room (`a`), edit name and topic (`E`) and the room menu (`d`): archive, restore, delete. */
export function roomActions(ctx: TeamContext, ops: TeamOperations): TeamAction[] {
  return [
    { key: "a", name: "New room", description: "Name and topic of a new room", run: () => newRoom(ctx, ops) },
    { key: "E", name: "Edit room", description: "Rename the room or change its topic", run: () => editRoom(ctx, ops) },
    {
      key: "d",
      name: "Room actions",
      description: "Archive, restore or delete the room",
      run: () => roomMenu(ctx, ops),
    },
  ]
}

function newRoom(ctx: TeamContext, ops: TeamOperations) {
  if (!online(ctx, "creating a room")) return
  const dialog = ctx.dialogs.open("New room", false, 18)
  if (!dialog) return
  const name = ctx.dialogs.input(dialog, "Name", "", "for example: incident-response")
  const topic = ctx.dialogs.input(dialog, "Topic (optional)")
  ;[name, topic].forEach(markFocus)
  let created = false
  enterAdvances(dialog)
  dialog.submit = async () => {
    if (!name.value.trim()) {
      name.focus()
      throw new Error("Enter a room name.")
    }
    // A retry after an uncertain create must not add a second room.
    if (created) throw new Error("The room may already exist. Esc, then check the room list.")
    created = true
    const room = finite(
      await ctx.connection.client.team
        .roomCreate({ name: name.value.trim(), topic: topic.value })
        .catch((error: unknown) => {
          // A definite refusal admitted nothing, so corrected fields may be sent again.
          if (refused(error)) created = false
          throw error
        }),
    )
    applyRoom(ctx, room)
    ctx.state.selected = room.id
    ctx.say(`Created # ${label(room.name, 60)}.`)
  }
  dialog.afterSubmit = () => selectLoaded(ctx, ops)
  dialog.error.content = "Tab or Enter next field · Ctrl+S, or Enter on Topic, creates · Esc close"
  name.focus()
}

function editRoom(ctx: TeamContext, ops: TeamOperations, back?: () => void) {
  const room = loadedRoom(ctx)
  if (!room || !online(ctx, "editing the room")) return
  if (room.archived) return ctx.say("Archived rooms are read-only. Restore the room first.", true)
  const dialog = ctx.dialogs.open(`# ${label(room.name, 40)} › Edit`, false, 18)
  if (!dialog) return
  dialog.back = back
  const name = ctx.dialogs.input(dialog, "Name", display(room.name, 512))
  const topic = ctx.dialogs.input(dialog, "Topic", display(room.topic, 4096))
  ;[name, topic].forEach(markFocus)
  enterAdvances(dialog)
  dialog.submit = async () => {
    if (!name.value.trim()) {
      name.focus()
      throw new Error("Enter a room name.")
    }
    const edited = await ctx.connection.client.team.roomEdit({
      roomID: room.id,
      name: name.value.trim(),
      topic: topic.value,
    })
    applyRoom(ctx, finite(edited))
    ctx.say("Room saved.")
  }
  dialog.afterSubmit = () => void ops.sync()
  dialog.error.content = `Tab or Enter next field · Ctrl+S, or Enter on Topic, saves · Esc ${back ? "back" : "close"}`
  name.focus()
}

function roomMenu(ctx: TeamContext, ops: TeamOperations) {
  const room = loadedRoom(ctx)
  if (!room || !online(ctx, "changing the room")) return
  const view = viewOf(ctx.state)
  const blocker = room.archived ? blockedText(ctx, view, room) : undefined
  const back = () => roomMenu(ctx, ops)
  const choices = room.archived
    ? [
        { name: "Restore", description: "Does not resume paused schedules", run: () => restore(ctx, ops, room, back) },
        {
          name: "Delete permanently",
          description: blocker ? "Blocked, see above" : "Removes its teammates and history; sessions are kept",
          run: () => (blocker ? ctx.say(blocker, true) : remove(ctx, ops, room, back)),
        },
      ]
    : [
        { name: "Edit name and topic", description: "E", run: () => editRoom(ctx, ops, back) },
        { name: "Archive", description: "Read-only, schedules pause", run: () => archive(ctx, ops, room, back) },
        {
          name: "Delete (archive first)",
          description: "Not available until the room is archived",
          run: () => ctx.say("Archive this room before you delete it.", true),
        },
      ]
  openPicker(ctx.renderer, ctx.dialogs, {
    title: `# ${label(room.name, 40)} › Room`,
    text: blocker,
    choices,
    height: 16,
  })
}

/** Why a delete is refused. Linked schedules are named, because the shared rule only counts them. */
function blockedText(ctx: TeamContext, view: ReturnType<typeof viewOf>, room: Room) {
  const loops = ctx.state.snapshot?.loops ?? []
  const blocker = roomDeleteBlocker(
    { room, tasks: view.tasks, factoryRuns: view.factoryRuns, duties: view.duties, teammates: view.teammates },
    loops,
  )
  if (blocker !== linkedBlocker) return blocker
  const linked = roomSchedules({ room, teammates: view.teammates }, loops)
  const duties = view.duties.filter((duty) => !linked.some((loop) => loop.id === duty.loopID)).length
  const names = linked.slice(0, 3).map((loop) => `"${label(loop.name, 40)}"`)
  const more = linked.length > 3 ? ` and ${linked.length - 3} more` : ""
  const what = [
    linked.length ? `${linked.length} linked schedule${linked.length > 1 ? "s" : ""} (${names.join(", ")}${more})` : "",
    duties ? `${duties} duty link${duties > 1 ? "s" : ""}` : "",
  ].filter(Boolean)
  return `Blocked: ${what.join(" and ")}. Remove ${linked.length + duties > 1 ? "them" : "it"} in Automations (3).`
}

function archive(ctx: TeamContext, ops: TeamOperations, room: Room, back: () => void) {
  confirm(ctx, {
    title: `# ${label(room.name, 40)} › Archive`,
    warning:
      "The room becomes read-only and attached schedules pause. Active work must finish first: stop it before you archive.",
    word: "archive",
    verb: "archive",
    back,
    run: async () => {
      if (!ctx.state.connected) throw new Error("Reconnect before archiving the room.")
      applyRoom(ctx, finite(await ctx.connection.client.team.roomArchive({ roomID: room.id })))
      leaveRoom(ctx, room.id, false)
      ctx.say("Room archived.")
    },
    done: () => selectLoaded(ctx, ops),
  })
}

function restore(ctx: TeamContext, ops: TeamOperations, room: Room, back: () => void) {
  confirm(ctx, {
    title: `# ${label(room.name, 40)} › Restore`,
    warning: "The room accepts messages and work again. Restoring does not resume schedules that archiving paused.",
    verb: "restore",
    back,
    run: async () => {
      if (!ctx.state.connected) throw new Error("Reconnect before restoring the room.")
      applyRoom(ctx, finite(await ctx.connection.client.team.roomRestore({ roomID: room.id })))
      ctx.say("Restored. Its schedules stay paused: resume them in Automations (3).")
    },
    done: () => void ops.sync(),
  })
}

function remove(ctx: TeamContext, ops: TeamOperations, room: Room, back: () => void) {
  confirm(ctx, {
    title: `# ${label(room.name, 40)} › Delete`,
    warning: "Deletes the room, its teammates and its history for good. Sessions the room started are kept.",
    word: "delete",
    verb: "delete",
    back,
    run: async () => {
      if (!ctx.state.connected) throw new Error("Reconnect before deleting the room.")
      await ctx.connection.client.team.roomDelete({ roomID: room.id })
      leaveRoom(ctx, room.id, true)
      ctx.say("Room deleted.")
    },
    done: () => selectLoaded(ctx, ops),
  })
}

/** After a change of selection: the sidebar follows, then the newly selected room loads. */
function selectLoaded(ctx: TeamContext, ops: TeamOperations) {
  ctx.repaint()
  void ops.sync()
}
