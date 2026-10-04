import { InputRenderable, TextareaRenderable, TextRenderable } from "@opentui/core"
import type { SessionsGoalSetInput } from "@turenlabs/client"
import { matchesKey } from "../keys"
import { display } from "../messages"
import type { Session } from "../server"
import { label, type ModalState } from "../state"
import { color } from "../theme"
import { current, type Action, type Goal, type GoalEnv } from "./context"
import { submitGoal } from "./submit"

/** One open goal confirmation: the captured recipient plus the state its submit retries share. */
export type GoalSubmission = {
  env: GoalEnv
  dialog: ModalState
  session: Session
  base: Goal
  action: Action
  editor?: TextareaRenderable
  typed?: InputRenderable
  starts: boolean
  status: "paused" | "active"
  intent?: SessionsGoalSetInput
  attempted: boolean
  conflict: boolean
}

export function confirm(env: GoalEnv, session: Session, base: Goal, action: Action, back: (session: Session) => void) {
  const dialog = env.dialogs.open(`${action} goal?`, false, 28)
  if (!dialog) return
  dialog.recipient = session
  const starts = action === "Set" || action === "Resume" || (action === "Edit" && base?.status === "active")
  addSummary(env, dialog, session, base, action, starts)
  const input = addInput(env, dialog, base, action)
  dialog.error.content =
    action === "Clear"
      ? "Type clear + Ctrl+S to stop and clear.\nEsc back; Enter does not confirm."
      : `Ctrl+S confirms ${action.toLowerCase()}${starts ? " and starts execution" : ""}.\n${input.editor ? "Enter newline. " : ""}Esc back; nothing changed yet.`
  dialog.back = () => {
    try {
      current(env, session)
      back(session)
    } catch {
      /* Never reopen for a different recipient. */
    }
  }
  dialog.key = (key) => !input.editor && matchesKey(key, "enter")
  const flow: GoalSubmission = {
    env,
    dialog,
    session,
    base,
    action,
    editor: input.editor,
    typed: input.typed,
    starts,
    status: action === "Pause" ? "paused" : "active",
    attempted: false,
    conflict: false,
  }
  dialog.submit = () => submitGoal(flow)
}

function addSummary(env: GoalEnv, dialog: ModalState, session: Session, base: Goal, action: Action, starts: boolean) {
  const warning = starts
    ? "Confirm STARTS execution in this session."
    : action === "Pause" || action === "Clear"
      ? "Confirm STOPS active work in this session."
      : "Confirm edits this stopped goal; no start."
  dialog.frame.add(
    new TextRenderable(env.renderer, {
      content: `${warning}\nOrdinary reply drafts are kept unchanged.${action === "Set" && session.revert ? "\nStarting this goal also COMMITS staged undo." : ""}`,
      height: action === "Set" && session.revert ? 3 : 2,
      flexShrink: 0,
      fg: color.error,
    }),
    0,
  )
  dialog.form.add(
    new TextRenderable(env.renderer, {
      content: `For: ${label(session.title || session.id, 100)}\n${base ? `Goal: ${base.id}\nRevision: ${base.revision} | ${base.status}\n${display(base.objective, 4000)}` : "Create a new active goal."}${action === "Set" ? `\nAgent: ${label(session.agent ?? "server default")}\nModel: ${session.model ? label(`${session.model.providerID}/${session.model.id} (${session.model.variant ?? "default"})`, 200) : "server default"}` : ""}`,
      fg: color.text,
    }),
  )
}

/** Objective editor for Set/Edit, typed "clear" input for Clear, nothing for the rest. */
function addInput(env: GoalEnv, dialog: ModalState, base: Goal, action: Action) {
  let editor: TextareaRenderable | undefined
  let typed: InputRenderable | undefined
  if (action === "Set" || action === "Edit") {
    editor = new TextareaRenderable(env.renderer, {
      height: 4,
      minHeight: 4,
      flexShrink: 0,
      initialValue: action === "Edit" ? base!.objective : "",
      placeholder: "Goal objective (1-4000 characters)",
      backgroundColor: color.bg,
      focusedBackgroundColor: color.selected,
      textColor: color.text,
      wrapMode: "word",
    })
    // Deliberately not dialog.editor: that field opts into Enter-to-send.
    dialog.frame.add(editor, dialog.frame.getChildren().indexOf(dialog.error))
    env.dialogs.track(dialog, editor)
    editor.cursorOffset = editor.plainText.length
    editor.focus()
  } else if (action === "Clear") {
    typed = new InputRenderable(env.renderer, {
      placeholder: "Type clear",
      maxLength: 32,
      flexShrink: 0,
      backgroundColor: color.bg,
      focusedBackgroundColor: color.selected,
      textColor: color.text,
    })
    dialog.frame.add(typed, dialog.frame.getChildren().indexOf(dialog.error))
    env.dialogs.track(dialog, typed)
    typed.focus()
  } else dialog.form.focus()
  return { editor, typed }
}
