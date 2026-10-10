import type { KeyEvent, TextareaRenderable } from "@opentui/core"
import { insertMention, mentionMatches, mentionToken } from "@turenlabs/client/team"
import { matchesKey } from "../keys"
import { label, type ModalState } from "../state"
import { createSuggestionPopup } from "../suggest"
import type { Teammate, TeamContext } from "./types"

/**
 * The `@handle` list under the post editor. The grammar and the matching are the desktop's
 * (`@turenlabs/client/team`); the shared suggestion popup only draws the rows and takes the keys.
 */
export function createCompletion(
  ctx: TeamContext,
  dialog: ModalState,
  editor: TextareaRenderable,
  teammates: () => readonly Teammate[],
  locked: () => boolean,
) {
  const popup = teammateList(ctx, dialog, editor, teammates, locked)

  function accept() {
    const chosen = popup.current
    const token = mentionToken(editor.plainText, editor.cursorOffset)
    if (!chosen || !token) return false
    const next = insertMention(editor.plainText, token, chosen.handle)
    editor.setText(next.value)
    editor.cursorOffset = next.caret
    popup.dismiss()
    return true
  }

  /** Enter or Tab completes while the list is open; submitting by any route does the same. */
  function submit() {
    if (!popup.usable()) return false
    popup.refresh()
    if (!popup.visible) return false
    if (popup.status !== "ready" || !popup.choices.length) return popup.status === "loading"
    return accept()
  }

  function key(event: KeyEvent) {
    if (!popup.usable()) {
      popup.hide()
      return false
    }
    if (!editor.focused) return false
    popup.refresh()
    if (!popup.visible) return false
    if (matchesKey(event, "escape")) {
      event.preventDefault()
      popup.close()
      return true
    }
    if (matchesKey(event, "enter") || matchesKey(event, "tab")) {
      const consumed = submit()
      if (consumed) event.preventDefault()
      return consumed
    }
    if (popup.status !== "ready" || !popup.choices.length) return false
    return popup.move(event)
  }

  return { key, submit, popup }
}

function teammateList(
  ctx: TeamContext,
  dialog: ModalState,
  editor: TextareaRenderable,
  teammates: () => readonly Teammate[],
  locked: () => boolean,
) {
  return createSuggestionPopup<Teammate>(ctx.renderer, ctx.state, {
    id: `${editor.id}-teammates`,
    dialog,
    editor,
    locked,
    rows: (count) => {
      dialog.suggestionRows = count
      dialog.refresh?.()
      ctx.dialogs.resize()
    },
    window: () => Math.max(3, Math.min(6, ctx.renderer.height - 21)),
    match: (text, cursor) => mentionToken(text, cursor),
    // A change of teammates reloads the list the next time it opens.
    scope: () => JSON.stringify(teammates().map((item) => [item.id, item.handle, item.status])),
    load: async () => teammates(),
    filter: (items, query) => mentionMatches(items, query),
    line: (item) =>
      `@${label(item.handle, 32)}  ${label(item.name, 40)} · ${label(item.role, 40)}${item.status === "paused" ? " · paused" : ""}`,
    messages: { loading: "Loading teammates…", error: "Teammates unavailable." },
  })
}
