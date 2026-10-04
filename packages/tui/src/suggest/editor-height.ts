import type { TextareaRenderable } from "@opentui/core"

/** Keeps `editor` as tall as its text between `min` and `max` rows; `resized` runs after each change of height. */
export function followText(editor: TextareaRenderable, min: number, max: number, resized: () => void = () => {}) {
  // Counted from `lineInfo.lineSources.length`: virtualLineCount can be viewport-limited.
  const rows = () => Math.max(min, Math.min(max, editor.lineInfo.lineSources.length))
  editor.minHeight = min
  editor.height = rows()
  const changed = editor.onContentChange
  editor.onContentChange = (event) => {
    changed?.(event)
    if (editor.height === rows()) return
    editor.height = rows()
    resized()
  }
}
