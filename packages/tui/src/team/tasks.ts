import { matchesKey } from "../keys"
import { openPicker, type Choice, type Picker } from "../picker"
import { errorText } from "../server"
import { label } from "../state"
import { confirm } from "./confirm"
import { handleOf, statusWord } from "./format"
import { viewOf, type Task, type TeamContext } from "./types"

const KEYS = "↑↓ choose · Enter open session · c cancel task · r refresh · Esc close"
const cancellable: Task["status"][] = ["queued", "claimed", "running"]

/** The room's tasks, newest first. Enter opens the task's session; `c` cancels a live task after a typed word. */
export function openTasks(ctx: TeamContext, refresh: () => Promise<void>) {
  const view = viewOf(ctx.state)
  if (ctx.state.tab !== "team" || !view.room) return ctx.say("Select a room first.")
  const roomName = label(view.room.name, 40)
  const picker = openPicker(ctx.renderer, ctx.dialogs, { title: `# ${roomName} › Tasks`, choices: [], keys: KEYS })
  if (!picker) return
  const tasks = () =>
    viewOf(ctx.state)
      .tasks.filter((task) => task.roomID === view.room?.id)
      .toSorted((a, b) => b.time.created - a.time.created)
  // The tasks as listed on screen: Enter and `c` act on these, never on a later poll's list.
  let shown: Task[] = []
  const fill = () => {
    const rows = (shown = tasks())
    picker.text.content = rows.length ? "Tasks the room's messages created." : "No tasks in this room yet."
    picker.fit()
    picker.set(
      rows.map(
        (task): Choice => ({
          name: describe(ctx, task),
          description: label(task.sessionID, 80),
          run: () => ctx.openSession(task.sessionID),
        }),
      ),
    )
  }
  fill()
  const select = picker.dialog.key
  picker.dialog.key = (key) => taskKey(ctx, picker, () => shown, fill, refresh, key) || (select?.(key) ?? false)
}

function describe(ctx: TeamContext, task: Task) {
  const view = viewOf(ctx.state)
  const source = view.messages.find((message) => message.id === task.messageID)
  const first = source ? label(source.text.split("\n")[0] ?? "", 100) : "(message not loaded)"
  return `${statusWord(task.status)} · ${handleOf(view.teammates, task.teammateID)} · ${first}`
}

function taskKey(
  ctx: TeamContext,
  picker: Picker,
  tasks: () => Task[],
  fill: () => void,
  refresh: () => Promise<void>,
  key: Parameters<NonNullable<Picker["dialog"]["key"]>>[0],
) {
  if (matchesKey(key, "r")) {
    ctx.say("Refreshing tasks…")
    void refresh().then(() => ctx.state.modal === picker.dialog && fill())
    return true
  }
  if (!matchesKey(key, "c")) return false
  const task = tasks()[picker.list.getSelectedIndex()]
  if (!task) return true
  if (!cancellable.includes(task.status)) {
    ctx.say("Only queued, claimed or running tasks can be cancelled.", true)
    return true
  }
  ctx.dialogs.close(false)
  confirmCancel(ctx, task, refresh)
  return true
}

function confirmCancel(ctx: TeamContext, task: Task, refresh: () => Promise<void>) {
  confirm(ctx, {
    title: "Cancel task",
    warning: `Cancels ${handleOf(viewOf(ctx.state).teammates, task.teammateID)} · ${statusWord(task.status)} · ${label(task.id, 80)}\nWork already done stays in its session.`,
    word: "cancel",
    verb: "cancel task",
    back: () => openTasks(ctx, refresh),
    done: () => openTasks(ctx, refresh),
    run: async () => {
      if (!ctx.state.connected) throw new Error("Reconnect before cancelling a task.")
      const cancelled = await ctx.connection.client.team.taskCancel({ taskID: task.id }).catch((error: unknown) => {
        throw new Error(errorText(error))
      })
      const view = viewOf(ctx.state)
      view.tasks = view.tasks.map((item) => (item.id === task.id ? { ...item, status: cancelled.status } : item))
      ctx.say("Task cancelled.")
    },
  })
}
