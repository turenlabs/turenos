import { BoxRenderable, SelectRenderable, TextRenderable, type CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import { mentionText } from "./prompt-files"
import type { Session } from "./server"
import type { ModalState } from "./state"
import { color } from "./theme"
import { fitHints } from "./changes/heading"

export type Drafts = { mention: (session: Session, text: string) => boolean; reply: () => void }

/**
 * A near-full-screen dialog split into a chooser on the left and the chosen item's content on the
 * right, like the desktop's review and file panels. The content pane is the dialog's own scroll
 * form, so Page Up/Down scroll it while arrows move the chooser.
 */
export function openPanel(
  renderer: CliRenderer,
  dialogs: Dialogs,
  title: string,
  /** The chooser's share of the width; a panel whose rows are short gives the rest to its content. */
  listWidth: number | `${number}%` = "34%",
) {
  const dialog = dialogs.open(title, false, 999)
  if (!dialog) return undefined
  dialog.frame.maxWidth = 220
  dialog.frame.width = "98%"
  // Whole rows: a fractional percent height lets the list overlap the hint. The dialog size rule caps it below the screen.
  dialog.frame.height = "100%"
  // The hint is at most two whole lines; a fixed height keeps it from growing into the list.
  dialog.error.height = 2
  const heading = new TextRenderable(renderer, {
    content: "",
    fg: color.muted,
    height: 1,
    // A fixed width, so a long heading cannot widen its own box past the frame.
    width: "100%",
    flexShrink: 0,
    wrapMode: "none",
    truncate: true,
  })
  const row = new BoxRenderable(renderer, { flexDirection: "row", flexGrow: 1, minHeight: 1, gap: 2 })
  const list = new SelectRenderable(renderer, {
    width: listWidth,
    minWidth: 24,
    flexShrink: 0,
    options: [],
    showDescription: false,
    showSelectionIndicator: true,
    wrapSelection: false,
    backgroundColor: color.panel,
    textColor: color.text,
    selectedBackgroundColor: color.selected,
    selectedTextColor: color.accent,
  })
  const index = dialog.frame.getChildren().indexOf(dialog.form)
  dialog.frame.remove(dialog.form)
  row.add(list)
  row.add(dialog.form)
  dialog.frame.add(heading, index)
  dialog.frame.add(row, index + 1)
  const body = new TextRenderable(renderer, { content: "", fg: color.text, wrapMode: "word", selectable: true })
  dialog.form.add(body)
  dialogs.track(dialog, list)
  list.focus()
  return {
    dialog,
    heading,
    list,
    body,
    ...fitting(renderer, row, dialog),
    /** Replaces the right pane and scrolls it back to the top. */
    show(content: TextRenderable["content"] | string) {
      body.content = content
      dialog.form.scrollTo(0)
    },
  }
}

export type Panel = NonNullable<ReturnType<typeof openPanel>>

/** Heading, rows and hints are fitted to the laid-out width, so each repaints when the width changes. */
function fitting(renderer: CliRenderer, row: BoxRenderable, dialog: ModalState) {
  const fits = new Map<string, () => void>()
  // A text box does not report its own resize; the row beside it spans the same inner width and does.
  row.onSizeChange = () => fits.forEach((fit) => fit())
  const panel = {
    /** Columns of the heading line: the laid-out width, or the frame's share of the screen before layout. */
    width: () => (row.width > 1 ? row.width : Math.floor(Math.min(220, renderer.width * 0.98)) - 4),
    /** Runs `paint` now and again whenever the panel's width changes; a later paint of the same name replaces it. */
    fit(name: string, paint: () => void) {
      fits.set(name, paint)
      paint()
    },
    /** Key hints that drop their trailing optional parts, never "Esc close", to fit two whole lines. A live `note` takes the first line and leaves one line of its own `essential` hints. */
    hintText(optional: string[], essential: string[], note?: { text: string; essential: string[] }) {
      // The error line keeps a two-column margin beside the frame's edge.
      const width = panel.width() - 2
      return note?.text ? `${note.text}\n${fitHints(width, [], note.essential)}` : fitHints(width, optional, essential)
    },
    /** Paints `hintText` now and whenever the width changes; `note` is read at each paint. */
    hints(optional: string[], essential: string[], note?: () => { text: string; essential: string[] }) {
      panel.fit("hints", () => (dialog.error.content = panel.hintText(optional, essential, note?.())))
    },
  }
  return panel
}

/** Adds `@path` to the session's reply draft and switches to the reply editor. */
export function mentionInReply(
  panel: Panel,
  dialogs: Dialogs,
  session: Session,
  path: string | undefined,
  drafts: Drafts,
) {
  const text = path && mentionText(path)
  if (!text) return
  // The trailing space ends the mention, so the caret does not land on a live @ token that traps Esc.
  if (!drafts.mention(session, `${text} `)) {
    panel.dialog.error.content = "Your reply draft is full or already sent. Esc close"
    return
  }
  dialogs.close(false)
  drafts.reply()
}
