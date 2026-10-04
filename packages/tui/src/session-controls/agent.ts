import { SelectRenderable, TextRenderable } from "@opentui/core"
import type { InputRenderable, KeyEvent } from "@opentui/core"
import { matchesKey } from "../keys"
import { errorText, type Connection, type Session } from "../server"
import { label, type ModalState } from "../state"
import { color } from "../theme"
import { currentSession, openControl, remember, type SessionContext } from "./session"

type Catalog = Awaited<ReturnType<Connection["agents"]>>

type Picker = {
  ctx: SessionContext
  session: Session
  dialog: ModalState
  query: InputRenderable
  select: SelectRenderable
  /** The "Current:" line, filled again once the catalog says which agent a session without one runs. */
  current: TextRenderable
  catalog: Catalog
  matches: Catalog
  loading: boolean
  requested: string | undefined
  acknowledged: boolean
}

export function agent(ctx: SessionContext) {
  const target = openControl(ctx, "Choose session agent")
  if (!target) return
  const { session, dialog } = target
  const current = new TextRenderable(ctx.renderer, { content: "", fg: color.text, wrapMode: "word" })
  dialog.form.add(current)
  const query = ctx.dialogs.input(dialog, "Find an agent", "", "Filter visible primary agents")
  query.maxLength = 256
  const select = agentSelect(ctx)
  dialog.form.add(select)
  ctx.dialogs.track(dialog, select)
  const picker: Picker = {
    ctx,
    session,
    current,
    dialog,
    query,
    select,
    catalog: [],
    matches: [],
    loading: false,
    requested: undefined,
    acknowledged: false,
  }
  dialog.submit = () => submit(picker)
  query.on("input", () => update(picker))
  select.on("itemSelected", () => void ctx.dialogs.submit())
  dialog.key = (key) => pickerKey(picker, key)
  query.focus()
  describeCurrent(picker)
  void load(picker)
}

/** A session that never chose an agent runs the server's default, `build` unless the catalog lacks it. */
function describeCurrent(picker: Picker) {
  const { session, catalog } = picker
  const effective = session.agent ?? (catalog.find((item) => item.id === "build") ?? catalog[0])?.id
  const name = session.agent ?? (effective ? `${effective} (server default)` : "Server default")
  picker.current.content = `Current: ${label(name, 100)}\nApplies to subsequent provider turns, not in-flight work. No reply is sent.`
}

function agentSelect(ctx: SessionContext) {
  return new SelectRenderable(ctx.renderer, {
    height: 7,
    minHeight: 2,
    options: [],
    showDescription: true,
    showScrollIndicator: true,
    showSelectionIndicator: true,
    backgroundColor: color.panel,
    textColor: color.text,
    descriptionColor: color.muted,
    selectedBackgroundColor: color.selected,
    selectedTextColor: color.accent,
  })
}

function pickerKey(picker: Picker, key: KeyEvent) {
  const { ctx, dialog, select } = picker
  if (matchesKey(key, "r", { ctrl: true })) {
    void load(picker)
    return true
  }
  if (matchesKey(key, "up") || matchesKey(key, "down")) {
    if (picker.requested === undefined) {
      if (key.name === "up") select.moveUp()
      else select.moveDown()
      ctx.dialogs.reveal(dialog, select)
    }
    return true
  }
  if (!matchesKey(key, "enter")) return false
  void ctx.dialogs.submit()
  return true
}

function update(picker: Picker) {
  const { session, select, query, dialog } = picker
  if (picker.loading || picker.requested !== undefined) return
  const previous = picker.matches[select.getSelectedIndex()]?.id ?? session.agent
  const terms = query.value.toLowerCase().trim().split(/\s+/).filter(Boolean)
  picker.matches = picker.catalog.filter((item) =>
    terms.every((term) => `${item.id} ${item.description ?? ""}`.toLowerCase().includes(term)),
  )
  select.options = picker.matches.map((item) => ({
    name: `${item.id === session.agent ? "* " : "  "}${label(item.id, 150)}`,
    description: label(item.description ?? "", 500),
  }))
  select.setSelectedIndex(
    Math.max(
      0,
      picker.matches.findIndex((item) => item.id === previous),
    ),
  )
  dialog.error.content = picker.matches.length
    ? "Up/Down choose · Enter / Ctrl+S select\nCtrl+R refresh · Esc close"
    : "No matching visible primary agents.\nCtrl+R retry · Esc close"
}

async function load(picker: Picker) {
  const { ctx, session, select, dialog } = picker
  if (picker.loading || dialog.busy || picker.requested !== undefined) return
  picker.loading = true
  picker.catalog = []
  picker.matches = []
  select.options = []
  dialog.error.content = "Loading agents... No change will be sent.\nEsc close"
  try {
    const result = await ctx.connection.agents(session.location.directory)
    if (ctx.state.closed || ctx.state.modal !== dialog) return
    picker.catalog = result.filter((item) => !item.hidden && item.mode !== "subagent")
    picker.loading = false
    describeCurrent(picker)
    update(picker)
  } catch (error) {
    if (ctx.state.closed || ctx.state.modal !== dialog) return
    dialog.error.height = 4
    dialog.error.content = `Cannot load agents: ${errorText(error)}\nCtrl+R retry · Esc close`
  } finally {
    picker.loading = false
  }
}

async function submit(picker: Picker) {
  const { ctx, session, dialog, select } = picker
  const choice = picker.requested ?? picker.matches[select.getSelectedIndex()]?.id
  if (picker.loading || !choice) throw new Error("Choose a loaded, visible primary agent first.")
  const current = await currentSession(ctx, session)
  if (ctx.state.modal !== dialog) throw new Error("Agent picker is no longer open.")
  if (!picker.acknowledged && current.agent !== choice) {
    // An ambiguous retry keeps the original agent; an acknowledged switch only retries its GET.
    picker.requested = choice
    await ctx.connection.client.sessions.switchAgent({ sessionID: session.id, agent: choice })
    picker.acknowledged = true
  }
  const updated = picker.acknowledged ? await currentSession(ctx, session) : current
  remember(ctx, updated)
  ctx.say(`Agent: ${label(updated.agent ?? "Server default", 100)}. Applies to subsequent turns.`)
}
