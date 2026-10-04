import { SelectRenderable, TextRenderable } from "@opentui/core"
import { matchesKey } from "../keys"
import { display } from "../messages"
import { errorText, type Session } from "../server"
import { label, type ModalState } from "../state"
import { color } from "../theme"
import { confirm } from "./confirm"
import { current, fresh, type Action, type Goal, type GoalEnv } from "./context"

type OverviewFlow = {
  env: GoalEnv
  dialog: ModalState
  text: TextRenderable
  choices: SelectRenderable
  session: Session
  goal: Goal
  actions: Action[]
  loading: boolean
  ready: boolean
  request: number
}

/** Read-only goal summary with the actions its current status allows. */
export function overview(env: GoalEnv, session: Session) {
  const dialog = env.dialogs.open("Goal", false, 28)
  if (!dialog) return
  dialog.recipient = session
  const text = new TextRenderable(env.renderer, { content: "Loading goal (read-only)...", fg: color.text })
  dialog.form.add(text)
  const choices = new SelectRenderable(env.renderer, {
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
  env.dialogs.track(dialog, choices)
  const flow: OverviewFlow = {
    env,
    dialog,
    text,
    choices,
    session,
    goal: null,
    actions: [],
    loading: false,
    ready: false,
    request: 0,
  }
  dialog.error.content = "Enter chooses action; Esc closes."
  dialog.refresh = () => {
    void refresh(flow)
  }
  dialog.key = (key) => {
    if (matchesKey(key, "r", { ctrl: true })) {
      void refresh(flow)
      return true
    }
    if (!matchesKey(key, "enter")) return false
    choose(flow)
    return true
  }
  choices.focus()
  void refresh(flow)
}

async function refresh(flow: OverviewFlow) {
  const { dialog } = flow
  if (flow.loading || dialog.busy || flow.env.state.modal !== dialog || flow.env.state.closed) return
  flow.loading = true
  const version = ++flow.request
  try {
    const next = await fresh(flow.env, flow.session, dialog)
    if (version !== flow.request || flow.env.state.modal !== dialog) return
    const selected = flow.actions[flow.choices.getSelectedIndex()]
    flow.goal = next.goal
    flow.session = next.remote
    flow.actions =
      !flow.goal || flow.goal.status === "complete"
        ? ["Set", ...(flow.goal ? ["Clear" as const] : [])]
        : ["Edit", flow.goal.status === "active" ? "Pause" : "Resume", "Clear"]
    flow.choices.options = flow.actions.map((name) => ({ name, description: "" }))
    flow.choices.setSelectedIndex(Math.max(0, flow.actions.indexOf(selected!)))
    flow.text.content = overviewText(flow)
    dialog.error.content = "Enter chooses action; Esc closes.\nCtrl+R refresh. Up/Down choose."
    flow.ready = true
  } catch (error) {
    if (flow.env.state.modal !== dialog || flow.env.state.closed) return
    flow.ready = false
    dialog.error.content = `Cannot refresh: ${errorText(error)}\nCtrl+R retry; Esc close.`
  } finally {
    flow.loading = false
  }
}

function overviewText(flow: OverviewFlow) {
  const { goal, session } = flow
  return `For: ${label(session.title || session.id, 100)}\n${goal ? `Status: ${goal.status} | Revision: ${goal.revision}\nTokens: ${goal.tokensUsed} | Time: ${goal.timeUsedSeconds}s\n\n${display(goal.objective, 4000)}` : "No goal. Set requires explicit start confirmation."}\n\nOrdinary reply drafts stay unchanged.${session.revert ? "\nUndo is staged. Starting a new goal also commits it." : ""}${flow.env.blocked(session.id) ? "\nTask-owned session: overview is read-only." : ""}`
}

function choose(flow: OverviewFlow) {
  if (!flow.ready) return
  const action = flow.actions[flow.choices.getSelectedIndex()]
  if (!action) return
  try {
    current(flow.env, flow.session, flow.dialog)
    if (flow.env.blocked(flow.session.id))
      throw new Error("Task-owned session: use its owning session. Nothing changed.")
    flow.env.dialogs.close(false)
    confirm(flow.env, flow.session, flow.goal ? structuredClone(flow.goal) : null, action, (target) =>
      overview(flow.env, target),
    )
  } catch (error) {
    flow.env.say(errorText(error), true)
  }
}
