import { SelectRenderable, TextRenderable, type CliRenderer, type ScrollBoxRenderable } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import { setRows } from "./dialogs/size"
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
  input: {
    title: string
    text?: string
    choices: Choice[]
    back?: () => void
    height?: number
    keys?: string
    /** What Enter does on a row, for the default hint: "open" for a submenu, "toggle" for a switch. */
    verb?: string
    /** Remembers the cursor by title, so reopening the picker after an action keeps the selected row. */
    memory?: Map<string, number>
  },
) {
  const dialog = dialogs.open(input.title, false, input.height ?? 28)
  if (!dialog) return undefined
  const text = new TextRenderable(renderer, {
    content: input.text ?? "",
    fg: color.muted,
    wrapMode: "word",
    flexShrink: 0,
  })
  const form = dialog.form
  form.add(text)
  let choices = input.choices
  // The list is as tall as its rows and shrinks, with a scroll thumb, when the screen has fewer.
  form.flexGrow = 0
  form.flexShrink = 0
  const list = choiceList(renderer)
  dialog.frame.add(list, dialog.frame.getChildren().indexOf(dialog.error))
  dialogs.track(dialog, list)
  dialog.back = input.back
  dialog.error.content =
    input.keys ?? `↑↓ choose · Enter ${input.verb ?? "select"} · Esc ${input.back ? "back" : "close"}`
  dialog.key = (key) => {
    if (!matchesKey(key, "enter")) return false
    const choice = choices[list.getSelectedIndex()]
    if (!choice) return true
    dialogs.close(false)
    void choice.run()
    return true
  }
  const fit = () => fitText(renderer, form, text)
  function set(next: Choice[]) {
    fit()
    const keep = input.memory?.get(input.title) ?? 0
    choices = next
    list.options = next.map((choice) => ({ name: choice.name, description: choice.description ?? "" }))
    setRows(list, next.length * 2)
    list.setSelectedIndex(Math.max(0, Math.min(keep, next.length - 1)))
  }
  set(choices)
  list.on("selectionChanged", () => input.memory?.set(input.title, list.getSelectedIndex()))
  list.focus()
  return { dialog, list, text, set, fit }
}

function choiceList(renderer: CliRenderer) {
  return new SelectRenderable(renderer, {
    flexGrow: 0,
    flexShrink: 1,
    minHeight: 2,
    options: [],
    showDescription: true,
    showScrollIndicator: true,
    backgroundColor: color.panel,
    textColor: color.text,
    descriptionColor: color.muted,
    selectedBackgroundColor: color.selected,
    selectedTextColor: color.accent,
  })
}

/** The explanation takes the rows its wrapped text needs and the list scrolls in the rest. */
function fitText(renderer: CliRenderer, form: ScrollBoxRenderable, text: TextRenderable) {
  const width = Math.max(20, Math.min(70, Math.floor(renderer.width * 0.95)) - 5)
  form.height = Math.max(
    1,
    text.plainText.split("\n").reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / width)), 0),
  )
}

export type Picker = NonNullable<ReturnType<typeof openPicker>>

/** A picker that loads before it can list its choices, and says so when the load fails. */
export async function openSection<T>(
  renderer: CliRenderer,
  dialogs: Dialogs,
  state: Pick<DashboardState, "modal">,
  input: { title: string; back?: () => void; keys?: string; verb?: string; memory?: Map<string, number> },
  work: () => Promise<T>,
  fill: (value: T, picker: Picker) => void,
) {
  const picker = openPicker(renderer, dialogs, {
    title: input.title,
    text: "Loading…",
    choices: [],
    back: input.back,
    keys: input.keys,
    verb: input.verb,
    memory: input.memory,
  })
  if (!picker) return
  try {
    const value = await work()
    if (state.modal === picker.dialog) fill(value, picker)
  } catch (error) {
    if (state.modal === picker.dialog) {
      picker.text.content = `${input.title} unavailable: ${errorText(error)}`
      picker.fit()
      picker.set([
        {
          name: "Refresh",
          description: "Try again",
          run: () => openSection(renderer, dialogs, state, input, work, fill),
        },
      ])
      picker.dialog.error.content = `↑↓ choose · Enter refresh · Esc ${input.back ? "back" : "close"}`
    }
  }
}
