import { BoxRenderable, SelectRenderable, TextRenderable, type CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import { mentionText } from "./prompt-files"
import type { Session } from "./server"
import { color } from "./theme"

export type Drafts = { mention: (session: Session, text: string) => boolean; reply: () => void }

/**
 * A near-full-screen dialog split into a chooser on the left and the chosen item's content on the
 * right, like the desktop's review and file panels. The content pane is the dialog's own scroll
 * form, so Page Up/Down scroll it while arrows move the chooser.
 */
export function openPanel(renderer: CliRenderer, dialogs: Dialogs, title: string) {
  const dialog = dialogs.open(title, false, 999)
  if (!dialog) return undefined
  dialog.frame.maxWidth = 220
  dialog.frame.maxHeight = undefined
  dialog.frame.width = "98%"
  dialog.frame.height = "96%"
  const heading = new TextRenderable(renderer, {
    content: "",
    fg: color.muted,
    height: 1,
    flexShrink: 0,
    wrapMode: "none",
    truncate: true,
  })
  const row = new BoxRenderable(renderer, { flexDirection: "row", flexGrow: 1, minHeight: 1, gap: 2 })
  const list = new SelectRenderable(renderer, {
    width: "34%",
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
  const body = new TextRenderable(renderer, { content: "", fg: color.text, wrapMode: "none", selectable: true })
  dialog.form.add(body)
  dialogs.track(dialog, list)
  list.focus()
  return {
    dialog,
    heading,
    list,
    body,
    /** Replaces the right pane and scrolls it back to the top. */
    show(content: TextRenderable["content"] | string) {
      body.content = content
      dialog.form.scrollTo(0)
    },
  }
}

export type Panel = NonNullable<ReturnType<typeof openPanel>>

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
