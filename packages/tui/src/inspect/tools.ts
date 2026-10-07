import { TextRenderable, type CliRenderer } from "@opentui/core"
import type { Dialogs } from "../dialogs"
import { matchesKey } from "../keys"
import { errorText } from "../server"
import type { DashboardState } from "../state"
import { color } from "../theme"
import { toolText } from "./tool-text"

/**
 * The Tools dialog: the agent's tool list as text that scrolls inside a frame as tall as the screen,
 * so a long list never pushes the frame's bottom edge or its key hints off screen.
 */
export async function openTools(
  renderer: CliRenderer,
  dialogs: Dialogs,
  state: Pick<DashboardState, "modal">,
  load: () => Promise<Record<string, unknown>>,
  reload: () => void,
  modelNote: string,
) {
  const dialog = dialogs.open("Tools", false, 999)
  if (!dialog) return
  dialog.frame.maxWidth = 220
  dialog.frame.width = "98%"
  dialog.frame.height = "100%"
  // The hint is at most two whole lines; a fixed height keeps it from growing into the text.
  dialog.error.height = 2
  dialog.form.flexGrow = 1
  dialog.form.flexShrink = 1
  const body = new TextRenderable(renderer, { content: "Loading…", fg: color.text, wrapMode: "word", selectable: true })
  dialog.form.add(body)
  const hint = "↑↓/PgUp/PgDn scroll · Enter refresh · Esc close"
  dialog.error.content = hint
  dialog.key = (key) => {
    if (matchesKey(key, "enter") || matchesKey(key, "r", { ctrl: true })) {
      dialogs.close(false)
      reload()
      return true
    }
    if (!matchesKey(key, "up") && !matchesKey(key, "down")) return false
    dialog.form.scrollBy(matchesKey(key, "up") ? -1 : 1)
    return true
  }
  dialog.form.focus()
  try {
    const snapshot = await load()
    // Rows are broken here, one column short of the viewport for the scroll bar, so a wrapped description keeps its indent.
    const show = () => (body.content = toolText(snapshot, modelNote, Math.max(20, dialog.form.viewport.width - 1)))
    if (state.modal !== dialog) return
    show()
    dialog.form.viewport.on("resize", show)
  } catch (error) {
    if (state.modal === dialog) body.content = `Tools unavailable: ${errorText(error)}\nEnter retries.`
  }
}
