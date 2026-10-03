import { InputRenderable, TextRenderable } from "@opentui/core"
import { secretField } from "../secret-field"
import type { Target } from "../servers"
import { label } from "../state"
import { color } from "../theme"
import { paint, say } from "./paint"
import type { Picker } from "./types"

/** Opens the add-server form: address, optional name and username. */
export function add(picker: Picker) {
  const view = picker.view
  if (!view) return
  picker.mode = "add"
  const inputs = [
    ["Address", "https://turen.example or user@host[:port]"],
    ["Name (optional)", ""],
    ["Username (optional, URL servers)", ""],
  ].map(([title, placeholder]) => {
    view.fields.add(new TextRenderable(picker.renderer, { content: title!, fg: color.muted, height: 1 }))
    const input = new InputRenderable(picker.renderer, {
      width: "100%",
      maxLength: 512,
      placeholder: placeholder!,
      backgroundColor: color.bg,
      focusedBackgroundColor: color.selected,
      textColor: color.text,
      placeholderColor: color.muted,
      marginBottom: 1,
    })
    view.fields.add(input)
    return input
  })
  picker.form = { inputs, index: 0 }
  inputs[0]!.focus()
  say(picker, `Saved to ${picker.servers.configPath}. Passwords are never saved.`)
  paint(picker)
}

/** Opens the hidden password prompt for a server that rejected the credentials this client had. */
export function password(picker: Picker, target: Target) {
  const view = picker.view
  if (!view) return
  picker.mode = "password"
  view.fields.add(
    new TextRenderable(picker.renderer, {
      content: `Password for ${label(target.name, 80)} (hidden; kept only until you quit)`,
      fg: color.muted,
      height: 1,
    }),
  )
  const field = secretField(picker.renderer, {
    limit: 1024,
    reject: () => say(picker, "At most 1,024 characters and no control characters. Ctrl+U clears.", "error"),
  })
  view.fields.add(field.field)
  field.field.focus()
  picker.secret = { target, field: field.field, take: field.take }
  say(picker, `${target.name} needs a password.`, "warning")
  paint(picker)
}

export function endFields(picker: Picker) {
  if (!picker.view) return
  for (const child of picker.view.fields.getChildren()) child.destroyRecursively()
  picker.form = undefined
  picker.secret = undefined
  picker.mode = "list"
  picker.renderer.currentFocusedRenderable?.blur()
  paint(picker)
}
