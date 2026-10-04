import { matchesKey } from "../keys"
import { openPanel } from "../panel"
import { errorText } from "../server"
import { label } from "../state"
import { details } from "./details"
import { patch, pickField } from "./fields"
import { extensionList } from "./parse"
import type { Extension, ExtensionsContext } from "./types"

type Panel = NonNullable<ReturnType<typeof openPanel>>

/** The open Extensions panel and the list it shows. */
type View = { ctx: ExtensionsContext; panel: Panel; back?: () => void; items: Extension[]; select?: string }

const keys = "↑↓ choose · Enter on/off · s secret · c setting · o sign in · Ctrl+R refresh · Esc back"

/** `select` is the extension to land on, so returning from its secrets keeps the cursor. */
export function openExtensions(ctx: ExtensionsContext, back?: () => void, select?: string) {
  if (!ctx.dialogs.navigate()) return
  const panel = openPanel(ctx.renderer, ctx.dialogs, "Extensions")
  if (!panel) return
  panel.dialog.back = back
  const view: View = { ctx, panel, back, items: [], select }
  panel.list.on("selectionChanged", () => describe(view))
  panel.dialog.key = (key) => {
    const item = view.items[panel.list.getSelectedIndex()]
    const action = matchesKey(key, "r", { ctrl: true })
      ? () => load(view)
      : !item
        ? undefined
        : matchesKey(key, "enter")
          ? () => update(view, item, { enabled: !item.enabled }, item.enabled ? "Turned off." : "Turned on.")
          : key.sequence === "s"
            ? () => field(view, "secret")
            : key.sequence === "c"
              ? () => field(view, "setting")
              : key.sequence === "o"
                ? () =>
                    update(
                      view,
                      item,
                      { enabled: true, connect: true },
                      "Sign-in started; the server opens it in a browser on its computer.",
                    )
                : undefined
    if (!action) return false
    void action()
    return true
  }
  panel.show("Loading extensions…")
  void load(view)
}

function show(view: View, list: Extension[], select?: string) {
  const { ctx, panel } = view
  view.items = list.toSorted((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name))
  const enabled = view.items.filter((item) => item.enabled).length
  panel.heading.content = `${enabled} of ${view.items.length} enabled · ${label(ctx.directory(), 120)}`
  panel.list.options = view.items.map((item) => ({
    name: `${item.enabled ? "●" : "○"} ${label(item.name, 40)} · ${item.status}`,
    description: "",
  }))
  panel.list.setSelectedIndex(
    Math.max(
      0,
      view.items.findIndex((item) => item.id === select),
    ),
  )
  panel.dialog.error.content = keys
  describe(view)
}

function describe(view: View) {
  const item = view.items[view.panel.list.getSelectedIndex()]
  if (!item) return view.panel.show("No extensions on this server.")
  view.panel.show(details(item))
}

async function load(view: View) {
  const { ctx, panel } = view
  try {
    const result = extensionList(await ctx.connection.api("/extension", { directory: ctx.directory() }))
    if (ctx.state.modal === panel.dialog)
      show(view, result, view.items[panel.list.getSelectedIndex()]?.id ?? view.select)
  } catch (error) {
    if (ctx.state.modal === panel.dialog) panel.show(`Extensions unavailable: ${errorText(error)}`)
  }
}

async function update(view: View, item: Extension, change: Record<string, unknown>, done: string) {
  if (!item.mutable) return note(view, "This extension is managed and cannot change on this server.")
  try {
    const result = extensionList(await patch(view.ctx, item, change))
    if (view.ctx.state.modal !== view.panel.dialog) return
    show(view, result, item.id)
    note(view, done)
  } catch (error) {
    note(view, `! ${errorText(error)}`)
  }
}

function note(view: View, text: string) {
  view.panel.dialog.error.content = `${text}\n${keys}`
}

function field(view: View, kind: "secret" | "setting") {
  const item = view.items[view.panel.list.getSelectedIndex()]
  const fields =
    item?.contributions.flatMap((contribution) =>
      kind === "secret" ? contribution.secrets : contribution.configuration,
    ) ?? []
  if (!item || !fields.length) return note(view, `This extension has no ${kind}s.`)
  pickField(view.ctx, item, fields, kind, () => openExtensions(view.ctx, view.back, item.id))
}
