import { MarkdownRenderable, TextRenderable } from "@opentui/core"
import { color } from "../theme"
import { guard } from "./guard"
import { normalizeMarkdown, richContent } from "./normalize"

/** Markdown for ordinary content; text beyond the rich-rendering budget is shown as plain wrapped text. */
export class BoundedMarkdown extends MarkdownRenderable {
  private requested = ""
  private fallback?: TextRenderable

  override get content() {
    return this.requested
  }

  override set content(value: string) {
    if (this.isDestroyed || this.requested === value) return
    this.requested = value
    if (this.fallback) {
      this.remove(this.fallback)
      this.fallback.destroy()
      this.fallback = undefined
    }
    if (!richContent(value)) {
      super.content = ""
      this.fallback = new TextRenderable(this.ctx, {
        id: "markdown-plain",
        width: "100%",
        content: value,
        fg: color.text,
        wrapMode: "word",
      })
      this.add(this.fallback)
      return
    }
    super.content = normalizeMarkdown(value)
    // OpenTUI can reuse tables without calling renderNode again.
    guard(this)
  }
}
