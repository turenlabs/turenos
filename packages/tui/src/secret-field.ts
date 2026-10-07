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
  const secret = { value: "", limit: input.limit, reject: input.reject, field }
  field.handleKeyPress = (key) => maskedKey(secret, key)
  field.handlePaste = (event) => {
    event.preventDefault()
    if (event.bytes.byteLength > input.limit * 4) return input.reject()
    try {
      // A key copied with its line ending is the key, not a control character.
      append(secret, new TextDecoder("utf-8", { fatal: true }).decode(event.bytes).replace(/[\r\n]+$/, ""))
    } catch {
      input.reject()
    }
  }
  field.once("destroyed", () => {
    secret.value = ""
  })
  return {
    field,
    /** Returns the secret and clears the field. */
    take() {
      const result = secret.value
      update(secret, "")
      return result
    },
  }
}

type Secret = { value: string; limit: number; reject: () => void; field: InputRenderable }

function update(secret: Secret, next: string) {
  secret.value = next
  secret.field.value = "*".repeat(next.length)
}

function append(secret: Secret, text: string) {
  if (
    secret.value.length + text.length > secret.limit ||
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(text)
  )
    return secret.reject()
  update(secret, secret.value + text)
}

const NAVIGATION_KEYS = [
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
]

// Do not call the native handlers, even briefly, with unmasked input.
function maskedKey(secret: Secret, key: Parameters<InputRenderable["handleKeyPress"]>[0]) {
  if (key.eventType === "release") return true
  if (matchesKey(key, "u", { ctrl: true })) {
    update(secret, "")
    return true
  }
  if (key.ctrl || key.meta || key.option || key.super || key.hyper) return true
  if (matchesKey(key, "backspace") || matchesKey(key, "backspace", { shift: true })) {
    update(secret, Array.from(secret.value).slice(0, -1).join(""))
    return true
  }
  if (NAVIGATION_KEYS.includes(key.name)) return true
  append(secret, key.name === "space" ? " " : key.sequence)
  return true
}
