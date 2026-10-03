import { SelectRenderable, TextRenderable, type CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import { matchesKey } from "./keys"
import { display } from "./messages"
import { identifier, object } from "./response-validation"
import { errorText, type Connection, type Session, type Snapshot } from "./server"
import { label, type DashboardState } from "./state"
import { color } from "./theme"

type Loop = Snapshot["loops"][number]

const UNIT: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 }

/**
 * "every 15m", "every 2h", "30m", or a five-field cron expression such as "0 9 * * 1-5", which runs
 * in this computer's time zone.
 */
export function parseSchedule(text: string) {
  const value = text.trim().toLowerCase()
  const every = /^(?:every\s+)?(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|hour|hours|d|day|days)$/.exec(value)
  if (every) return { intervalSeconds: Number(every[1]) * UNIT[every[2]![0]!]! }
  if (/^(\S+\s+){4}\S+$/.test(value))
    return { cronExpression: value, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
  return undefined
}

function scheduleInput(loop: Loop) {
  if (loop.schedule.type === "cron") return loop.schedule.expression
  const seconds = loop.schedule.seconds
  const unit = (["d", "h", "m"] as const).find((unit) => seconds % UNIT[unit]! === 0) ?? "s"
  return `every ${seconds / UNIT[unit]!}${unit}`
}

/**
 * The desktop's Automations page: scheduled agent prompts that run on the server. Enter manages
 * the selected automation (run now, pause or resume, edit, runs, delete); `a` adds one.
 */
export function createAutomations(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
  openSession: (id: string, inspect?: boolean, session?: Session) => void,
) {
  function selected() {
    const loop =
      state.tab === "automations" ? state.snapshot?.loops.find((item) => item.id === state.selected) : undefined
    if (!loop) say("Select an automation first.")
    return loop
  }

  function manage() {
    const loop = selected()
    if (!loop || !dialogs.navigate()) return
    const dialog = dialogs.open(label(loop.name, 60), false, 20)
    if (!dialog) return
    const loops = connection.client.loops
    const toggle =
      loop.status === "paused"
        ? (["Resume", "Resumed.", loops.resume] as const)
        : (["Pause", "Paused.", loops.pause] as const)
    const actions = [
      { name: "Run now", run: () => act(loop, "Started a run.", () => loops.runNow({ loopID: loop.id })) },
      { name: toggle[0], run: () => act(loop, toggle[1], () => toggle[2]({ loopID: loop.id })) },
      { name: "Runs", run: () => runs(loop) },
      { name: "Edit", run: () => form(loop) },
      { name: "Delete", run: () => remove(loop) },
    ]
    const list = new SelectRenderable(renderer, {
      height: actions.length,
      options: actions.map((action) => ({ name: action.name, description: "" })),
      showDescription: false,
      backgroundColor: color.panel,
      textColor: color.text,
      selectedBackgroundColor: color.selected,
      selectedTextColor: color.accent,
    })
    dialog.form.add(
      new TextRenderable(renderer, {
        content: `${label(loop.status)} · ${label(loop.location.directory, 200)}\n${display(loop.prompt, 400)}`,
        fg: color.muted,
        wrapMode: "word",
      }),
    )
    dialog.form.add(list)
    dialogs.track(dialog, list)
    dialog.key = (key) => {
      if (!matchesKey(key, "enter")) return false
      dialogs.close(false)
      actions[list.getSelectedIndex()]?.run()
      return true
    }
    dialog.error.content = "Enter choose · Esc close"
    list.focus()
  }

  function act(loop: Loop, done: string, request: () => Promise<unknown>) {
    const dialog = dialogs.open(label(loop.name, 60), false, 12)
    if (!dialog) return
    dialog.form.add(new TextRenderable(renderer, { content: "Working…", fg: color.muted }))
    dialog.submit = async () => {
      await request()
      say(done)
    }
    void dialogs.submit()
  }

  function form(loop?: Loop) {
    const dialog = dialogs.open(loop ? "Edit automation" : "New automation", false, 30)
    if (!dialog) return
    const session = state.snapshot?.sessions.find((item) => item.id === state.selected)
    const name = dialogs.input(dialog, "Name", loop?.name ?? "")
    const prompt = dialogs.input(dialog, "Prompt the agent runs each time", loop?.prompt ?? "")
    const schedule = dialogs.input(
      dialog,
      "Schedule: every 15m, every 2h, or cron (0 9 * * 1-5)",
      loop ? scheduleInput(loop) : "every 1h",
    )
    const folder = loop
      ? undefined
      : dialogs.input(
          dialog,
          "Folder on the server",
          session?.location.directory ?? state.snapshot?.location.directory ?? "",
        )
    let created = false
    dialog.submit = async () => {
      const when = parseSchedule(schedule.value)
      if (!name.value.trim() || !prompt.value.trim()) throw new Error("Enter a name and a prompt.")
      if (!when) throw new Error("Use a schedule like every 30m, every 1d, or a five-field cron expression.")
      const fields = { name: name.value.trim(), prompt: prompt.value.trim(), ...when }
      if (loop) {
        await connection.client.loops.edit({ loopID: loop.id, ...fields })
        return say("Automation saved.")
      }
      // A retry after an uncertain create must not add a second automation.
      if (created) throw new Error("The automation may already exist. Esc and check the Automations tab.")
      created = true
      const result = object(await connection.client.loops.create({ ...fields, location: { directory: folder!.value } }))
      identifier(result.id)
      say("Automation created.")
    }
    dialog.error.content = "Tab next field · Ctrl+S save · Esc cancel"
    name.focus()
  }

  function remove(loop: Loop) {
    const dialog = dialogs.open("Delete automation", false, 16)
    if (!dialog) return
    dialog.form.add(
      new TextRenderable(renderer, {
        content: `${label(loop.name, 100)}\nFuture runs stop. Sessions it already started are kept.`,
        fg: color.warning,
        wrapMode: "word",
      }),
    )
    dialog.submit = async () => {
      await connection.client.loops.delete({ loopID: loop.id })
      say("Automation deleted.")
    }
    dialog.error.content = "Ctrl+S Delete · Esc cancel"
    dialog.form.focus()
  }

  function runs(loop: Loop) {
    const dialog = dialogs.open(`Runs · ${label(loop.name, 50)}`, false, 30)
    if (!dialog) return
    const text = new TextRenderable(renderer, { content: "Loading runs…", fg: color.muted })
    dialog.form.add(text)
    const list = new SelectRenderable(renderer, {
      height: 14,
      options: [],
      backgroundColor: color.panel,
      textColor: color.text,
      descriptionColor: color.muted,
      selectedBackgroundColor: color.selected,
      selectedTextColor: color.accent,
    })
    dialog.form.add(list)
    dialogs.track(dialog, list)
    let items: Awaited<ReturnType<typeof connection.client.loops.runList>> = []
    let armed = ""
    const keys = "Enter open run's session · Ctrl+D cancel a running run · Esc close"
    void connection.client.loops.runList({ loopID: loop.id }).then(
      (result) => {
        if (state.modal !== dialog) return
        items = result.slice(0, 50)
        text.content = items.length ? `${items.length} recent run${items.length === 1 ? "" : "s"}` : "No runs yet."
        list.options = items.map((run) => ({
          name: `${run.status} · ${new Date(run.time.created).toLocaleString()} · ${run.trigger}`,
          description: run.error ? label(run.error, 200) : run.sessionID ? "Enter opens its session" : "",
        }))
        dialog.error.content = keys
      },
      (error: unknown) => {
        if (state.modal === dialog) text.content = `Runs unavailable: ${errorText(error)}`
      },
    )
    dialog.key = (key) => {
      const run = items[list.getSelectedIndex()]
      if (matchesKey(key, "enter") && run?.sessionID) {
        dialogs.close(false)
        openSession(run.sessionID)
        return true
      }
      if (!matchesKey(key, "d", { ctrl: true }) || !run || !["claimed", "running"].includes(run.status)) return false
      if (armed !== run.id) {
        armed = run.id
        dialog.error.content = `Ctrl+D again cancels this run.\n${keys}`
        return true
      }
      void connection.client.loops.runCancel({ loopID: loop.id, runID: run.id }).then(
        () => (dialog.error.content = `Run cancelled.\n${keys}`),
        (error: unknown) => (dialog.error.content = `! ${errorText(error)}\n${keys}`),
      )
      return true
    }
    dialog.error.content = "Esc close"
    list.focus()
  }

  return {
    manage,
    create: () => form(),
    edit: () => {
      const loop = selected()
      if (loop) form(loop)
    },
    remove: () => {
      const loop = selected()
      if (loop) remove(loop)
    },
  }
}
