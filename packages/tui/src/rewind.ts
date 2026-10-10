import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import { matchesKey } from "./keys"
import type { Connection } from "./server"
import type { DashboardState } from "./state"
import type { Prompt, RewindAction, RewindEnv, RewindFlow, RewindHooks } from "./rewind/flow"
import { load } from "./rewind/inspect"
import { pickPrompt } from "./rewind/pick"
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
  return {
    undo: () => open(env, "undo"),
    redo: () => open(env, "redo"),
    pick: () => {
      const selected = selection(env)
      if (!selected || env.state.closed || !env.dialogs.navigate()) return
      void pickPrompt(env, selected, (picked) => open(env, "undo", { sessionID: selected.id, picked }))
    },
  }
}

function selection(env: RewindEnv) {
  const selected =
    env.state.tab === "sessions"
      ? env.state.snapshot?.sessions.find((session) => session.id === env.state.selected)
      : undefined
  if (!selected) return void env.say("Select a session first.", true)
  if (!env.state.connected) return void env.say("Reconnect before changing this session.", true)
  if (env.hooks.blocked(selected.id))
    return void env.say("Task-owned subagent: use its owning session. Nothing changed.", true)
  return selected
}

/** `pick` is a prompt chosen in the `/rewind` picker; the confirmation that follows is the one `/undo` opens. */
function open(env: RewindEnv, action: RewindAction, pick?: { sessionID: string; picked: Prompt }) {
  const selected = selection(env)
  if (!selected || env.state.closed || !env.dialogs.navigate()) return
  if (pick && pick.sessionID !== selected.id) return env.say("The selected session changed. Nothing changed.", true)
  const dialog = env.dialogs.open(title(action, !!pick), false, 32)
  if (!dialog) return
  const session = structuredClone(selected)
  dialog.recipient = session
  const panels = addPanels(env, dialog, session)
  const flow: RewindFlow = {
    ...env,
    ...panels,
    action,
    picked: pick?.picked,
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
  dialog.error.content = "Loading (read-only) ... Esc close"
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

/** A prompt picked with `/rewind` rewinds to it; `/undo` steps back one turn. */
function title(action: RewindAction, picked: boolean) {
  return picked ? "Rewind conversation?" : action === "undo" ? "Undo conversation?" : "Redo conversation?"
}
