import { SelectRenderable, TextRenderable } from "@opentui/core"
import { matchesKey } from "../keys"
import { errorText, type Session } from "../server"
import { label, type ModalState } from "../state"
import { color } from "../theme"
import type { Target, VariantsContext } from "./types"

/** The open variant picker: what is listed, and the choice once it is frozen for retries. */
type View = {
  ctx: VariantsContext
  target: Target
  recipient?: Session
  dialog: ModalState
  select: SelectRenderable
  rows: (string | undefined)[]
  ready: boolean
  loading: boolean
  intent?: { variant: string | undefined; currentOnly: boolean }
  unadvertised?: string
}

export function show(ctx: VariantsContext, target: Target, recipient?: Session) {
  const { state, dialogs } = ctx
  if (state.closed || !dialogs.navigate()) return
  const opened = dialogs.open("Model variant / effort", false, 20)
  if (!opened) return
  const dialog = opened
  dialog.recipient = recipient
  dialog.back = target.cancel
  addSummary(ctx, dialog, target, recipient)
  const select = new SelectRenderable(ctx.renderer, {
    height: 7,
    minHeight: 2,
    options: [],
    showDescription: false,
    showScrollIndicator: true,
    showSelectionIndicator: true,
    backgroundColor: color.panel,
    textColor: color.text,
    selectedBackgroundColor: color.selected,
    selectedTextColor: color.accent,
  })
  dialog.form.add(select)
  dialogs.track(dialog, select)
  const view: View = { ctx, target, recipient, dialog, select, rows: [], ready: false, loading: false }
  dialog.submit = () => submit(view)
  dialog.key = (key) => {
    if (matchesKey(key, "r", { ctrl: true })) {
      void load(view)
      return true
    }
    if (matchesKey(key, "up") || matchesKey(key, "down")) {
      if (!view.intent) {
        if (key.name === "up") select.moveUp()
        else select.moveDown()
        dialogs.reveal(dialog, select)
      }
      return true
    }
    if (matchesKey(key, "enter")) {
      void dialogs.submit()
      return true
    }
    // Do not let modified navigation fall through to native Select bindings.
    return key.name === "up" || key.name === "down" || key.name === "enter"
  }
  void load(view)
}

function addSummary(ctx: VariantsContext, dialog: ModalState, target: Target, recipient?: Session) {
  const line = (content: string, fg: string) =>
    new TextRenderable(ctx.renderer, {
      content,
      height: 1,
      flexShrink: 0,
      wrapMode: "none",
      truncate: true,
      fg,
    })
  dialog.form.add(
    line(
      recipient ? `For: ${label(recipient.title || recipient.id, 100)}` : "Launch draft only. No task is sent.",
      color.muted,
    ),
  )
  dialog.form.add(line(label(`${target.model.providerID}/${target.model.id}`, 1024), color.text))
  dialog.form.add(
    line(
      recipient
        ? "Applies to subsequent turns. No prompt is sent."
        : "Select an advertised variant or the model default.",
      color.muted,
    ),
  )
}

async function load(view: View) {
  const { ctx, target, dialog, select } = view
  if (view.loading || view.intent) return
  view.loading = true
  view.ready = false
  view.rows = []
  select.options = []
  dialog.error.content = "Loading variants (read-only)... Esc back"
  try {
    const catalog = await ctx.connection.providers.list(target.directory)
    if (ctx.state.closed || ctx.state.modal !== dialog) return
    const model = catalog.models.find(
      (item) => item.providerID === target.model.providerID && item.id === target.model.id,
    )
    if (!model) throw new Error("Model is not available in the connected catalog.")
    view.rows = [undefined, ...(model.variants ?? [])]
    view.unadvertised = target.current !== undefined && !view.rows.includes(target.current) ? target.current : undefined
    if (view.unadvertised !== undefined) view.rows.push(view.unadvertised)
    select.options = view.rows.map((variant) => ({
      name: `${variant === target.current ? "* " : "  "}${variant === undefined ? "Model default" : label(variant, 512)}${variant !== undefined && variant === view.unadvertised ? " (current only)" : ""}`,
      description: "",
    }))
    select.setSelectedIndex(Math.max(0, view.rows.indexOf(target.current)))
    view.ready = true
    dialog.error.content = "Up/Down choose - Enter / Ctrl+S select\nEsc back - Ctrl+R reload"
    select.focus()
  } catch (error) {
    if (ctx.state.closed || ctx.state.modal !== dialog) return
    dialog.error.height = 3
    dialog.error.content = `Cannot load variants: ${errorText(error)}\nCtrl+R retry - Esc back`
  } finally {
    view.loading = false
  }
}

async function submit(view: View) {
  if (!view.ready) throw new Error("Variants are not loaded. Ctrl+R retry or Esc back.")
  if (!view.intent) {
    const variant = view.rows[view.select.getSelectedIndex()]
    view.intent = { variant, currentOnly: variant !== undefined && variant === view.unadvertised }
    if (!view.recipient && view.intent.currentOnly) {
      view.intent = undefined
      throw new Error("This variant is no longer advertised. Choose an available variant or Model default.")
    }
    // Mouse and native Select bindings must not visually change a frozen retry choice either.
    view.select.options = [{ name: label(view.intent.variant ?? "Model default", 512), description: "" }]
    view.select.setSelectedIndex(0)
  }
  await view.target.choose(view.intent.variant, view.intent.currentOnly)
}
