import { StyledText, fg } from "@opentui/core"
import { matchesKey } from "../keys"
import { display } from "../messages"
import { openPanel } from "../panel"
import { errorText } from "../server"
import { label } from "../state"
import { color } from "../theme"
import { fetchPage, PAGE, TITLES, type Item, type Mode } from "./data"
import { feeds, type IntelContext } from "./feeds"

type Panel = NonNullable<ReturnType<typeof openPanel>>

/** The open Intel panel: which list and page it shows, and the newest request that may fill it. */
type View = { ctx: IntelContext; panel: Panel; mode: Mode; page: number; items: Item[]; request: number }

const keys = "↑↓ choose · m list · [ ] page · f feeds · p poll now · Ctrl+R refresh · Esc close"

export function openIntel(ctx: IntelContext) {
  if (!ctx.dialogs.navigate()) return
  const panel = openPanel(ctx.renderer, ctx.dialogs, "Intel")
  if (!panel) return
  const view: View = { ctx, panel, mode: "advisories", page: 1, items: [], request: 0 }
  panel.list.on("selectionChanged", () => describe(view))
  panel.dialog.key = (key) => {
    const action = matchesKey(key, "r", { ctrl: true })
      ? () => load(view)
      : key.sequence === "m"
        ? () => {
            view.mode = view.mode === "advisories" ? "kev" : view.mode === "kev" ? "news" : "advisories"
            view.page = 1
            return load(view)
          }
        : key.sequence === "]"
          ? () => turn(view, 1)
          : key.sequence === "["
            ? () => turn(view, -1)
            : key.sequence === "p"
              ? () => poll(view)
              : key.sequence === "f"
                ? () => feeds(ctx, () => openIntel(ctx))
                : undefined
    if (!action) return false
    void action()
    return true
  }
  void load(view)
}

async function load(view: View) {
  const { ctx, panel } = view
  const version = ++view.request
  panel.heading.content = `${TITLES[view.mode]} · loading…`
  try {
    const result = await fetchPage(ctx.connection.client["server.intel"], view.mode, view.page)
    if (version !== view.request || ctx.state.modal !== panel.dialog) return
    view.items = result.items
    const pages = Math.max(1, Math.ceil(result.total / PAGE))
    panel.heading.content = `${TITLES[view.mode]} · page ${view.page} of ${pages} · ${result.total} items`
    panel.list.options = view.items.map((item) => ({ name: label(item.title, 80), description: "" }))
    panel.list.setSelectedIndex(0)
    panel.dialog.error.content = keys
    describe(view)
  } catch (error) {
    if (version !== view.request || ctx.state.modal !== panel.dialog) return
    view.items = []
    panel.list.options = []
    panel.show(`${TITLES[view.mode]} unavailable: ${errorText(error)}`)
  }
}

function describe(view: View) {
  const item = view.items[view.panel.list.getSelectedIndex()]
  if (!item) return view.panel.show("Nothing here yet. p polls the feeds now.")
  view.panel.show(
    new StyledText([
      fg(color.text)(`${display(item.title, 1000)}\n`),
      fg(item.tone)(`${item.meta}\n\n`),
      fg(color.text)(item.body),
    ]),
  )
}

async function poll(view: View) {
  const { panel } = view
  panel.dialog.error.content = `Polling feeds…\n${keys}`
  try {
    const result = await view.ctx.connection.client["server.intel"].poll()
    const failed = result.feeds.filter((feed) => feed.lastOk === false).length
    panel.dialog.error.content = `${failed ? `${failed} feed(s) failed.` : "Feeds updated."}\n${keys}`
    await load(view)
  } catch (error) {
    panel.dialog.error.content = `! ${errorText(error)}\n${keys}`
  }
}

function turn(view: View, step: number) {
  view.page = Math.max(1, view.page + step)
  return load(view)
}
