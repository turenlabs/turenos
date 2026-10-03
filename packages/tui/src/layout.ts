import {
  BoxRenderable,
  InputRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  TextAttributes,
  type CliRenderer,
} from "@opentui/core"
import { createMarkdown } from "./markdown"
import { color, layout } from "./theme"
import { folderContains } from "./working-folders"
import type { DashboardState } from "./state"
import { SessionListRenderable } from "./session-list"

export function createLayout(renderer: CliRenderer, state: DashboardState) {
  const root = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    paddingX: 2,
    paddingTop: 1,
    backgroundColor: color.bg,
  })
  renderer.root.add(root)
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
  const tabButtons = (["sessions", "terminals", "automations"] as const).map((tab, index) => ({
    tab,
    button: new TextRenderable(renderer, { content: "", fg: color.accent, height: 1 }),
    name: `${index + 1} ${["Sessions", "Terminals", "Automations"][index]}`,
  }))
  const body = new BoxRenderable(renderer, { flexDirection: "row", flexGrow: 1, minHeight: 1, gap: 2 })
  root.add(body)
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
  const main = new BoxRenderable(renderer, {
    flexGrow: 1,
    minWidth: 1,
    flexDirection: "column",
    // Keep transcript text off the pane edge; the composer box below is
    // inset further by its own border and padding.
    paddingLeft: 1,
  })
  body.add(main)
  body.add(sidebar)
  const sessionTitle = new TextRenderable(renderer, {
    content: "Welcome to TurenOS",
    fg: color.text,
    attributes: TextAttributes.BOLD,
    height: 1,
    flexShrink: 0,
    wrapMode: "none",
    truncate: true,
  })
  main.add(sessionTitle)
  const context = new TextRenderable(renderer, {
    content: "",
    height: 1,
    flexShrink: 0,
    fg: color.muted,
    wrapMode: "none",
    truncate: true,
  })
  main.add(context)
  const activity = new TextRenderable(renderer, {
    content: "",
    visible: false,
    height: 1,
    flexShrink: 0,
    fg: color.accent,
    truncate: true,
    wrapMode: "none",
  })
  main.add(activity)
  const historyActions = new BoxRenderable(renderer, {
    visible: false,
    height: 1,
    flexShrink: 0,
    flexDirection: "row",
    gap: 3,
  })
  main.add(historyActions)
  const older = new TextRenderable(renderer, { content: "[ Older", fg: color.accent })
  const newer = new TextRenderable(renderer, { content: "] Newer", fg: color.accent })
  const historyCount = new TextRenderable(renderer, { content: "", fg: color.muted })
  historyActions.add(older)
  historyActions.add(newer)
  historyActions.add(historyCount)
  const detail = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    width: "100%",
    minWidth: 1,
    border: false,
    marginTop: 1,
    padding: 0,
    scrollY: true,
    scrollX: false,
    stickyScroll: false,
    contentOptions: { flexDirection: "column", paddingRight: 1 },
  })
  main.add(detail)
  const content = new TextRenderable(renderer, {
    content: "Connecting to the server…",
    fg: color.text,
    width: "100%",
    wrapMode: "word",
  })
  detail.add(content)
  const markdown = createMarkdown(renderer)
  markdown.visible = false
  detail.add(markdown)
  const actions = new BoxRenderable(renderer, {
    height: 3,
    flexShrink: 0,
    flexDirection: "column",
    paddingX: 2,
    backgroundColor: color.panel,
    border: ["left"],
    borderColor: color.focus,
    marginTop: 1,
  })
  main.add(actions)
  const composer = new TextRenderable(renderer, {
    content: " Send a message…  f",
    fg: color.muted,
    bg: color.panel,
    height: 1,
    width: "100%",
    flexShrink: 0,
    minWidth: 1,
    truncate: true,
    wrapMode: "none",
  })
  actions.add(composer)
  const secondaryActions = new BoxRenderable(renderer, {
    height: 1,
    flexShrink: 0,
    flexDirection: "row",
    gap: 2,
  })
  actions.add(secondaryActions)
  const history = new TextRenderable(renderer, { content: "h History", fg: color.muted, flexShrink: 0 })
  secondaryActions.add(history)
  const information = new TextRenderable(renderer, { content: "i Details", fg: color.muted, flexShrink: 0 })
  secondaryActions.add(information)
  const changes = new TextRenderable(renderer, { content: "d Changes", fg: color.muted, flexShrink: 0 })
  secondaryActions.add(changes)
  const files = new TextRenderable(renderer, { content: "e Files", fg: color.muted, flexShrink: 0 })
  secondaryActions.add(files)
  const tasks = new TextRenderable(renderer, { content: "t Tasks", visible: false, fg: color.accent, flexShrink: 0 })
  secondaryActions.add(tasks)
  const queued = new TextRenderable(renderer, { content: "u Queued", visible: false, fg: color.accent, flexShrink: 0 })
  secondaryActions.add(queued)
  const harness = new TextRenderable(renderer, { content: "H Harness", fg: color.muted, flexShrink: 0 })
  secondaryActions.add(harness)
  const meter = new TextRenderable(renderer, { content: "", visible: false, fg: color.muted, flexShrink: 0 })
  secondaryActions.add(meter)
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

  function resize() {
    sizeNotice.visible = renderer.width < layout.minWidth || renderer.height < layout.minHeight
    sizeText.content = `Resize the terminal\n\nTurenOS needs at least ${layout.minWidth} columns × ${layout.minHeight} rows.\nCurrent size: ${renderer.width} × ${renderer.height}.\n\nYour draft stays open while you resize.\nq / Ctrl+C quits.`
    const narrow = renderer.width < layout.narrowBreakpoint
    running.visible = renderer.width >= 70
    modelButton.content = state.modal ? (state.modal.chooseModel ? "Models Ctrl+L" : "Models") : "Models m"
    modelButton.fg = !state.modal || (state.modal.chooseModel && !state.modal.busy) ? color.accent : color.muted
    switchButton.content = state.modal ? "Sessions" : "Sessions Ctrl+K"
    switchButton.fg = !state.modal || (state.modal.save && !state.modal.busy) ? color.accent : color.muted
    serversButton.content = state.modal ? "Servers" : "Servers s"
    serversButton.fg = state.modal?.busy ? color.muted : color.accent
    body.flexDirection = narrow ? "column" : "row"
    body.gap = narrow ? 1 : 2
    sidebar.visible =
      !!state.modal?.sidebar ||
      (!(state.sidebarHidden ?? narrow) && !state.modal?.inline && !(narrow && state.modal?.docked))
    sidebarHeading.visible = !narrow
    folders.visible = !narrow
    emptyFolders.visible =
      !narrow &&
      state.tab === "sessions" &&
      (state.snapshot?.workingFolders ?? []).some(
        (directory) =>
          !state.snapshot?.sessions.some((session) => folderContains(directory, session.location.directory)),
      )
    sidebar.paddingTop = 0
    sidebar.paddingBottom = 0
    sidebar.width = narrow
      ? "100%"
      : state.modal?.sidebar
        ? Math.min(80, Math.max(48, Math.floor(renderer.width * 0.45)))
        : Math.min(56, Math.max(layout.sidebarWidth, Math.floor(renderer.width * 0.3)))
    sidebar.height =
      narrow && !state.modal?.sidebar ? Math.max(6, Math.min(10, Math.round((renderer.height - 4) / 3))) : "100%"
    sidebar.flexShrink = 0
    main.width = narrow ? "100%" : "auto"
    main.visible = !(narrow && state.modal?.sidebar)
    main.height = narrow && sidebar.visible ? "auto" : "100%"
    sessionTitle.visible = !state.modal?.inline
    context.visible = !state.modal?.inline && !!state.selected
    historyActions.visible = state.tab === "sessions" && state.history && !!state.selected && !state.modal?.inline
    actions.visible = !state.modal
    if (state.modal?.docked) {
      const editorHeight = state.modal.editor
        ? Math.max(3, Math.min(6, state.modal.editor.lineInfo.lineSources.length))
        : 0
      state.modal.box.height = Math.min(
        Math.floor(renderer.height / 2),
        state.modal.editor
          ? editorHeight +
              state.modal.error.height +
              3 +
              (state.modal.suggestionRows ?? 0) +
              (state.modal.mentionRows ?? 0)
          : state.modal.height,
      )
    }
    footerRow.visible = !state.modal
    shortcuts.content = narrow ? "Ctrl+P commands · ? help · q quit" : "Ctrl+P commands · Tab pane · ? help · q quit"
  }

  for (const pane of [list, detail])
    pane.on("focused", () => {
      if (state.modal || state.searching) return
      state.detailFocused = pane === detail
      sidebarHeading.fg = state.detailFocused ? color.muted : color.accent
      actions.borderColor = state.detailFocused ? color.focus : color.border
      renderer.setCursorPosition(0, 0, false)
    })

  function focus() {
    if (state.closed || state.modal) return
    if (state.searching) return search.focus()
    if (!sidebar.visible) state.detailFocused = true
    if (state.detailFocused) detail.focus()
    if (!state.detailFocused) list.focus()
    renderer.setCursorPosition(0, 0, false)
    sidebarHeading.fg = state.detailFocused ? color.muted : color.accent
    actions.borderColor = state.detailFocused ? color.focus : color.border
  }

  renderer.setCursorPosition(0, 0, false)

  function renderContent(value: string, rich = false) {
    content.visible = !rich
    markdown.visible = rich
    if (rich) markdown.content = value
    if (!rich) content.content = value
  }

  return {
    root,
    main,
    heading,
    server,
    running,
    modelButton,
    switchButton,
    serversButton,
    status,
    tabButtons,
    sidebar,
    sidebarHeading,
    sidebarActions,
    search,
    folders,
    emptyFolders,
    list,
    sessionTitle,
    context,
    activity,
    historyActions,
    older,
    newer,
    historyCount,
    detail,
    actions,
    composer,
    history,
    information,
    changes,
    files,
    tasks,
    queued,
    harness,
    meter,
    notice,
    footer,
    sizeNotice,
    resize,
    focus,
    renderContent,
  }
}

export type DashboardLayout = ReturnType<typeof createLayout>
