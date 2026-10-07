import { SelectRenderable, TextRenderable } from "@opentui/core"
import { display } from "../messages"
import { matchesKey } from "../keys"
import { label } from "../state"
import { color } from "../theme"
import { act, discard, refresh, type Dock, type QueueContext } from "./dock"

export function openQueue(ctx: QueueContext) {
  const { state, dialogs } = ctx
  const session = state.snapshot?.sessions.find((item) => item.id === state.selected)
  if (state.tab !== "sessions" || !session) return ctx.say("Select a session first.")
  if (!dialogs.navigate()) return
  const dialog = dialogs.open("Queued messages", false, 26)
  if (!dialog) return
  dialog.recipient = session
  const text = new TextRenderable(ctx.renderer, {
    content: "Loading…",
    fg: color.text,
    wrapMode: "word",
    selectable: true,
  })
  dialog.form.add(text)
  const list = new SelectRenderable(ctx.renderer, {
    height: 8,
    flexShrink: 0,
    options: [],
    showSelectionIndicator: true,
    backgroundColor: color.panel,
    textColor: color.text,
    descriptionColor: color.muted,
    selectedBackgroundColor: color.selected,
    selectedTextColor: color.accent,
  })
  dialog.frame.add(list, dialog.frame.getChildren().indexOf(dialog.error))
  dialogs.track(dialog, list)
  const dock: Dock = { ctx, session, dialog, text, list, inputs: [], armed: "", armedAt: 0, request: 0, acting: false }
  list.on("selectionChanged", () => {
    dock.armed = ""
    const input = dock.inputs[list.getSelectedIndex()]
    if (input) text.content = `For: ${label(session.title || session.id, 100)}\n\n${display(input.prompt.text, 4000)}`
  })
  dialog.refresh = () => void refresh(dock)
  dialog.key = (key) => {
    const action = matchesKey(key, "r", { ctrl: true })
      ? () => refresh(dock)
      : matchesKey(key, "e", { ctrl: true })
        ? () => act(dock, "edit")
        : matchesKey(key, "d", { ctrl: true })
          ? () => discard(dock)
          : matchesKey(key, "enter")
            ? () => act(dock, "steer")
            : undefined
    if (!action) return false
    void action()
    return true
  }
  list.focus()
  void refresh(dock)
}
