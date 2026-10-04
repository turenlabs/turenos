import { SelectRenderable, type KeyEvent } from "@opentui/core"
import { color } from "../theme"
import { matchesKey } from "../keys"
import { listRows, setRows } from "../dialogs/size"
import { fuzzyRank } from "../suggest/fuzzy"
import type { MenuContext } from "./context"

export function commands(ctx: MenuContext, actions: { name: string; description: string; run: () => void }[]) {
  const dialog = ctx.dialogs.open("Commands")
  if (!dialog) return
  const query = ctx.dialogs.input(dialog, "Find a command")
  const choices = actions.map((action) => ({
    ...action,
    title: action.name.toLowerCase(),
    name: `${action.name}  · ${action.description}`,
  }))
  let matches = choices
  // The caption, the field, its spacer and the hint's gap are the other rows; the list keeps the rest, so the form never scrolls.
  const rows = () => Math.min(Math.max(1, matches.length), listRows(ctx.renderer, 5))
  const select = new SelectRenderable(ctx.renderer, {
    height: rows(),
    options: choices,
    showDescription: false,
    backgroundColor: color.panel,
    textColor: color.text,
    selectedTextColor: color.accent,
    selectedBackgroundColor: color.selected,
  })
  dialog.form.add(select)
  ctx.dialogs.track(dialog, select)
  dialog.error.content = "Type to search · ↑/↓ choose · Enter run · Esc close"
  query.on("input", () => {
    matches = rank(choices, query.value.toLowerCase().trim())
    select.options = matches
    setRows(select, rows())
    select.setSelectedIndex(0)
    position()
  })
  const position = () => {
    const at = matches.length ? `${select.getSelectedIndex() + 1}/${matches.length} · ` : ""
    dialog.error.content = matches.length
      ? `${at}↑/↓ choose · Enter run · Esc close`
      : "No matching commands · Esc close"
  }
  select.on("selectionChanged", position)
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
    if (page(select, key, rows())) return true
    if (!matchesKey(key, "enter")) return false
    open()
    return true
  }
  select.on("itemSelected", open)
  query.focus()
}

/** Paging moves the choice; letting it scroll the form would carry the search field out of view. */
function page(select: SelectRenderable, key: KeyEvent, rows: number) {
  if (!matchesKey(key, "pageup") && !matchesKey(key, "pagedown")) return false
  const step = (key.name === "pageup" ? -1 : 1) * Math.max(1, rows - 1)
  select.setSelectedIndex(Math.max(0, Math.min(select.options.length - 1, select.getSelectedIndex() + step)))
  return true
}

/** Names rank prefix, then word start, then letters in order; a description mention comes last. */
function rank<T extends { title: string; name: string }>(choices: T[], text: string) {
  return choices
    .flatMap((action, index) => {
      const rank = fuzzyRank(text, action.title) ?? (action.name.toLowerCase().includes(text) ? 3 : undefined)
      return rank === undefined ? [] : [{ action, rank, index }]
    })
    .toSorted((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.action)
}
