import type { CliRenderer, KeyEvent, MouseEvent } from "@opentui/core"
import { matchesKey } from "./keys"
import { display } from "./messages"
import type { DashboardState } from "./state"

export function createCopyControls(
  renderer: CliRenderer,
  state: Pick<DashboardState, "modal">,
  say: (message: string, error?: boolean) => void,
) {
  function copySelection() {
    const text = display(renderer.getSelection()?.getSelectedText() ?? "")
    if (!text) {
      say(
        "Select text, then Ctrl+Y or right-click to copy. F6 enables terminal native selection/menu; F6 restores mouse.",
      )
      return
    }
    try {
      if (renderer.copyToClipboardOSC52(text)) {
        say("Terminal copy attempted (not confirmed). F6 for native selection/menu; F6 restores mouse.")
        return
      }
    } catch {
      // Clipboard support belongs to the terminal; leave the selection intact.
    }
    say("Terminal copy unavailable. F6 for native selection/menu; F6 restores mouse.", true)
  }

  function toggleMouse() {
    renderer.useMouse = !renderer.useMouse
    say(
      renderer.useMouse
        ? "TUI mouse enabled. F6 switches to terminal native selection/menu."
        : "TUI mouse disabled: use terminal native drag/right-click menu. F6 restores mouse.",
    )
  }

  return {
    copySelection,
    toggleMouse,
    key(key: KeyEvent): boolean {
      if (matchesKey(key, "f6")) {
        toggleMouse()
        return true
      }
      if (!matchesKey(key, "y", { ctrl: true })) return false
      if (state.modal && !display(renderer.getSelection()?.getSelectedText() ?? "")) return false
      copySelection()
      return true
    },
    rightClick(event: MouseEvent): void {
      if (event.type !== "down" || event.button !== 2) return
      event.preventDefault()
      event.stopPropagation()
      copySelection()
    },
  }
}
