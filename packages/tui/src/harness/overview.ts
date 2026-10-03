import { SelectRenderable, TextRenderable } from "@opentui/core"
import { matchesKey } from "../keys"
import { errorText, type Session } from "../server"
import type { ModalState } from "../state"
import { color } from "../theme"
import { available, title, type Action } from "./actions"
import { confirm } from "./confirm"
import type { HarnessContext } from "./context"
import { describe } from "./text"

type Overview = {
  ctx: HarnessContext
  session: Session
  dialog: ModalState
  text: TextRenderable
  choices: SelectRenderable
  actions: Action[]
  request: number
}

export function overview(ctx: HarnessContext, session: Session) {
  const opened = ctx.dialogs.open("Harness", false, 34)
  if (!opened) return
  const dialog = opened
  dialog.recipient = session
  const text = new TextRenderable(ctx.renderer, { content: "Loading harness (read-only)…", fg: color.text })
  dialog.form.add(text)
  const choices = new SelectRenderable(ctx.renderer, {
    height: 4,
    flexShrink: 0,
    options: [],
    showDescription: false,
    showSelectionIndicator: true,
    backgroundColor: color.panel,
    textColor: color.text,
    selectedBackgroundColor: color.selected,
    selectedTextColor: color.accent,
  })
  dialog.frame.add(choices, dialog.frame.getChildren().indexOf(dialog.error))
  ctx.dialogs.track(dialog, choices)
  const view: Overview = { ctx, session, dialog, text, choices, actions: [], request: 0 }
  dialog.refresh = () => void refresh(view)
  dialog.key = (key) => {
    if (matchesKey(key, "r", { ctrl: true })) {
      void refresh(view)
      return true
    }
    if (!matchesKey(key, "enter")) return false
    const action = view.actions[choices.getSelectedIndex()]
    if (!action) return true
    ctx.dialogs.close(false)
    confirm(ctx, session, action, () => overview(ctx, session))
    return true
  }
  choices.focus()
  void refresh(view)
}

async function refresh(view: Overview) {
  const { ctx, session, dialog, text, choices } = view
  const version = ++view.request
  try {
    const harness = await ctx.connection.client.sessions.state({ sessionID: session.id })
    if (version !== view.request || ctx.state.modal !== dialog) return
    view.actions = ctx.blocked(session.id) ? [] : available(harness)
    choices.options = view.actions.map((action) => ({ name: title(action), description: "" }))
    choices.visible = view.actions.length > 0
    text.content = describe(session, harness)
    dialog.error.content = `${view.actions.length ? "Enter chooses a change to confirm · " : ""}Ctrl+R refresh · Esc close${ctx.blocked(session.id) ? "\nTask-owned session: read-only." : ""}`
  } catch (error) {
    if (version !== view.request || ctx.state.modal !== dialog) return
    view.actions = []
    choices.visible = false
    text.content = `Harness unavailable: ${errorText(error)}`
    dialog.error.content = "Ctrl+R retry · Esc close"
  }
}
