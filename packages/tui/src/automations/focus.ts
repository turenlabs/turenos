import { fieldFrame } from "../dialogs/fields"
import { RenderableEvents, TextRenderable, type Renderable } from "@opentui/core"

/** Prefixes the focused field's caption with an arrow, so focus shows in plain text as well as by colour. */
export function markFocus(field: Renderable) {
  // An input drawn in a `[ ]` frame has its caption beside the frame, not beside the input.
  const anchor = field.parent?.id === fieldFrame ? field.parent : field
  const caption = anchor.parent?.getChildren()[anchor.parent.getChildren().indexOf(anchor) - 1]
  if (!(caption instanceof TextRenderable)) return
  const text = caption.plainText
  // A closing dialog blurs its field after the caption is already gone.
  const paint = () => {
    if (!caption.isDestroyed) caption.content = `${field.focused ? "▶ " : "  "}${text}`
  }
  field.on(RenderableEvents.FOCUSED, paint)
  field.on(RenderableEvents.BLURRED, paint)
  paint()
}
