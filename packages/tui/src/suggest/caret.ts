import type { TextareaRenderable } from "@opentui/core"

// OpenTUI counts the caret in display cells, not string indices: "日" is one character in two cells and "👍🏽" four
// characters in two. Completion grammars index the string, so both conversions use the editor's own mapping.

/** The string index of the editor's caret. */
export function caretIndex(editor: TextareaRenderable) {
  return editor.getTextRange(0, editor.cursorOffset).length
}

/** Puts the caret at string index `index` of the editor's text. */
export function placeCaret(editor: TextareaRenderable, index: number) {
  // The editor puts a cell past the end at the start, and a selection would stop gotoBufferEnd at its edge.
  if (index >= editor.plainText.length) {
    editor.clearSelection()
    editor.gotoBufferEnd()
    return
  }
  // The text before a cell includes any grapheme that starts before it, so its length only grows with the cell. The
  // last cell whose text is at most `index` long is where the grapheme at `index` starts. The search reads text
  // without moving the caret, because each move scrolls the editor.
  let low = 0
  let high = index + 1
  while (editor.getTextRange(0, high).length <= index) {
    low = high
    high *= 2
  }
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    if (editor.getTextRange(0, middle).length <= index) {
      low = middle
      continue
    }
    high = middle
  }
  editor.cursorOffset = low
}
