import type { CliRenderer } from "@opentui/core"
import { close } from "./server-picker/close"
import { choose, connect } from "./server-picker/connect"
import { keypress } from "./server-picker/keypress"
import { paint, say } from "./server-picker/paint"
import { rescan } from "./server-picker/scan"
import type { Hooks, Picker, Tone } from "./server-picker/types"
import { buildView } from "./server-picker/view"
import type { Servers, Target } from "./servers"

/**
 * Full-screen server chooser. It owns the keyboard while open; the dashboard behind it stays
 * mounted, so cancelling returns to it unchanged and a switch only happens once the new server
 * has answered with valid credentials.
 */
export function createServerPicker(renderer: CliRenderer, servers: Servers, hooks: Hooks) {
  const picker: Picker = {
    renderer,
    servers,
    hooks,
    view: undefined,
    entries: [],
    selected: 0,
    mode: "list",
    controller: undefined,
    focusID: undefined,
    back: undefined,
    armed: undefined,
    scanning: undefined,
    form: undefined,
    secret: undefined,
    visited: new Map(),
    listeners: { keypress: (key) => keypress(picker, key), resize: () => paint(picker) },
    choose: () => choose(picker),
  }

  function open(note?: string, tone: Tone = "muted", back?: () => void) {
    if (!picker.view) {
      picker.view = buildView(renderer)
      picker.back = back
      picker.focusID = hooks.current()?.target.id
      renderer.currentFocusedRenderable?.blur()
      renderer.keyInput.on("keypress", picker.listeners.keypress)
      renderer.on("resize", picker.listeners.resize)
      picker.scanning = setInterval(() => {
        if (picker.mode === "list") void rescan(picker)
      }, 3000)
    }
    picker.mode = "list"
    say(picker, note ?? "", tone)
    void rescan(picker)
  }

  return {
    open,
    /** Opens straight into connecting, as at startup. */
    start(target: Target) {
      // A failed explicit URL still needs a row to retry; remembering it lasts only for this picker.
      if (target.kind === "url" && !target.saved) picker.visited.set(target.id, target)
      open()
      picker.focusID = target.id
      void connect(picker, target)
    },
    close: (restore = true) => close(picker, restore),
    visible: () => !!picker.view,
  }
}
