import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import { matchesKey } from "./keys"
import type { Connection } from "./server"
import type { DashboardState } from "./state"
import type { RewindAction, RewindEnv, RewindFlow, RewindHooks } from "./rewind/flow"
import { load } from "./rewind/inspect"
import { boundary } from "./rewind/session"
import { submit } from "./rewind/submit"
import { addPanels, renderChanges } from "./rewind/view"

export function createRewindControls(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
  hooks: RewindHooks,
) {
  const env: RewindEnv = { renderer, state, connection, dialogs, say, hooks }
  return { undo: () => open(env, "undo"), redo: () => open(env, "redo") }
}

function open(env: RewindEnv, action: RewindAction) {
  const selected =
    env.state.tab === "sessions"
      ? env.state.snapshot?.sessions.find((session) => session.id === env.state.selected)
      : undefined
  if (!selected) return env.say("Select a session first.", true)
  if (!env.state.connected) return env.say("Reconnect before changing this session.", true)
  if (env.hooks.blocked(selected.id))
    return env.say("Task-owned subagent: use its owning session. Nothing changed.", true)
  if (env.state.closed || !env.dialogs.navigate()) return
  const dialog = env.dialogs.open(action === "undo" ? "Undo conversation?" : "Redo conversation?", false, 32)
  if (!dialog) return
  const session = structuredClone(selected)
  dialog.recipient = session
  const panels = addPanels(env, dialog, session, action)
  const flow: RewindFlow = {
    ...env,
    ...panels,
    action,
    dialog,
    session,
    initialBoundary: boundary(session.revert),
    expanded: false,
    ready: false,
    loading: false,
    attempted: false,
    acknowledged: undefined,
    hasAcknowledgement: false,
  }
  renderChanges(flow)
  dialog.error.content = "Loading (read-only) ... Esc cancel"
  dialog.submit = () => submit(flow)
  dialog.key = (key) => {
    if (matchesKey(key, "enter")) return true
    if (matchesKey(key, "d", { ctrl: true }) && flow.summary) {
      flow.expanded = !flow.expanded
      renderChanges(flow)
      env.dialogs.resize()
      return true
    }
    if (matchesKey(key, "r", { ctrl: true }) && !flow.attempted) {
      void load(flow)
      return true
    }
    return false
  }
  dialog.form.focus()
  void load(flow)
}
