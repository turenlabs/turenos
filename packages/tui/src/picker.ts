import { SelectRenderable, TextRenderable, type CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import { matchesKey } from "./keys"
import { errorText } from "./server"
import type { DashboardState } from "./state"
import { color } from "./theme"

export type Choice = { name: string; description?: string; run: () => unknown }

/**
 * A dialog with an explanation above a list of choices; Enter closes it and runs the selected one.
 * `back` reopens the parent picker when Esc closes this one, so nested settings read as one menu.
 */
export function openPicker(
  renderer: CliRenderer,
  dialogs: Dialogs,
  input: { title: string; text?: string; choices: Choice[]; back?: () => void; height?: number; keys?: string },
) {
  const dialog = dialogs.open(input.title, false, input.height ?? 28)
  if (!dialog) return undefined
  const text = new TextRenderable(renderer, { content: input.text ?? "", fg: color.muted, wrapMode: "word" })
  dialog.form.add(text)
  let choices = input.choices
  const list = new SelectRenderable(renderer, {
    height: 12,
    flexShrink: 0,
    options: [],
    showDescription: true,
    backgroundColor: color.panel,
    textColor: color.text,
    descriptionColor: color.muted,
    selectedBackgroundColor: color.selected,
    selectedTextColor: color.accent,
  })
  dialog.frame.add(list, dialog.frame.getChildren().indexOf(dialog.error))
  dialogs.track(dialog, list)
  dialog.back = input.back
  dialog.error.content = input.keys ?? "↑↓ choose · Enter open · Esc back"
  dialog.key = (key) => {
    if (!matchesKey(key, "enter")) return false
    const choice = choices[list.getSelectedIndex()]
    if (!choice) return true
    dialogs.close(false)
    void choice.run()
    return true
  }
  function set(next: Choice[]) {
    choices = next
    list.options = next.map((choice) => ({ name: choice.name, description: choice.description ?? "" }))
    list.height = Math.max(2, Math.min(16, next.length * 2))
  }
  set(choices)
  list.focus()
  return { dialog, list, text, set }
}

export type Picker = NonNullable<ReturnType<typeof openPicker>>

/** A picker that loads before it can list its choices, and says so when the load fails. */
export async function openSection<T>(
  renderer: CliRenderer,
  dialogs: Dialogs,
  state: Pick<DashboardState, "modal">,
  input: { title: string; back?: () => void },
  work: () => Promise<T>,
  fill: (value: T, picker: Picker) => void,
) {
  const picker = openPicker(renderer, dialogs, { title: input.title, text: "Loading…", choices: [], back: input.back })
  if (!picker) return
  try {
    const value = await work()
    if (state.modal === picker.dialog) fill(value, picker)
  } catch (error) {
    if (state.modal === picker.dialog) picker.text.content = `${input.title} unavailable: ${errorText(error)}`
  }
}
