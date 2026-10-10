import { KeyEvent } from "@opentui/core"

export function repeat() {
  return new KeyEvent({
    name: "d",
    sequence: "d",
    raw: "d",
    ctrl: true,
    meta: false,
    option: false,
    shift: false,
    number: false,
    eventType: "repeat",
    source: "raw",
  })
}
