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

/** Adds the warning, session label, read-only preview and staged-change panes to a fresh dialog. */
export function addPanels(env: RewindEnv, dialog: ModalState, session: Session, action: RewindAction) {
  const running = Object.hasOwn(env.state.snapshot?.active ?? {}, session.id)
  const warning = [
    ...(running ? ["Confirm stops active work in this session."] : []),
    ...(action === "undo"
      ? ["File mode restores affected files NOW."]
      : hasFiles(session.revert)
        ? ["Redo restores staged files NOW."]
        : []),
    "The next reply commits any remaining undo stage.",
  ]
  dialog.frame.add(
    new TextRenderable(env.renderer, {
      content: warning.join("\n"),
      height: warning.length,
      flexShrink: 0,
      fg: color.error,
      wrapMode: "word",
    }),
    0,
  )
  dialog.form.add(
    new TextRenderable(env.renderer, {
      content: `For: ${sessionTitle(session.title || session.id, 100)}`,
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
  return `${flow.action === "undo" ? "Undo from" : flow.target ? "Redo up to" : "Clear stage after"} prompt:\n${display(text, 4000)}\n\nNo reply is sent now; existing drafts are kept.\n\nSession: ${flow.session.id}\nDirectory: ${label(flow.session.location.directory, 200)}`
}

/** Adds the file-mode select (undo only) and the typed confirmation input, then focuses the input. */
export function addConfirmation(flow: RewindFlow) {
  const { renderer, dialog, dialogs, action } = flow
  const controls = new BoxRenderable(renderer, {
    height: action === "undo" ? 5 : 2,
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
    const label = caption(flow.files, "File mode (↑/↓ choose)")
    controls.add(flow.files)
    captions.push(label)
    dialogs.track(dialog, flow.files)
  }
  flow.confirmation = new InputRenderable(renderer, {
    maxLength: 32,
    width: "100%",
    backgroundColor: color.bg,
    focusedBackgroundColor: color.selected,
    textColor: color.text,
  })
  captions.push(caption(flow.confirmation, `Confirmation (type ${action})`))
  controls.add(flow.confirmation)
  dialogs.track(dialog, flow.confirmation)
  // Focus has no other plain-text cue between the mode list and the typed word.
  const paintFocus = () =>
    captions.forEach((item) => {
      if (!item.text.isDestroyed) item.text.content = `${item.field.focused ? "» " : "  "}${item.name}`
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
