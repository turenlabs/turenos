import type { KeyEvent, SelectRenderable } from "@opentui/core"
import { color } from "../theme"
import { matchesKey } from "../keys"
import { listRows, setRows } from "../dialogs/size"
import { ResizingSelect } from "../picker"
import { fuzzyRank } from "../suggest/fuzzy"
import { selectChars } from "../settings/column"
import { label } from "../state"
import type { MenuContext } from "./context"

/** Rows read `Name  · Description (key)`; the description gives up its end, with `…`, so the key stays whole. */
export function commands(
  ctx: MenuContext,
  actions: Action[],
) {
  const dialog = ctx.dialogs.open("Commands")
  if (!dialog) return
  const query = ctx.dialogs.input(dialog, "Find a command")
  const choices = actions.map(choice)
  let matches = choices
  // The caption, the field, its spacer and the hint's gap are the other rows; the list keeps the rest, so the form never scrolls.
  const rows = () => Math.min(Math.max(1, matches.length), listRows(ctx.renderer, 5))
  const select = new ResizingSelect(ctx.renderer, {
    height: rows(),
    options: [],
    showDescription: false,
    backgroundColor: color.panel,
    textColor: color.text,
    selectedTextColor: color.accent,
    selectedBackgroundColor: color.selected,
  })
  // The dialog's laid-out width decides the cut, so rows are painted again when it changes.
  const paint = () => paintRows(select, matches)
  select.onSizeChange = paint
  paint()
  dialog.form.add(select)
  ctx.dialogs.track(dialog, select)
  dialog.error.content = "Type to search · ↑/↓ choose · Enter run · Esc close"
  query.on("input", () => {
    matches = rank(choices, query.value.toLowerCase().trim())
    paint()
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
    if (move(select, key)) {
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

type Action = { name: string; description: string; key?: string; run: () => void }

/** One palette row: the key stays whole after the text that may be cut. */
function choice(action: Action) {
  const suffix = action.key ? ` (${action.key})` : ""
  return {
    ...action,
    title: action.name.toLowerCase(),
    name: `${action.name}  · ${action.description}${suffix}`,
    row: `${action.name}  · ${action.description}`,
    suffix,
  }
}

function paintRows(select: SelectRenderable, matches: ReturnType<typeof choice>[]) {
  const chars = selectChars(select)
  select.options = matches.map((match) => ({
    name: label(match.row, chars - match.suffix.length) + match.suffix,
    description: "",
  }))
}

function move(select: SelectRenderable, key: KeyEvent) {
  if (matchesKey(key, "up")) select.moveUp()
  if (matchesKey(key, "down")) select.moveDown()
  return matchesKey(key, "up") || matchesKey(key, "down")
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
