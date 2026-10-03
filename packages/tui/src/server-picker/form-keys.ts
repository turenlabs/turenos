import type { KeyEvent } from "@opentui/core"
import { matchesKey } from "../keys"
import { connect } from "./connect"
import { endFields } from "./fields"
import { paint, say } from "./paint"
import { rescan } from "./scan"
import type { Picker } from "./types"

/** Keys while the add-server form or the password prompt is open. */
export function fieldKey(picker: Picker, key: KeyEvent) {
  const { form, secret } = picker
  // Keys go to whatever holds focus next; make sure that is this form, not a field behind it.
  const field = secret?.field ?? form?.inputs[form.index]
  if (field && picker.renderer.currentFocusedRenderable !== field) field.focus()
  if (matchesKey(key, "escape") || matchesKey(key, "c", { ctrl: true })) {
    key.preventDefault()
    say(picker, "")
    return endFields(picker)
  }
  if (form && (matchesKey(key, "tab") || matchesKey(key, "tab", { shift: true }))) {
    key.preventDefault()
    form.index = (form.index + (key.shift ? -1 : 1) + form.inputs.length) % form.inputs.length
    return form.inputs[form.index]!.focus()
  }
  if (!matchesKey(key, "enter")) return
  key.preventDefault()
  if (secret) return submitPassword(picker, secret)
  if (form)
    submitServer(
      picker,
      form.inputs.map((input) => input.value),
    )
}

function submitPassword(picker: Picker, secret: NonNullable<Picker["secret"]>) {
  const target = secret.target
  const value = secret.take()
  if (!value) return say(picker, "Enter the server's password.", "error")
  picker.servers.remember(target, value)
  endFields(picker)
  return void connect(picker, target)
}

function submitServer(picker: Picker, values: string[]) {
  const [address, name, username] = values
  void picker.servers.add({ address: address!, name, username }).then(
    async (target) => {
      endFields(picker)
      await rescan(picker)
      picker.selected = Math.max(
        0,
        picker.entries.findIndex((entry) => entry.target.id === target.id),
      )
      say(picker, `Saved ${target.name}. Press Enter to connect.`)
      paint(picker)
    },
    (error: unknown) => say(picker, error instanceof Error ? error.message : "Could not save the server.", "error"),
  )
}
