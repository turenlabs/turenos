import type { KeyEvent } from "@opentui/core"
import { matchesKey, printableKey } from "../keys"
import { clock } from "../menus/stamp"
import { openPanel } from "../panel"
import { openPicker } from "../picker"
import { label } from "../state"
import type { TeamAction, TeamOperations } from "./actions"
import { addTrigger, startRun, stopRun } from "./factory-run"
import { openSettings } from "./factory-settings"
import { latestRuns, panelText, runOwnTasks, taskName } from "./factory-text"
import { shortID } from "./format"
import { loadedRoom, panelNote } from "./selection"
import { viewOf, type FactoryRun, type Room, type TeamContext } from "./types"

/** `F` opens the room's factory: setup, runs and their tasks. */
export function factoryActions(ctx: TeamContext, ops: TeamOperations): TeamAction[] {
  return [
    {
      key: "F",
      name: "Room factory",
      description: "Settings, runs, triggers and stop for the room's factory",
      run: () => {
        viewOf(ctx.state).panelNote = undefined
        openFactory(ctx, ops)
      },
    },
  ]
}

/** What the open panel can ask: the room as loaded now, the run highlighted, and how to come back. */
type Live = { room: () => Room | undefined; run: () => FactoryRun | undefined; back: () => void }

/**
 * The factory panel: the latest runs on the left, the setup and the selected run on the right. It repaints
 * with every Team poll. Its runs are those of the last paint, so Enter opens what the screen shows.
 */
export function openFactory(ctx: TeamContext, ops: TeamOperations) {
  const room = loadedRoom(ctx)
  if (!room || !ctx.dialogs.navigate()) return
  // A wide screen gives the run list a fixed, compact column that leads with the run ID; the detail takes the rest.
  const wide = ctx.renderer.width >= 120
  const panel = openPanel(ctx.renderer, ctx.dialogs, `Factory › # ${label(room.name, 40)}`, wide ? 34 : undefined)
  if (!panel) return
  let runs: FactoryRun[] = []
  const live: Live = {
    room: () => (viewOf(ctx.state).room?.id === room.id ? viewOf(ctx.state).room : undefined),
    run: () => runs[panel.list.getSelectedIndex()],
    back: () => openFactory(ctx, ops),
  }
  // The text beside the list follows the highlighted run; moving the highlight repaints only that.
  const describe = () => {
    const view = viewOf(ctx.state)
    const now = live.room()
    const run = live.run()
    panel.heading.content = now?.archived ? "Archived · read-only" : "Factory"
    panel.show(
      now
        ? panelText(
            view,
            now,
            run,
            ctx.renderer.height <= 30,
            // The row's width less the run list (a column, or its 34% of the row) and the gap before the detail.
            panel.width() - (wide ? 34 : Math.max(24, Math.floor(panel.width() * 0.34))) - 4,
          )
        : "This room is no longer loaded. Esc closes.",
    )
    const edits = ["s settings", "Ctrl+R run", "x stop", "t trigger"]
    panel.hints(["↑↓ runs", "Enter tasks", ...(now?.archived ? [] : edits)], ["Esc close"])
  }
  const paint = () => {
    const previous = live.run()?.id
    runs = latestRuns(viewOf(ctx.state))
    panel.list.options = runs.map((run) => ({
      name: `${wide ? `${shortID(run.id)} ` : ""}${run.status}${run.status === "running" ? ` ${run.phase}` : ""} ${clock(run.time.created)}`,
      description: "",
    }))
    panel.list.setSelectedIndex(
      Math.max(
        0,
        runs.findIndex((run) => run.id === previous),
      ),
    )
    describe()
  }
  panel.fit("detail", describe)
  panel.dialog.refresh = paint
  panel.list.on("selectionChanged", describe)
  panel.dialog.key = (key) => factoryKey(ctx, ops, live, key)
  paint()
}

type Step = { needs?: () => string | undefined; open: () => void }

function factoryKey(ctx: TeamContext, ops: TeamOperations, live: Live, key: KeyEvent) {
  const room = live.room()
  if (!room) return false
  viewOf(ctx.state).panelNote = undefined
  if (matchesKey(key, "enter")) return runTasks(ctx, live)
  const step = steps(ctx, ops, live, room)[matchesKey(key, "r", { ctrl: true }) ? "ctrl+r" : printableKey(key)]
  if (!step) return false
  // Each step closes the panel to open its own dialog, so a refusal is checked first and leaves the panel open.
  const refusal = room.archived ? "Archived rooms are read-only." : step.needs?.()
  if (refusal) {
    panelNote(ctx, refusal)
    return true
  }
  ctx.dialogs.close(false)
  step.open()
  return true
}

function steps(ctx: TeamContext, ops: TeamOperations, live: Live, room: Room): Record<string, Step> {
  const configured = () => (room.factory ? undefined : "Not configured. s opens settings.")
  const running = () => viewOf(ctx.state).factoryRuns.find((run) => run.status === "running")
  return {
    s: { open: () => openSettings(ctx, room, live.back) },
    t: { needs: configured, open: () => addTrigger(ctx, room, live.back) },
    "ctrl+r": { needs: configured, open: () => startRun(ctx, ops, room, live.back) },
    x: {
      needs: () => (running() ? undefined : "No factory run is running."),
      open: () => stopRun(ctx, running()!, live.back),
    },
  }
}

/** Enter: the selected run's tasks, each opening its session. */
function runTasks(ctx: TeamContext, live: Live) {
  const run = live.run()
  if (!run) {
    panelNote(ctx, "No run selected.")
    return true
  }
  const view = viewOf(ctx.state)
  const tasks = runOwnTasks(view, run)
  ctx.dialogs.close(false)
  openPicker(ctx.renderer, ctx.dialogs, {
    title: `Factory › run ${shortID(run.id)}`,
    text: tasks.length ? "Enter opens a task's session." : "No tasks yet.",
    choices: tasks.map((task) => ({
      name: `${taskName(view, run, task)} · session ${shortID(task.sessionID)}`,
      description: task.error ? label(task.error, 150) : "",
      run: () => ctx.openSession(task.sessionID),
    })),
    back: live.back,
  })
  return true
}
