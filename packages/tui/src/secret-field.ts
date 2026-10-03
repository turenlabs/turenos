import { InputRenderable, type CliRenderer } from "@opentui/core"
import { matchesKey } from "./keys"
import { color } from "./theme"

/** A single-line field whose native text, selection, events, and undo history only ever hold stars. */
export function secretField(renderer: CliRenderer, input: { limit: number; placeholder?: string; reject: () => void }) {
  const field = new InputRenderable(renderer, {
    maxLength: input.limit,
    placeholder: input.placeholder ?? "",
    backgroundColor: color.bg,
    textColor: color.text,
    focusedBackgroundColor: color.selected,
    focusedTextColor: color.text,
    placeholderColor: color.muted,
    marginBottom: 1,
  })
  let value = ""
  const update = (next: string) => {
    value = next
    field.value = "*".repeat(value.length)
  }
  const append = (text: string) => {
    if (
      value.length + text.length > input.limit ||
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(text)
    )
      return input.reject()
    update(value + text)
  }
  // Do not call the native handlers, even briefly, with unmasked input.
  field.handleKeyPress = (key) => {
    if (key.eventType === "release") return true
    if (matchesKey(key, "u", { ctrl: true })) {
      update("")
      return true
    }
    if (key.ctrl || key.meta || key.option || key.super || key.hyper) return true
    if (matchesKey(key, "backspace") || matchesKey(key, "backspace", { shift: true })) {
      update(Array.from(value).slice(0, -1).join(""))
      return true
    }
    if (
      [
        "enter",
        "return",
        "kpenter",
        "linefeed",
        "tab",
        "escape",
        "delete",
        "left",
        "right",
        "up",
        "down",
        "home",
        "end",
      ].includes(key.name)
    )
      return true
    append(key.name === "space" ? " " : key.sequence)
    return true
  }
  field.handlePaste = (event) => {
    event.preventDefault()
    if (event.bytes.byteLength > input.limit * 4) return input.reject()
    try {
      append(new TextDecoder("utf-8", { fatal: true }).decode(event.bytes))
    } catch {
      input.reject()
    }
  }
  field.once("destroyed", () => {
    value = ""
  })
  return {
    field,
    /** Returns the secret and clears the field. */
    take() {
      const result = value
      update("")
      return result
    },
  }
}
