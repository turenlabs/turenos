import { BoxRenderable, InputRenderable, TextRenderable } from "@opentui/core"
import { color } from "../theme"
import type { ModalState } from "../state"
import type { MenuContext } from "./context"
import type { Scope, ScopeButton } from "./switcher-state"

/** Search field, scope tabs, new-session row, results and the selected session's details, in their fixed dialog order. */
export function buildSwitcherView(
  ctx: MenuContext,
  dialog: ModalState,
  handlers: { scope: (value: Scope) => void; create: () => void },
) {
  const { renderer } = ctx
  const query = new InputRenderable(renderer, {
    placeholder: "Search title, project, agent, or session ID…",
    maxLength: 256,
    width: "100%",
    flexShrink: 0,
    backgroundColor: color.bg,
    focusedBackgroundColor: color.selected,
    textColor: color.text,
    placeholderColor: color.muted,
  })
  dialog.frame.add(query, 0)
  ctx.dialogs.track(dialog, query)
  const scopes = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: "row", gap: 2 })
  const scopeButtons: ScopeButton[] = (["recent", "all", "archived"] as const).map((value) => {
    const button = new TextRenderable(renderer, {
      content: value,
      fg: color.muted,
      onMouseDown: (event) => {
        if (event.button !== 0) return
        event.preventDefault()
        if (!dialog.busy) handlers.scope(value)
      },
    })
    scopes.add(button)
    return { value, button }
  })
  scopes.add(new TextRenderable(renderer, { content: "F2", fg: color.muted }))
  dialog.frame.add(scopes, 1)
  dialog.frame.add(
    new TextRenderable(renderer, {
      content: "+ New session  Ctrl+N",
      fg: color.accent,
      height: 1,
      flexShrink: 0,
      onMouseDown: (event) => {
        if (event.button !== 0) return
        event.preventDefault()
        handlers.create()
      },
    }),
    2,
  )
  const details = new TextRenderable(renderer, {
    content: "",
    height: 2,
    width: "100%",
    flexShrink: 0,
    fg: color.muted,
    wrapMode: "none",
    truncate: true,
  })
  // Under the results, next to the hint, so it reads as the selected row's details.
  dialog.frame.add(details, 4)
  return { query, scopeButtons, details }
}
