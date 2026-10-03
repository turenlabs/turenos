import { InputRenderable, SelectRenderable, TextareaRenderable, TextRenderable, type CliRenderer } from "@opentui/core"
import type { SessionsGoalGetOutput, SessionsGoalSetInput } from "@turenlabs/client"
import type { Dialogs } from "./dialogs"
import { matchesKey } from "./keys"
import { display } from "./messages"
import { errorText, type Connection, type Session } from "./server"
import { label, type DashboardState, type ModalState } from "./state"
import { color } from "./theme"

type Goal = SessionsGoalGetOutput
type Action = "Set" | "Edit" | "Pause" | "Resume" | "Clear"

export function createGoalControls(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
  blocked: (id: string) => boolean,
) {
  function current(session: Session, dialog?: ModalState) {
    const selected = state.snapshot?.sessions.find((item) => item.id === state.selected)
    if (state.closed || state.tab !== "sessions" || !selected || !sameSession(session, selected))
      throw new Error("Session target changed. Close and reopen Goal.")
    if (dialog && state.modal !== dialog) throw new Error("Goal control is no longer open.")
    if (!state.connected) throw new Error("Reconnect before using Goal.")
  }

  async function fresh(session: Session, dialog: ModalState) {
    current(session, dialog)
    const remote = await connection.client.sessions.get({ sessionID: session.id })
    current(session, dialog)
    if (!sameSession(session, remote)) throw new Error("Session identity changed. Close and reopen Goal.")
    const goal = await connection.client.sessions.goalGet({ sessionID: session.id })
    current(session, dialog)
    return { goal, remote }
  }

  function overview(session: Session) {
    const opened = dialogs.open("Goal", false, 28)
    if (!opened) return
    const dialog = opened
    dialog.recipient = session
    const text = new TextRenderable(renderer, { content: "Loading goal (read-only)...", fg: color.text })
    dialog.form.add(text)
    const choices = new SelectRenderable(renderer, {
      height: 3,
      flexShrink: 0,
      options: [],
      showDescription: false,
      showSelectionIndicator: true,
      backgroundColor: color.panel,
      textColor: color.text,
      selectedBackgroundColor: color.selected,
      selectedTextColor: color.accent,
    })
    dialog.frame.add(choices, dialog.frame.getChildren().indexOf(dialog.error))
    dialogs.track(dialog, choices)
    let goal: Goal = null
    let actions: Action[] = []
    let loading = false
    let ready = false
    let request = 0
    dialog.error.content = "Read-only. Enter chooses action; Esc closes."
    async function refresh() {
      if (loading || dialog.busy || state.modal !== dialog || state.closed) return
      loading = true
      const version = ++request
      try {
        const next = await fresh(session, dialog)
        if (version !== request || state.modal !== dialog) return
        const selected = actions[choices.getSelectedIndex()]
        goal = next.goal
        session = next.remote
        actions =
          !goal || goal.status === "complete"
            ? ["Set", ...(goal ? ["Clear" as const] : [])]
            : ["Edit", goal.status === "active" ? "Pause" : "Resume", "Clear"]
        choices.options = actions.map((name) => ({ name, description: "" }))
        choices.setSelectedIndex(Math.max(0, actions.indexOf(selected!)))
        text.content = `For: ${label(session.title || session.id, 100)}\n${goal ? `Status: ${goal.status} | Revision: ${goal.revision}\nTokens: ${goal.tokensUsed} | Time: ${goal.timeUsedSeconds}s\n\n${display(goal.objective, 4000)}` : "No goal. Set requires explicit start confirmation."}\n\nOrdinary reply drafts stay unchanged.${session.revert ? "\nUndo is staged. Starting a new goal also commits it." : ""}${blocked(session.id) ? "\nTask-owned session: overview is read-only." : ""}`
        dialog.error.content = "Read-only. Enter chooses action; Esc closes.\nCtrl+R refresh. Up/Down choose."
        ready = true
      } catch (error) {
        if (state.modal !== dialog || state.closed) return
        ready = false
        dialog.error.content = `Cannot refresh: ${errorText(error)}\nCtrl+R retry; Esc close.`
      } finally {
        loading = false
      }
    }
    dialog.refresh = () => {
      void refresh()
    }
    dialog.key = (key) => {
      if (matchesKey(key, "r", { ctrl: true })) {
        void refresh()
        return true
      }
      if (!matchesKey(key, "enter")) return false
      if (!ready) return true
      const action = actions[choices.getSelectedIndex()]
      if (!action) return true
      try {
        current(session, dialog)
        if (blocked(session.id)) throw new Error("Task-owned session: use its owning session. Nothing changed.")
        dialogs.close(false)
        confirm(session, goal ? structuredClone(goal) : null, action)
      } catch (error) {
        say(errorText(error), true)
      }
      return true
    }
    choices.focus()
    void refresh()
  }

  function confirm(session: Session, base: Goal, action: Action) {
    const opened = dialogs.open(`${action} goal?`, false, 28)
    if (!opened) return
    const dialog = opened
    dialog.recipient = session
    const starts = action === "Set" || action === "Resume" || (action === "Edit" && base?.status === "active")
    const warning = starts
      ? "Confirm STARTS execution in this session."
      : action === "Pause" || action === "Clear"
        ? "Confirm STOPS active work in this session."
        : "Confirm edits this stopped goal; no start."
    dialog.frame.add(
      new TextRenderable(renderer, {
        content: `${warning}\nOrdinary reply drafts are kept unchanged.${action === "Set" && session.revert ? "\nStarting this goal also COMMITS staged undo." : ""}`,
        height: action === "Set" && session.revert ? 3 : 2,
        flexShrink: 0,
        fg: color.error,
      }),
      0,
    )
    dialog.form.add(
      new TextRenderable(renderer, {
        content: `For: ${label(session.title || session.id, 100)}\n${base ? `Goal: ${base.id}\nRevision: ${base.revision} | ${base.status}\n${display(base.objective, 4000)}` : "Create a new active goal."}${action === "Set" ? `\nAgent: ${label(session.agent ?? "server default")}\nModel: ${session.model ? label(`${session.model.providerID}/${session.model.id} (${session.model.variant ?? "default"})`, 200) : "server default"}` : ""}`,
        fg: color.text,
      }),
    )
    let editor: TextareaRenderable | undefined
    let typed: InputRenderable | undefined
    if (action === "Set" || action === "Edit") {
      editor = new TextareaRenderable(renderer, {
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
      dialogs.track(dialog, editor)
      editor.focus()
    } else if (action === "Clear") {
      typed = new InputRenderable(renderer, {
        placeholder: "Type clear",
        maxLength: 32,
        flexShrink: 0,
        backgroundColor: color.bg,
        focusedBackgroundColor: color.selected,
        textColor: color.text,
      })
      dialog.frame.add(typed, dialog.frame.getChildren().indexOf(dialog.error))
      dialogs.track(dialog, typed)
      typed.focus()
    } else dialog.form.focus()
    dialog.error.content =
      action === "Clear"
        ? "Type clear + Ctrl+S to stop and clear.\nEsc back; Enter does not confirm."
        : `Ctrl+S confirms ${action.toLowerCase()}${starts ? " and starts execution" : ""}.\n${editor ? "Enter newline. " : ""}Esc back; nothing changed yet.`
    dialog.back = () => {
      try {
        current(session)
        overview(session)
      } catch {
        /* Never reopen for a different recipient. */
      }
    }
    dialog.key = (key) => !editor && matchesKey(key, "enter")
    let intent: SessionsGoalSetInput | undefined
    let attempted = false
    let conflict = false
    const status = action === "Pause" ? "paused" : "active"
    dialog.submit = async () => {
      current(session, dialog)
      if (blocked(session.id)) throw new Error("Task-owned session: use its owning session. Nothing changed.")
      if (typed && typed.value !== "clear") throw new Error("Type clear exactly, then Ctrl+S.")
      const objective = editor ? editor.plainText.trim() : (base?.objective ?? "")
      if (editor && (!objective || objective.length > 4000))
        throw new Error("Objective must contain 1-4000 characters.")
      if (intent && objective !== intent.objective)
        throw new Error("Retry keeps the original objective. Esc and reopen to change it.")
      intent ??= {
        sessionID: session.id,
        id: `goal_${crypto.randomUUID().replaceAll("-", "")}`,
        messageID: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
        objective,
        agent: session.agent,
        model: session.model ? structuredClone(session.model) : undefined,
      }
      const { goal: next, remote } = await fresh(session, dialog)
      if (blocked(session.id)) throw new Error("Task-owned session: use its owning session. Nothing changed.")
      const desired = (value: Goal) =>
        value !== null &&
        value.sessionID === session.id &&
        value.id === (action === "Set" ? intent!.id : base!.id) &&
        value.objective === (action === "Set" || action === "Edit" ? intent!.objective : base!.objective) &&
        value.status === (action === "Edit" ? base!.status : action === "Set" ? "active" : status) &&
        value.revision >= (action === "Set" ? 1 : base!.revision)
      const matches =
        action === "Clear"
          ? next === null
          : desired(next) &&
            (action === "Set" ||
              next!.revision === base!.revision + 1 ||
              (action === "Edit" && intent.objective === base!.objective && next!.revision === base!.revision))
      if (attempted && matches) {
        say("Desired goal state observed. Ordinary reply drafts are unchanged.")
        return
      }
      if (session.revert?.messageID !== remote.revert?.messageID)
        throw new Error("Undo boundary changed. No write sent; close and reopen Goal.")
      if (conflict || !sameGoal(base, next)) {
        conflict = true
        throw new Error("Goal revision changed. No overwrite; Esc to inspect and confirm again.")
      }
      if (attempted && action !== "Set")
        throw new Error("Outcome unconfirmed. Retry checks GET only; Esc to inspect. No write repeated.")
      attempted = true
      try {
        let acknowledged: Goal = null
        if (action === "Set") acknowledged = await connection.client.sessions.goalSet(intent)
        else {
          const guard = { sessionID: session.id, goalID: base!.id, expectedRevision: base!.revision }
          if (action === "Edit")
            acknowledged = await connection.client.sessions.goalEdit({ ...guard, objective: intent.objective })
          else if (action === "Clear") await connection.client.sessions.goalClear(guard)
          else acknowledged = await connection.client.sessions.goalStatus({ ...guard, status })
        }
        if (action !== "Clear" && !desired(acknowledged))
          throw new Error("Returned goal does not match the confirmed intent")
      } catch (error) {
        throw new Error(
          `Outcome unconfirmed: ${errorText(error)}. ${action === "Set" ? "Retry preserves the original goal/message IDs and objective." : "Retry checks GET only; no write repeated."}`,
        )
      }
      say(
        `Goal ${action.toLowerCase()} acknowledged. ${starts ? "Execution requested." : action === "Pause" || action === "Clear" ? "Active work stopped." : "Objective updated."} Reply drafts unchanged.`,
      )
    }
  }

  return {
    open() {
      const selected =
        state.tab === "sessions" ? state.snapshot?.sessions.find((item) => item.id === state.selected) : undefined
      if (!selected) return say("Select a created session first.", true)
      if (state.closed || !dialogs.navigate()) return
      if (!state.connected) return say("Reconnect before opening Goal.", true)
      overview(structuredClone(selected))
    },
  }
}

function sameGoal(left: Goal, right: Goal) {
  return left === null ? right === null : right !== null && left.id === right.id && left.revision === right.revision
}

function sameSession(left: Session, right: Session) {
  return (
    left.id === right.id &&
    left.projectID === right.projectID &&
    left.parentID === right.parentID &&
    left.subpath === right.subpath &&
    left.time.created === right.time.created &&
    left.location.directory === right.location.directory &&
    left.location.workspaceID === right.location.workspaceID
  )
}
