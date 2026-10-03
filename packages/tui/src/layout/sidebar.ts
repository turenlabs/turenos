import { BoxRenderable, InputRenderable, TextAttributes, TextRenderable, type CliRenderer } from "@opentui/core"
import { color, layout } from "../theme"
import { SessionListRenderable } from "../session-list"

/** The view-switch buttons are created before the body so renderable ids keep their order. */
export function createTabButtons(renderer: CliRenderer) {
  return (["sessions", "terminals", "automations"] as const).map((tab, index) => ({
    tab,
    button: new TextRenderable(renderer, { content: "", fg: color.accent, height: 1 }),
    name: `${index + 1} ${["Sessions", "Terminals", "Automations"][index]}`,
  }))
}

type TabButtons = ReturnType<typeof createTabButtons>

/** Builds the sessions sidebar. The caller adds it to the body. */
export function createSidebar(renderer: CliRenderer, tabButtons: TabButtons) {
  const sidebar = new BoxRenderable(renderer, {
    width: layout.sidebarWidth,
    minWidth: layout.sidebarMinWidth,
    border: ["left"],
    borderColor: color.border,
    padding: 1,
    paddingLeft: 2,
    flexDirection: "column",
    backgroundColor: color.panel,
  })
  const sidebarHeading = new TextRenderable(renderer, {
    content: "Sessions",
    fg: color.muted,
    attributes: TextAttributes.BOLD,
    height: 1,
    flexShrink: 0,
  })
  sidebar.add(sidebarHeading)
  const viewSwitch = new BoxRenderable(renderer, { flexDirection: "row", flexShrink: 0, height: 1, gap: 1 })
  sidebar.add(viewSwitch)
  for (const { button } of tabButtons) viewSwitch.add(button)
  const sidebarActions = new TextRenderable(renderer, {
    content: " + New session    n\n / Find a session",
    fg: color.text,
    height: 2,
    flexShrink: 0,
  })
  sidebar.add(sidebarActions)
  const folders = new TextRenderable(renderer, {
    content: " Working folders",
    fg: color.accent,
    height: 1,
    flexShrink: 0,
  })
  sidebar.add(folders)
  const emptyFolders = new TextRenderable(renderer, {
    content: "",
    visible: false,
    fg: color.muted,
    height: 1,
    flexShrink: 0,
    wrapMode: "none",
    truncate: true,
  })
  sidebar.add(emptyFolders)
  return { sidebar, sidebarHeading, sidebarActions, folders, emptyFolders, ...createSearchAndList(renderer, sidebar) }
}

function createSearchAndList(renderer: CliRenderer, sidebar: BoxRenderable) {
  const search = new InputRenderable(renderer, {
    visible: false,
    width: "100%",
    maxLength: 256,
    placeholder: "Filter items…",
    backgroundColor: color.bg,
    focusedBackgroundColor: color.selected,
    textColor: color.text,
    placeholderColor: color.muted,
  })
  sidebar.add(search)
  const list = new SessionListRenderable(renderer)
  sidebar.add(list)
  return { search, list }
}
