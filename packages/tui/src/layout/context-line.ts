import { TextRenderable, type StyledText } from "@opentui/core"
import { fitPath } from "../chrome"

/**
 * Fits the context line (`Transcript · /some/folder · ↑ scrolled up · End for latest`) to `width` by
 * shortening the folder from its start; the state words and cues stay whole. With no room for a useful
 * folder it is dropped. Text without a folder is returned as is.
 */
export function fitContext(text: string, width: number) {
  if (width <= 0 || text.length <= width) return text
  const fields = text.split(" · ")
  const at = fields.findIndex((field) => /^(?:[/~]|[A-Za-z]:[\\/])/.test(field))
  if (at < 0) return text
  const rest = fields.filter((_, index) => index !== at)
  const path = fitPath(fields[at]!, width - rest.join(" · ").length - 3)
  // A path cut inside a name (`…project`) says less than none.
  return (path === fields[at] || path.startsWith("…/") ? fields.with(at, path) : rest).join(" · ")
}

/** The line under the session title. It keeps the full text it was given and shows the part that fits its width. */
export class ContextLine extends TextRenderable {
  full = ""

  override get content(): StyledText {
    return super.content
  }
  override set content(value: StyledText | string) {
    this.full = typeof value === "string" ? value : value.chunks.map((chunk) => chunk.text).join("")
    super.content = fitContext(this.full, this.width)
  }

  protected override onResize(width: number, height: number) {
    super.onResize(width, height)
    const fitted = fitContext(this.full, width)
    if (fitted !== this.plainText) super.content = fitted
  }
}
