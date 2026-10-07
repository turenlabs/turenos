import { BoxRenderable, InputRenderable, SelectRenderable, StyledText, TextRenderable, fg } from "@opentui/core"
import { changeSummary, diffLines, type DiffTone } from "../diff"
import { display } from "../messages"
import { label, sessionTitle } from "../state"
import { color } from "../theme"
import type { RewindAction, RewindEnv, RewindFlow } from "./flow"
import { requireWord } from "../dialogs/fields"
import { hasFiles } from "./session"
import type { ModalState } from "../state"
import type { Session } from "../server"

const tone: Record<DiffTone, string> = {
  added: color.added,
  removed: color.removed,
  meta: color.muted,
  context: color.text,
}

/** Adds the session label, read-only preview and staged-change panes to a fresh dialog. */
export function addPanels(env: RewindEnv, dialog: ModalState, session: Session) {
  dialog.form.add(
    new TextRenderable(env.renderer, {
      content: `For: ${sessionTitle(session.title || session.id, 100)}\nSession: ${label(session.id, 80)}\nDirectory: ${label(session.location.directory, 200)}`,
      fg: color.muted,
      flexShrink: 0,
      wrapMode: "word",
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
  return `${flow.picked ? "Rewind from" : flow.action === "undo" ? "Undo from" : flow.target ? "Redo up to" : "Clear stage after"} prompt:\n${display(text, 4000)}\n\nNo reply is sent now; existing drafts are kept.\nThe next reply commits any remaining undo stage.`
}

/** The warnings that belong to the typed confirmation, shown right above it. */
function consequences(flow: RewindFlow) {
  const running = Object.hasOwn(flow.state.snapshot?.active ?? {}, flow.session.id)
  return [
    ...(running ? ["Confirm stops active work in this session."] : []),
    ...(flow.action === "redo" && hasFiles(flow.session.revert) ? ["Redo restores the staged files now."] : []),
  ]
}

/** Adds the file-mode select (undo only) and the typed confirmation input, then focuses the input. */
export function addConfirmation(flow: RewindFlow) {
  const { renderer, dialog, dialogs, action } = flow
  const notes = consequences(flow)
  const controls = new BoxRenderable(renderer, {
    height: (action === "undo" ? 5 : 2) + notes.length,
    flexShrink: 0,
    flexDirection: "column",
  })
  dialog.frame.add(controls, dialog.frame.getChildren().indexOf(dialog.error))
  const captions: { field: SelectRenderable | InputRenderable; text: TextRenderable; name: string }[] = []
  const caption = (field: SelectRenderable | InputRenderable, name: string) => {
    const text = new TextRenderable(renderer, { content: "", fg: color.muted, height: 1 })
    controls.add(text)
    return { field, text, name }
  }
  if (action === "undo") {
    flow.files = fileMode(flow)
    captions.push(caption(flow.files, "File mode (↑/↓ choose)"))
    controls.add(flow.files)
    dialogs.track(dialog, flow.files)
  }
  notes.forEach((note) =>
    controls.add(new TextRenderable(renderer, { content: note, fg: color.warning, height: 1, truncate: true })),
  )
  flow.confirmation = new InputRenderable(renderer, {
    maxLength: 32,
    width: "100%",
    // The word shows in the empty box, so the field is visible without its colours.
    placeholder: action,
    placeholderColor: color.muted,
    backgroundColor: color.bg,
    focusedBackgroundColor: color.selected,
    textColor: color.text,
  })
  captions.push(caption(flow.confirmation, `Confirmation (type ${action})`))
  controls.add(flow.confirmation)
  dialogs.track(dialog, flow.confirmation)
  // Focus has no other plain-text cue between the mode list and the typed word; the list's own marker is ▶ too.
  const paintFocus = () =>
    captions.forEach((item) => {
      if (!item.text.isDestroyed) item.text.content = `${item.field.focused ? "▶ " : "  "}${item.name}`
    })
  captions.forEach((item) => {
    item.field.on("focused", paintFocus)
    item.field.on("blurred", paintFocus)
  })
  requireWord(dialog, flow.confirmation, action, dialogs.resize)
  dialog.error.content = `Ctrl+S ${action} · Enter does not confirm\n${action === "undo" ? "Tab chooses file mode / confirmation. " : ""}${flow.summary ? "Ctrl+D shows the staged patch · PgUp/PgDn scroll · " : ""}Esc close`
  flow.ready = true
  flow.confirmation.focus()
  paintFocus()
}

/** Each mode says what it does to the files, next to the choice rather than in a warning above the dialog. */
function fileMode(flow: RewindFlow) {
  return new SelectRenderable(flow.renderer, {
    height: 2,
    options: [
      { name: "Conversation only · files stay as they are", description: "" },
      { name: "Conversation + files · restores affected files now", description: "" },
    ],
    showDescription: false,
    showSelectionIndicator: true,
    backgroundColor: color.panel,
    textColor: color.text,
    selectedBackgroundColor: color.selected,
    selectedTextColor: color.accent,
  })
}
