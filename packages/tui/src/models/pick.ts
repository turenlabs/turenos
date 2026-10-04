import { SelectRenderable, TextRenderable, type InputRenderable } from "@opentui/core"
import { setRows } from "../dialogs/size"
import { matchesKey } from "../keys"
import type { Connection } from "../server"
import { errorText } from "../server"
import { label } from "../state"
import type { ModalState } from "../state"
import { color } from "../theme"
import { modelIdentity } from "./identity"
import type { ModelsContext, ModelTarget } from "./types"

type Row = { ref: string; name: string; description: string }

/** The picker's open dialog and what it currently shows. */
type View = {
  ctx: ModelsContext
  target: ModelTarget
  dialog: ModalState
  query: InputRenderable
  select: SelectRenderable
  catalog?: Awaited<ReturnType<Connection["providers"]["list"]>>
  matches: Row[]
  loading: boolean
}

export function pick(ctx: ModelsContext, target: ModelTarget) {
  if (ctx.state.closed || !ctx.dialogs.navigate()) return
  const dialog = ctx.dialogs.open("Choose model")
  if (!dialog) return
  dialog.recipient = target.recipient
  const setup = () => {
    if (dialog.busy) return
    ctx.dialogs.close(false)
    ctx.connectProvider(target.directory, () => pick(ctx, target))
  }
  addHeader(ctx, dialog, target, setup)
  const query = ctx.dialogs.input(dialog, "Find a model or provider", "", "Type to filter connected models")
  query.maxLength = 256
  const select = new SelectRenderable(ctx.renderer, {
    flexShrink: 1,
    height: 2,
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
  // The list is the dialog: it sits outside the scrolling header, takes its rows and shrinks with the screen.
  dialog.form.flexShrink = 0
  dialog.frame.add(select, dialog.frame.getChildren().indexOf(dialog.error))
  ctx.dialogs.track(dialog, select)
  const view: View = { ctx, target, dialog, query, select, matches: [], loading: false }
  query.on("input", () => update(view))
  select.on("itemSelected", () => void choose(view))
  dialog.key = (key) => {
    if (matchesKey(key, "f2")) {
      setup()
      return true
    }
    if (matchesKey(key, "r", { ctrl: true })) {
      void load(view)
      return true
    }
    if (matchesKey(key, "up") || matchesKey(key, "down")) {
      if (key.name === "up") select.moveUp()
      if (key.name === "down") select.moveDown()
      ctx.dialogs.reveal(dialog, select)
      return true
    }
    if (!matchesKey(key, "enter")) return false
    void choose(view)
    return true
  }
  // Navigation may leave the picker; only explicit Back reopens the draft.
  dialog.allowNavigation = true
  dialog.back = target.cancel
  query.focus()
  void load(view)
}

function addHeader(ctx: ModelsContext, dialog: ModalState, target: ModelTarget, setup: () => void) {
  const current = target.recipient?.model
    ? modelIdentity(target.recipient.model)
    : label(target.current || "Server default", 150)
  dialog.form.add(
    new TextRenderable(ctx.renderer, {
      content: target.recipient
        ? `For: ${label(target.recipient.title || target.recipient.id, 80)} · from the next turn\nCurrent: ${current}`
        : `For this launch draft. Selecting a model does not send the task.\nCurrent: ${current}`,
      fg: color.muted,
    }),
  )
  dialog.form.add(
    new TextRenderable(ctx.renderer, {
      content: "+ Connect provider / add custom model  F2",
      fg: color.accent,
      onMouseDown: (event) => {
        if (event.button !== 0) return
        event.preventDefault()
        setup()
      },
    }),
  )
}

function update(view: View) {
  const { catalog, query, select, target, dialog } = view
  if (!catalog) return
  const selected = view.matches[select.getSelectedIndex()]?.ref
  const terms = query.value.toLowerCase().trim().split(/\s+/).filter(Boolean)
  const rows = [
    ...(!target.recipient
      ? [{ ref: "", name: "Server default", description: "Let the server select an available model" }]
      : []),
    ...catalog.models.map((model) => ({
      ref: `${model.providerID}/${model.id}`,
      name: `${model.name} (${model.providerName})`,
      description:
        `${model.providerID}/${model.id}` === target.current && target.recipient?.model
          ? modelIdentity(target.recipient.model)
          : `${model.providerID}/${model.id}`,
    })),
  ].filter((model) => terms.every((term) => `${model.name} ${model.description}`.toLowerCase().includes(term)))
  view.matches = rows.slice(0, 100)
  select.options = view.matches.map((model) => ({
    name: `${model.ref === target.current ? "* " : "  "}${label(model.name, 150)}`,
    description: label(model.description, 2048),
  }))
  setRows(select, view.matches.length * 2)
  select.setSelectedIndex(
    Math.max(
      0,
      view.matches.findIndex((model) => model.ref === selected),
    ),
  )
  dialog.error.content = !catalog.models.length
    ? "No connected models. F2 connects a provider.\nCtrl+R refresh catalog · Esc back"
    : !view.matches.length
      ? "No matching models. Change the search or F2 to connect.\nCtrl+R refresh catalog · Esc back"
      : `Up/Down choose · Enter select · Esc back\nF2 connect · Ctrl+R refresh${rows.length > 100 ? " · First 100; narrow search" : ""}`
}

async function load(view: View) {
  const { ctx, dialog } = view
  if (view.loading) return
  view.loading = true
  view.catalog = undefined
  view.matches = []
  view.select.options = []
  dialog.error.content = "Loading models... Esc back"
  try {
    const result = await ctx.connection.providers.list(view.target.directory)
    if (ctx.state.closed || ctx.state.modal !== dialog) return
    view.catalog = result
    update(view)
  } catch (error) {
    if (ctx.state.closed || ctx.state.modal !== dialog) return
    dialog.error.height = 3
    dialog.error.content = `Cannot load models: ${errorText(error)}\nCtrl+R retry · F2 provider setup · Esc back`
  } finally {
    view.loading = false
  }
}

async function choose(view: View) {
  const { ctx, dialog, target } = view
  const model = view.matches[view.select.getSelectedIndex()]
  if (!model || dialog.busy) return
  dialog.busy = true
  dialog.error.content = "Selecting model..."
  try {
    // Only session selection mutates the server. Draft selection is local.
    if (target.recipient) await target.choose(model.ref)
    if (ctx.state.closed || ctx.state.modal !== dialog) return
    dialog.busy = false
    ctx.dialogs.close(false)
    if (!target.recipient) await target.choose(model.ref)
  } catch (error) {
    if (ctx.state.closed || ctx.state.modal !== dialog) return
    dialog.busy = false
    dialog.error.height = 3
    dialog.error.content = `Could not select model: ${errorText(error)}\nEnter retry · Esc back`
  }
}
