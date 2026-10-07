import { TextRenderable } from "@opentui/core"
import { attachmentSummary, withoutOpenMention } from "../mentions/outside"
import type { ModalState } from "../state"
import { color } from "../theme"
import type { RequestContext } from "./context"
import type { ReplyEditor } from "./reply"

/** A line under the reply editor that lists what the text will attach, flagging paths outside the directory. */
export function showAttachments(ctx: RequestContext, dialog: ModalState, task: ReplyEditor, directory: string) {
  const line = new TextRenderable(ctx.renderer, {
    content: "",
    fg: color.muted,
    height: 1,
    flexShrink: 0,
    truncate: true,
    wrapMode: "none",
    visible: false,
  })
  dialog.frame.add(line, dialog.frame.getChildren().indexOf(dialog.error))
  const refresh = () => {
    const listed = (dialog.mentionRows ?? 0) > 0
    const summary = attachmentSummary(
      listed ? withoutOpenMention(task.plainText, task.cursorOffset) : task.plainText,
      directory,
    )
    line.visible = summary !== undefined
    line.content = summary ?? ""
    line.fg = summary?.includes("OUTSIDE") ? color.warning : color.muted
    ctx.dialogs.resize()
  }
  // The suggestion list opens and closes after the text changes, so its own refresh repaints the line too.
  const repaint = dialog.refresh
  dialog.refresh = () => {
    repaint?.()
    refresh()
  }
  const changed = task.onContentChange
  task.onContentChange = (event) => {
    changed?.(event)
    refresh()
  }
  refresh()
}
