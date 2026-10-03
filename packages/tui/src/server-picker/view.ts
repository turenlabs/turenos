import { BoxRenderable, ScrollBoxRenderable, TextAttributes, TextRenderable, type CliRenderer } from "@opentui/core"
import { turenLogo } from "../logo"
import { color } from "../theme"
import type { View } from "./types"

export function buildView(renderer: CliRenderer): View {
  const overlay = overlayBox(renderer)
  const frame = frameBox(renderer)
  overlay.add(frame)
  const logo = new TextRenderable(renderer, {
    ...turenLogo(false),
    alignSelf: "center",
    flexShrink: 0,
    wrapMode: "none",
  })
  const heading = new TextRenderable(renderer, {
    content: "",
    fg: color.text,
    attributes: TextAttributes.BOLD,
    height: 1,
    flexShrink: 0,
    wrapMode: "none",
    truncate: true,
  })
  const list = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    minHeight: 3,
    contentOptions: { flexDirection: "column", paddingRight: 1 },
  })
  const fields = new BoxRenderable(renderer, { flexDirection: "column", flexShrink: 0, visible: false })
  const status = new TextRenderable(renderer, { content: "", fg: color.muted, flexShrink: 0, wrapMode: "word" })
  const keys = new TextRenderable(renderer, {
    content: "",
    fg: color.muted,
    height: 1,
    flexShrink: 0,
    wrapMode: "none",
    truncate: true,
  })
  for (const item of [logo, heading, list, fields, status, keys]) frame.add(item)
  renderer.root.add(overlay)
  return { overlay, logo, heading, list, fields, status, keys, rows: [] }
}

function overlayBox(renderer: CliRenderer) {
  return new BoxRenderable(renderer, {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    zIndex: 50,
    backgroundColor: color.bg,
    alignItems: "center",
    justifyContent: "center",
    padding: 1,
  })
}

function frameBox(renderer: CliRenderer) {
  return new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    maxWidth: 100,
    maxHeight: 36,
    border: true,
    borderStyle: "rounded",
    borderColor: color.border,
    title: " Servers ",
    titleColor: color.text,
    backgroundColor: color.panel,
    paddingX: 2,
    paddingY: 1,
    flexDirection: "column",
    gap: 1,
  })
}
