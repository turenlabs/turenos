import { BoxRenderable, InputRenderable, SelectRenderable, StyledText, TextRenderable, fg } from "@opentui/core"
import { changeSummary, diffLines, type DiffTone } from "../diff"
import { display } from "../messages"
import { label } from "../state"
import { color } from "../theme"
import type { RewindAction, RewindEnv, RewindFlow } from "./flow"
import { hasFiles } from "./session"
import type { ModalState } from "../state"
import type { Session } from "../server"

const tone: Record<DiffTone, string> = {
  added: color.added,
  removed: color.removed,
  meta: color.muted,
  context: color.text,
}

/** Adds the warning, session label, read-only preview and staged-change panes to a fresh dialog. */
export function addPanels(env: RewindEnv, dialog: ModalState, session: Session, action: RewindAction) {
  dialog.frame.add(
    new TextRenderable(env.renderer, {
      content: `Confirm stops active work in this session.\n${action === "redo" && hasFiles(session.revert) ? "Redo restores staged files NOW." : "File mode restores affected files NOW."}\nNext reply commits any remaining undo stage.`,
      height: 3,
      flexShrink: 0,
      fg: color.error,
      wrapMode: "word",
    }),
    0,
  )
  dialog.form.add(
    new TextRenderable(env.renderer, {
      content: `For: ${label(session.title || session.id, 100)}`,
      fg: color.muted,
      height: 1,
      flexShrink: 0,
      wrapMode: "none",
      truncate: true,
    }),
  )
  const preview = new TextRenderable(env.renderer, {
    content: "Loading session and recent messages (read-only). Nothing has been changed.",
    fg: color.text,
    wrapMode: "word",
  })
  dialog.form.add(preview)
  // Both controls can restore files immediately, so what they would touch is
  // shown before the confirmation rather than behind it.
  const summary = changeSummary(session.revert)
  const changes = new TextRenderable(env.renderer, {
    content: "",
    visible: !!summary,
    fg: color.text,
    wrapMode: "none",
    selectable: true,
  })
  dialog.form.add(changes)
  return { preview, changes, summary }
}

export function renderChanges(flow: RewindFlow) {
  if (!flow.summary || flow.changes.isDestroyed) return
  const lines = flow.expanded ? diffLines(flow.session.revert) : []
  flow.changes.content = new StyledText([
    fg(color.warning)(`Staged file changes: ${flow.summary}\n`),
    fg(color.muted)(`Ctrl+D ${flow.expanded ? "hides" : "shows"} the staged patch\n`),
    ...lines.map((line) => fg(tone[line.tone])(`${line.text}\n`)),
  ])
  flow.changes.height = 2 + lines.length
}

export function previewText(flow: RewindFlow) {
  const text = (flow.target ?? flow.previous)!.text
  return `${flow.action === "undo" ? "Undo from" : flow.target ? "Redo up to" : "Clear stage after"} prompt:\n${display(text, 4000)}\n\nConfirmation stops active work in this captured session first. ${flow.action === "redo" && hasFiles(flow.session.revert) ? "Redo restores staged files NOW (or reapplies the next file boundary)." : "Conversation-only leaves files untouched; conversation + files restores files NOW."}\nThe next reply commits the remaining staged boundary. No reply is sent now; existing drafts are kept.\n\nSession: ${flow.session.id}\nDirectory: ${label(flow.session.location.directory, 200)}`
}

/** Adds the file-mode select (undo only) and the typed confirmation input, then focuses the input. */
export function addConfirmation(flow: RewindFlow) {
  const { renderer, dialog, dialogs, action } = flow
  const controls = new BoxRenderable(renderer, {
    height: action === "undo" ? 4 : 2,
    flexShrink: 0,
    flexDirection: "column",
  })
  dialog.frame.add(controls, dialog.frame.getChildren().indexOf(dialog.error))
  if (action === "undo") {
    flow.files = new SelectRenderable(renderer, {
      height: 2,
      options: [
        { name: "Conversation only", description: "Default: files false; no file changes" },
        { name: "Conversation + files", description: "Restore affected files NOW" },
      ],
      showDescription: false,
      showSelectionIndicator: true,
      backgroundColor: color.panel,
      textColor: color.text,
      selectedBackgroundColor: color.selected,
      selectedTextColor: color.accent,
    })
    controls.add(flow.files)
    dialogs.track(dialog, flow.files)
  }
  controls.add(
    new TextRenderable(renderer, {
      content: `Type ${action} to confirm, then Ctrl+S`,
      fg: color.muted,
      height: 1,
    }),
  )
  flow.confirmation = new InputRenderable(renderer, {
    placeholder: action,
    maxLength: 32,
    width: "100%",
    backgroundColor: color.bg,
    focusedBackgroundColor: color.selected,
    textColor: color.text,
    placeholderColor: color.muted,
  })
  controls.add(flow.confirmation)
  dialogs.track(dialog, flow.confirmation)
  dialog.error.content = `Type ${action} + Ctrl+S confirm; Enter does not confirm\nTab chooses file mode / confirmation.${flow.summary ? " Ctrl+D staged patch." : ""} Esc cancel`
  flow.ready = true
  flow.confirmation.focus()
}
