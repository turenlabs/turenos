import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core"
import { color } from "../theme"

/** Builds the notice line and the footer row at the bottom of `root`. */
export function createFooter(renderer: CliRenderer, root: BoxRenderable) {
  const notice = new TextRenderable(renderer, {
    content: "",
    visible: false,
    fg: color.muted,
    height: "auto",
    maxHeight: 3,
    flexShrink: 0,
    wrapMode: "word",
  })
  root.add(notice)
  const footerRow = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: "row", gap: 2 })
  root.add(footerRow)
  const footer = new TextRenderable(renderer, {
    content: "",
    fg: color.muted,
    height: 1,
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    wrapMode: "none",
    truncate: true,
  })
  footerRow.add(footer)
  const shortcuts = new TextRenderable(renderer, { content: "", fg: color.muted, height: 1, flexShrink: 0 })
  footerRow.add(shortcuts)
  return { notice, footerRow, footer, shortcuts }
}

/** Builds the full-screen overlay shown while the terminal is smaller than the minimum size. */
export function createSizeNotice(renderer: CliRenderer, root: BoxRenderable) {
  const sizeNotice = new BoxRenderable(renderer, {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    zIndex: 100,
    backgroundColor: color.bg,
    padding: 1,
    onMouse: (event) => {
      event.preventDefault()
      event.stopPropagation()
    },
  })
  const sizeText = new TextRenderable(renderer, { content: "", fg: color.text, wrapMode: "word" })
  sizeNotice.add(sizeText)
  root.add(sizeNotice)
  return { sizeNotice, sizeText }
}
