import { BoxRenderable, TextAttributes, TextRenderable, type CliRenderer } from "@opentui/core"
import { color } from "../theme"

/** Builds the top bar and the status line under it; both are added to `root`. */
export function createTopbar(renderer: CliRenderer, root: BoxRenderable) {
  const topbar = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: "row", gap: 3 })
  root.add(topbar)
  const heading = new TextRenderable(renderer, {
    content: "TurenOS",
    fg: color.accent,
    attributes: TextAttributes.BOLD,
    height: 1,
    flexShrink: 0,
    minWidth: 7,
    wrapMode: "none",
    truncate: true,
  })
  topbar.add(heading)
  // The connected server; clicking it opens the server picker.
  const server = new TextRenderable(renderer, {
    content: "",
    fg: color.text,
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    height: 1,
    wrapMode: "none",
    truncate: true,
  })
  topbar.add(server)
  const running = new TextRenderable(renderer, { content: "", fg: color.muted, height: 1, flexShrink: 0 })
  topbar.add(running)
  const modelButton = new TextRenderable(renderer, { content: "Models m", fg: color.accent, flexShrink: 0 })
  topbar.add(modelButton)
  const switchButton = new TextRenderable(renderer, { content: "Sessions Ctrl+K", fg: color.accent, flexShrink: 0 })
  topbar.add(switchButton)
  const serversButton = new TextRenderable(renderer, {
    content: "Servers s",
    fg: color.accent,
    flexShrink: 0,
    visible: false,
  })
  topbar.add(serversButton)
  const status = new TextRenderable(renderer, {
    content: "Connecting…",
    fg: color.muted,
    height: 1,
    flexShrink: 0,
    wrapMode: "none",
    truncate: true,
  })
  root.add(status)
  return { heading, server, running, modelButton, switchButton, serversButton, status }
}
