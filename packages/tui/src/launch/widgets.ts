import { RenderableEvents, SelectRenderable, TextRenderable, type CliRenderer } from "@opentui/core"
import { turenLogo } from "../logo"
import type { ModalState, DashboardState } from "../state"
import { color } from "../theme"
import { label } from "../state"

/** The wordmark above the form; it steps aside while open settings need a short terminal's rows. */
export function createLogo(
  renderer: CliRenderer,
  state: DashboardState,
  dialog: ModalState,
  ui: { settingsOpen: boolean },
) {
  const logo = new TextRenderable(renderer, {
    id: "turen-logo",
    ...turenLogo(),
    alignSelf: "center",
    flexShrink: 0,
    wrapMode: "none",
  })
  const resize = () => {
    if (state.closed || state.modal !== dialog || logo.isDestroyed) return
    // Open settings need every row on a short terminal; the mark and the frame's spacer rows return when the screen grows.
    const tight = ui.settingsOpen && renderer.height < 32
    logo.visible = !tight
    dialog.frame.paddingTop = dialog.frame.paddingBottom = tight ? 0 : 1
  }
  renderer.on("resize", resize)
  logo.once(RenderableEvents.DESTROYED, () => renderer.off("resize", resize))
  return { logo, resize }
}

export function createContext(renderer: CliRenderer, dialog: ModalState, editDirectory: () => void) {
  return new TextRenderable(renderer, {
    content: "",
    fg: color.text,
    height: 2,
    flexShrink: 0,
    wrapMode: "none",
    truncate: true,
    onMouseDown: (event) => {
      if (event.button !== 0 || dialog.busy) return
      event.preventDefault()
      dialog.settings?.()
      editDirectory()
    },
  })
}

export function createAgentSelect(renderer: CliRenderer, agent: string | undefined) {
  return new SelectRenderable(renderer, {
    height: agent ? 2 : 1,
    options: [{ name: "Server default", description: "" }, ...(agent ? [{ name: label(agent), description: "" }] : [])],
    backgroundColor: color.bg,
    textColor: color.text,
    descriptionColor: color.muted,
    selectedBackgroundColor: color.selected,
    selectedTextColor: color.accent,
    showDescription: false,
  })
}

// The desktop's "New workspace": the session works in its own git worktree, off the main checkout.
export function createWorkspaceSelect(renderer: CliRenderer, isolate: boolean | undefined) {
  const workspace = new SelectRenderable(renderer, {
    height: 2,
    options: [
      { name: "This folder", description: "" },
      { name: "New git worktree", description: "" },
    ],
    backgroundColor: color.bg,
    textColor: color.text,
    selectedBackgroundColor: color.selected,
    selectedTextColor: color.accent,
    showDescription: false,
  })
  workspace.setSelectedIndex(isolate ? 1 : 0)
  return workspace
}
