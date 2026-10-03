import { SelectRenderable } from "@opentui/core"
import { matchesKey } from "../keys"
import type { ModalState } from "../state"
import { color } from "../theme"
import type { Flow } from "./flow"

export type Choice = { name: string; description: string; run: () => void }

/** A select list in `dialog`, optionally filtered by a search field. Enter or a click runs the choice. */
export function choose(flow: Flow, dialog: ModalState, choices: Choice[], searchable = false) {
  const { dialogs, state } = flow
  const query = searchable ? dialogs.input(dialog, "Find a provider", "", "Name or provider ID") : undefined
  if (query) query.maxLength = 256
  let matches = choices
  const select = new SelectRenderable(flow.renderer, {
    height: Math.min(12, Math.max(2, choices.length * 2)),
    minHeight: 2,
    options: choices,
    showDescription: true,
    showSelectionIndicator: false,
    showScrollIndicator: true,
    backgroundColor: color.panel,
    textColor: color.text,
    descriptionColor: color.muted,
    focusedBackgroundColor: color.selected,
    focusedTextColor: color.text,
    selectedBackgroundColor: color.accent,
    selectedTextColor: color.bg,
    selectedDescriptionColor: color.bg,
  })
  dialog.form.add(select)
  dialogs.track(dialog, select)
  const update = () => {
    const selected = matches[select.getSelectedIndex()]
    const terms = query?.value.toLowerCase().trim().split(/\s+/).filter(Boolean) ?? []
    matches = choices.filter((choice) =>
      terms.every((term) => `${choice.name} ${choice.description}`.toLowerCase().includes(term)),
    )
    select.options = matches
    select.setSelectedIndex(Math.max(0, selected ? matches.indexOf(selected) : 0))
    dialog.error.content = matches.length
      ? "Up/Down choose | Enter continue | Tab focus | Esc return to models"
      : "No matches. Clear the search to see providers and custom setup."
  }
  const pick = () => {
    if (state.modal === dialog) matches[select.getSelectedIndex()]?.run()
  }
  query?.on("input", update)
  dialog.key = (key) => {
    if (matchesKey(key, "up") || matchesKey(key, "down")) {
      if (key.name === "up") select.moveUp()
      if (key.name === "down") select.moveDown()
      dialogs.reveal(dialog, select)
      return true
    }
    if (!matchesKey(key, "enter")) return false
    pick()
    return true
  }
  select.on("itemSelected", pick)
  update()
  ;(query ?? select).focus()
}
