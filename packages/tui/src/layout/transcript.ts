import { BoxRenderable, ScrollBoxRenderable, TextAttributes, TextRenderable, type CliRenderer } from "@opentui/core"
import { createMarkdown } from "../markdown"
import { color } from "../theme"

/** Builds the title, context and activity lines at the top of the main pane. */
export function createSessionHeader(renderer: CliRenderer, main: BoxRenderable) {
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
  return { sessionTitle, context, activity }
}

/** Builds the Older / Newer history row. */
export function createHistoryActions(renderer: CliRenderer, main: BoxRenderable) {
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
  return { historyActions, older, newer, historyCount }
}

/** Builds the scrolling transcript, with plain text and markdown bodies and the function that switches between them. */
export function createTranscript(renderer: CliRenderer, main: BoxRenderable) {
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

  function renderContent(value: string, rich = false) {
    content.visible = !rich
    markdown.visible = rich
    if (rich) markdown.content = value
    if (!rich) content.content = value
  }

  return { detail, renderContent }
}
