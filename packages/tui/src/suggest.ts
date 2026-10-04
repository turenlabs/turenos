import type { CliRenderer, KeyEvent } from "@opentui/core"
import type { DashboardState } from "./state"
import { close, dismiss, hide, move, replace, usable } from "./suggest/popup-ops"
import { createPopupState, type PopupOptions } from "./suggest/popup-state"
import { refresh } from "./suggest/refresh"

export type { Trigger } from "./suggest/popup-state"

/**
 * The shared editor-completion popup: a bounded three-row list under a prompt
 * editor, backed by a generation-guarded async inventory. Callers supply what
 * activates it and how results are named; accepting a choice stays with the
 * caller because command admission and path completion resolve differently.
 */
export function createSuggestionPopup<T>(
  renderer: CliRenderer,
  state: Pick<DashboardState, "modal" | "closed">,
  options: PopupOptions<T>,
) {
  const popup = createPopupState(renderer, state, options)
  const editor = options.editor

  const previous = editor.onContentChange
  editor.onContentChange = (event) => {
    previous?.(event)
    refresh(popup)
  }

  return {
    refresh: () => refresh(popup),
    hide: () => hide(popup),
    close: () => close(popup),
    dismiss: () => dismiss(popup),
    usable: () => usable(popup),
    move: (event: KeyEvent) => move(popup, event),
    replace: (text: string, cursor: number) => replace(popup, text, cursor),
    get visible() {
      return popup.suggestions.visible
    },
    get status() {
      return popup.status
    },
    get choices(): readonly T[] {
      return popup.choices
    },
    get current() {
      return popup.choices[popup.selected]
    },
    get query() {
      return popup.query
    },
  }
}

export type SuggestionPopup<T> = ReturnType<typeof createSuggestionPopup<T>>
