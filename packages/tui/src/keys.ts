import type { KeyEvent } from "@opentui/core"

export function matchesKey(
  key: KeyEvent,
  name: string,
  modifiers: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {},
) {
  return (
    key.eventType !== "release" &&
    !key.super &&
    !key.hyper &&
    key.ctrl === !!modifiers.ctrl &&
    (key.meta || key.option) === !!modifiers.meta &&
    key.shift === !!modifiers.shift &&
    (name === "enter" ? ["enter", "return", "kpenter", "linefeed"].includes(key.name) : key.name === name)
  )
}

export function printableKey(key: KeyEvent) {
  // CSI-u names the base key; sequence carries the delivered text (e.g. Shift+/ is ?).
  if (key.eventType === "release" || key.ctrl || key.meta || key.option || key.super || key.hyper) return ""
  return key.sequence.length === 1 && key.sequence >= " " && key.sequence <= "~" ? key.sequence : ""
}
