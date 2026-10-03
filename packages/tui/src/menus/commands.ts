import { SelectRenderable } from "@opentui/core"
import { color } from "../theme"
import { matchesKey } from "../keys"
import type { MenuContext } from "./context"

export function commands(ctx: MenuContext, actions: { name: string; description: string; run: () => void }[]) {
  const dialog = ctx.dialogs.open("Commands", false, 17)
  if (!dialog) return
  const query = ctx.dialogs.input(dialog, "Find a command")
  const choices = actions.map((action) => ({
    ...action,
    title: action.name.toLowerCase(),
    name: `${action.name}  · ${action.description}`,
  }))
  let matches = choices
  const select = new SelectRenderable(ctx.renderer, {
    height: 6,
    options: choices,
    showDescription: false,
    showScrollIndicator: true,
    backgroundColor: color.panel,
    textColor: color.text,
    selectedTextColor: color.accent,
    selectedBackgroundColor: color.selected,
  })
  dialog.form.add(select)
  ctx.dialogs.track(dialog, select)
  dialog.error.content = "Type to search · ↑/↓ choose · Enter open · Esc close"
  query.on("input", () => {
    const text = query.value.toLowerCase()
    // Actions named by the query come before those that only mention it in their description.
    const named = choices.filter((action) => action.title.includes(text))
    const selected = named.includes(matches[select.getSelectedIndex()]!)
      ? matches[select.getSelectedIndex()]
      : undefined
    matches = [
      ...named,
      ...choices.filter((action) => !named.includes(action) && action.name.toLowerCase().includes(text)),
    ]
    select.options = matches
    select.setSelectedIndex(Math.max(0, selected ? matches.indexOf(selected) : 0))
    dialog.error.content = matches.length ? "↑/↓ choose · Enter open · Esc close" : "No matching commands · Esc close"
  })
  const open = () => {
    const action = matches[select.getSelectedIndex()]
    if (!action) return
    ctx.dialogs.close(false)
    action.run()
  }
  dialog.key = (key) => {
    if (matchesKey(key, "up") || matchesKey(key, "down")) {
      if (key.name === "up") select.moveUp()
      if (key.name === "down") select.moveDown()
      ctx.dialogs.reveal(dialog, select)
      return true
    }
    if (!matchesKey(key, "enter")) return false
    open()
    return true
  }
  select.on("itemSelected", open)
  query.focus()
}
