import type { KeyEvent } from "@opentui/core"
import { fitHeading, fitHints, panelWidth } from "../changes/heading"
import { matchesKey, printableKey } from "../keys"
import { openPanel } from "../panel"
import { errorText } from "../server"
import { label } from "../state"
import { details } from "./details"
import { patch, pickField } from "./fields"
import { extensionList } from "./parse"
import { extensionRow } from "./row"
import type { Extension, ExtensionsContext } from "./types"

type Panel = NonNullable<ReturnType<typeof openPanel>>

/** The open Extensions panel, the list it shows, and the filter and last result that shape it. */
type View = {
  ctx: ExtensionsContext
  panel: Panel
  back?: () => void
  all: Extension[]
  items: Extension[]
  select?: string
  filter: string
  /** True while `/` has the keyboard: printable keys edit the filter instead of acting on a row. */
  typing: boolean
  note: string
  /** True while a change is in flight, so a second one cannot be answered out of order. */
  busy: boolean
}

/** `select` is the extension to land on and `note` what the form that returned here just did. */
export function openExtensions(ctx: ExtensionsContext, back?: () => void, select?: string, note = "") {
  if (!ctx.dialogs.navigate()) return
  const root = back ? "Settings › Extensions" : "Extensions"
  const panel = openPanel(ctx.renderer, ctx.dialogs, root)
  if (!panel) return
  const view: View = { ctx, panel, back, all: [], items: [], select, filter: "", typing: false, note, busy: false }
  // Esc clears a filter first by reopening the list without it; the next Esc goes back.
  panel.dialog.back = () => (view.filter ? openExtensions(ctx, back, chosen(view)?.id) : back?.())
  panel.list.on("selectionChanged", () => describe(view))
  panel.dialog.key = (key) => {
    if (view.typing) return typeFilter(view, key)
    const action = actionFor(view, key)
    if (!action) return false
    void action()
    return true
  }
  panel.show("Loading extensions…")
  void load(view)
}

function chosen(view: View) {
  return view.items[view.panel.list.getSelectedIndex()]
}

function actionFor(view: View, key: KeyEvent) {
  const item = chosen(view)
  if (matchesKey(key, "r", { ctrl: true })) return () => load(view)
  if (key.sequence === "/") return () => startFilter(view)
  if (!item) return undefined
  if (matchesKey(key, "enter"))
    return () => update(view, item, { enabled: !item.enabled }, item.enabled ? "Turned off." : "Turned on.")
  if (key.sequence === "s") return () => field(view, "secret")
  if (key.sequence === "c") return () => field(view, "setting")
  if (key.sequence === "o") return () => signIn(view, item)
  return undefined
}

function startFilter(view: View) {
  view.typing = true
  view.note = ""
  show(view, view.all, chosen(view)?.id)
}

function typeFilter(view: View, key: KeyEvent) {
  if (matchesKey(key, "enter")) view.typing = false
  else if (matchesKey(key, "backspace")) view.filter = view.filter.slice(0, -1)
  else if (printableKey(key)) view.filter += printableKey(key)
  else return false
  show(view, view.all, chosen(view)?.id)
  return true
}

function show(view: View, list: Extension[], select?: string) {
  const { ctx, panel } = view
  view.all = list.toSorted((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name))
  const terms = view.filter.toLowerCase().split(/\s+/).filter(Boolean)
  view.items = view.all.filter((item) => terms.every((term) => `${item.name} ${item.id}`.toLowerCase().includes(term)))
  const enabled = view.all.filter((item) => item.enabled).length
  const filter =
    view.typing || view.filter ? `Filter: ${view.filter}${view.typing ? "▏" : ""} · ${view.items.length} shown · ` : ""
  panel.fit(
    "heading",
    () =>
      (panel.heading.content = fitHeading(
        panelWidth(panel),
        `${filter}${enabled} of ${view.all.length} enabled · `,
        label(ctx.directory(), 120),
        "",
        "start",
      )),
  )
  // Rows are cut to the list column, so they are painted again whenever the panel's width changes.
  panel.fit("rows", () => {
    const index = panel.list.getSelectedIndex()
    panel.list.options = view.items.map((item) => ({ name: extensionRow(panel.width(), item), description: "" }))
    panel.list.setSelectedIndex(index)
  })
  panel.list.setSelectedIndex(
    Math.max(
      0,
      view.items.findIndex((item) => item.id === select),
    ),
  )
  hints(view)
  describe(view)
}

/** Offers only the keys the selected extension can use; a note takes the first of the two lines. */
function hints(view: View) {
  const { panel } = view
  const item = chosen(view)
  const contributions = item?.contributions ?? []
  const optional = [
    "↑↓ choose",
    "/ filter",
    ...(contributions.some((entry) => entry.secrets.length) ? ["s secret"] : []),
    ...(contributions.some((entry) => entry.configuration.length) ? ["c setting"] : []),
    ...(contributions.some((entry) => entry.authentication && entry.authentication !== "none") ? ["o sign in"] : []),
    "Ctrl+R refresh",
  ]
  panel.fit(
    "hints",
    () =>
      (panel.dialog.error.content = view.typing
        ? "Type to filter · Backspace edit · Enter keep · Esc clear"
        : view.note
          ? `${view.note}\n${fitHints(panel.width() - 2, [], ["Enter on/off", "/ filter", "Esc back"])}`
          : fitHints(panel.width() - 2, optional, ["Enter on/off", "Esc back"])),
  )
}

function describe(view: View) {
  const item = chosen(view)
  hints(view)
  if (!item)
    return view.panel.show(view.all.length ? "No extension matches the filter." : "No extensions on this server.")
  view.panel.show(details(item))
}

async function load(view: View) {
  const { ctx, panel } = view
  try {
    const result = extensionList(await ctx.connection.api("/extension", { directory: ctx.directory() }))
    if (ctx.state.modal === panel.dialog) show(view, result, chosen(view)?.id ?? view.select)
  } catch (error) {
    if (ctx.state.modal === panel.dialog) panel.show(`Extensions unavailable: ${errorText(error)}`)
  }
}

async function update(view: View, item: Extension, change: Record<string, unknown>, done: string) {
  if (!item.mutable) return note(view, "This extension is managed and cannot change on this server.")
  if (view.busy) return note(view, "Wait for the previous change to finish.")
  view.busy = true
  try {
    const result = extensionList(await patch(view.ctx, item, change, crypto.randomUUID()))
    if (view.ctx.state.modal !== view.panel.dialog) return
    show(view, result, item.id)
    note(view, done)
  } catch (error) {
    note(view, `! ${errorText(error)}`)
  } finally {
    view.busy = false
  }
}

function signIn(view: View, item: Extension) {
  const hasSignIn = item.contributions.some((entry) => entry.authentication && entry.authentication !== "none")
  if (!hasSignIn) return note(view, "This extension has no sign-in.")
  const started = "Sign-in started; the server opens it in a browser on its computer."
  return update(view, item, { enabled: true, connect: true }, item.enabled ? started : `Turned on. ${started}`)
}

function note(view: View, text: string) {
  view.note = text
  hints(view)
}

function field(view: View, kind: "secret" | "setting") {
  const item = chosen(view)
  const fields =
    item?.contributions.flatMap((contribution) =>
      kind === "secret" ? contribution.secrets : contribution.configuration,
    ) ?? []
  if (!item || !fields.length) return note(view, `This extension has no ${kind}s.`)
  const root = view.back ? "Settings › Extensions" : "Extensions"
  pickField(view.ctx, item, fields, kind, (done) => openExtensions(view.ctx, view.back, item.id, done), root)
}
