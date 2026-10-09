import { BoxRenderable, ScrollBoxRenderable, TextAttributes, TextRenderable, type CliRenderer } from "@opentui/core"
import { ANVIL_ASPECT, WORDMARK_ROWS, createAnvil } from "../anvil"
import { createMarkdown } from "../markdown"
import { color } from "../theme"
import { ContextLine } from "./context-line"

/** Builds the title and context lines at the top of the main pane, and the activity line `createMain` places under the transcript. */
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
  const context = new ContextLine(renderer, {
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
  return { sessionTitle, context, activity }
}

/** Builds the Older / Newer history row. */
export function createHistoryActions(renderer: CliRenderer, main: BoxRenderable) {
  const historyActions = new BoxRenderable(renderer, {
    visible: false,
    height: 1,
    flexShrink: 0,
    flexDirection: "row",
    gap: 2,
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

/** The welcome anvil's rows at most, and the fewest it shows at. */
const ANVIL_ROWS = { most: 14, fewest: 6 }

/**
 * Builds the scrolling transcript, with plain text and markdown bodies and the function that switches between them.
 * The welcome screen opens under the wordmark and the turning anvil, which `still` keeps still.
 */
export function createTranscript(renderer: CliRenderer, main: BoxRenderable, still: () => boolean) {
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
    // One column under the scrollbar and one gap, so wrapped text never touches the thumb.
    contentOptions: { flexDirection: "column", paddingRight: 2 },
  })
  main.add(detail)
  const anvil = createAnvil(renderer, { background: color.bg, still })
  Object.assign(anvil.view, { visible: false, marginBottom: 1, alignSelf: "flex-start" })
  detail.add(anvil.view)
  /** The welcome text's rows while the welcome shows, which the logo leaves room for. */
  let welcomeRows: number | undefined
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

  // The pane's size is known after its first layout, which fires `resize`; until then the logo waits for it, and it
  // turns only while it shows.
  function fitAnvil() {
    const room = detail.viewport.height - (welcomeRows ?? detail.viewport.height) - 2 - WORDMARK_ROWS
    const rows = Math.min(ANVIL_ROWS.most, room, Math.floor((detail.viewport.width - 2) / ANVIL_ASPECT))
    anvil.view.visible = rows >= ANVIL_ROWS.fewest
    if (!anvil.view.visible) return anvil.stop()
    anvil.size(rows)
    anvil.play()
  }
  detail.viewport.on("resize", fitAnvil)

  function renderContent(value: string, rich = false, welcome = false) {
    welcomeRows = welcome ? value.split("\n").length : undefined
    fitAnvil()
    content.visible = !rich
    markdown.visible = rich
    if (rich) markdown.content = value
    if (!rich) content.content = value
  }

  return { detail, renderContent }
}
