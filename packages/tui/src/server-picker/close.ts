import type { Picker } from "./types"

export function close(picker: Picker, restore = true) {
  if (!picker.view) return
  picker.controller?.abort()
  if (picker.scanning) clearInterval(picker.scanning)
  picker.renderer.keyInput.off("keypress", picker.listeners.keypress)
  picker.renderer.off("resize", picker.listeners.resize)
  picker.view.overlay.destroyRecursively()
  picker.view = undefined
  picker.form = undefined
  picker.secret = undefined
  picker.armed = undefined
  picker.back = undefined
  picker.focusID = undefined
  picker.mode = "list"
  if (restore) picker.hooks.closed()
}

/** Esc or choosing the current server: back to the menu that opened Servers, else to the dashboard. */
export function leave(picker: Picker) {
  const back = picker.back
  close(picker, !back)
  back?.()
}
