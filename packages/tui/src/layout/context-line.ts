import { TextRenderable, type StyledText } from "@opentui/core"
import { fitPath } from "../chrome"
import { layout } from "../theme"

/**
 * Fits the context line (`/some/folder · ↑ scrolled up · End for latest`, with `History · …` first in History) to
 * `width`. Below the wide breakpoint the folder keeps only its last two segments (`…/worktrees/project`); wider,
 * the whole folder is shown while it fits and shortened from its start when it does not. The state words and
 * cues stay whole. With no room for a useful folder it is dropped. Text without a folder is returned as is.
 */
export function fitContext(text: string, width: number) {
  if (width <= 0) return text
  const fields = text.split(" · ")
  const at = fields.findIndex((field) => /^(?:[/~]|[A-Za-z]:[\\/])/.test(field))
  if (at < 0) return text
  const short = width < layout.wideBreakpoint ? lastSegments(fields[at]!, 2) : fields[at]!
  const whole = fields.with(at, short).join(" · ")
  if (whole.length <= width) return whole
  const rest = fields.filter((_, index) => index !== at)
  const path = fitPath(short, width - rest.join(" · ").length - 3)
  // A path cut inside a name (`…project`) says less than none.
  return (path === short || path.startsWith("…/") ? fields.with(at, path) : rest).join(" · ")
}

function lastSegments(path: string, count: number) {
  const parts = path.split("/").filter(Boolean)
  return parts.length > count ? `…/${parts.slice(-count).join("/")}` : path
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
