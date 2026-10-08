import { StyledText, fg } from "@opentui/core"
import { matchesKey } from "../keys"
import { display } from "../messages"
import { openPanel } from "../panel"
import { errorText } from "../server"
import { fillRows } from "../settings/column"
import { label } from "../state"
import { color } from "../theme"
import { edit } from "./edit"
import type { MemoriesContext, Memory, Place } from "./types"

type Panel = NonNullable<ReturnType<typeof openPanel>>

/**
 * The open memory list; `armed` is the memory a first Ctrl+D has marked for deletion until `until`,
 * `deleting` is set while that request is in flight, and `loads` numbers list requests so only the latest paints.
 */
type View = {
  ctx: MemoriesContext
  panel: Panel
  place: Place
  items: Memory[]
  armed?: { id: string; until: number }
  deleting: boolean
  loads: number
  note: string
}

/** The hint fits two lines at any width; a note takes the first line and leaves one of hints. */
function hints(view: View, note = "") {
  const { panel } = view
  view.note = note
  // `a` adds only inside a room; the All rooms list offers edit and delete but no add.
  const add = view.place.roomID ? ["a add"] : []
  panel.hints(["↑↓ choose", ...add, "E edit", "Ctrl+R refresh"], ["Ctrl+D delete", "Esc back"], () => ({
    text: view.note,
    essential: [...add, "E edit", "Ctrl+D delete", "Esc back"],
  }))
}

/** `note` reports what the form or action that reopened the list just did. */
export function browse(ctx: MemoriesContext, place: Place, back: () => void, note = "") {
  const title = `${ctx.root} › ${label(place.name, 60)}${place.room ? ` › ${label(place.room, 60)}` : ""}`
  const panel = openPanel(ctx.renderer, ctx.dialogs, title)
  if (!panel) return
  // The scroll bar takes the column after the text; a stale layout can wrap the body one column too wide under it.
  panel.body.marginRight = 1
  panel.dialog.back = back
  const view: View = { ctx, panel, place, items: [], deleting: false, loads: 0, note }
  const reopen = (done?: string) => browse(ctx, place, back, done)
  panel.list.on("selectionChanged", () => describe(view))
  panel.dialog.key = (key) => {
    const item = view.items[panel.list.getSelectedIndex()]
    const action = matchesKey(key, "r", { ctrl: true })
      ? () => load(view)
      : matchesKey(key, "d", { ctrl: true })
        ? () => remove(view, key.eventType === "repeat")
        : key.sequence === "a" && place.roomID
          ? () => edit(ctx, place, undefined, reopen)
          : key.sequence === "a"
            ? () => hints(view, "A memory is added inside a room: press Esc, open a room, then press a.")
            : key.sequence === "E" && item
              ? () => edit(ctx, place, item, reopen)
              : undefined
    if (!action) return false
    void action()
    return true
  }
  hints(view, note)
  void load(view)
}

async function load(view: View) {
  const { ctx, panel, place } = view
  const request = ++view.loads
  try {
    const list = await ctx.connection.client.memories.list({ wingID: place.wingID, roomID: place.roomID })
    if (ctx.state.modal !== panel.dialog || request !== view.loads) return
    view.items = list
      .filter((item) => !item.supersededBy)
      .toSorted((a, b) => Number(b.timeUpdated) - Number(a.timeUpdated))
    panel.heading.content = `${view.items.length} memor${view.items.length === 1 ? "y" : "ies"}`
    // Sized like the other Settings dialogs: as tall as the list needs, not the whole terminal.
    panel.dialog.frame.height = Math.max(18, view.items.length + 10)
    fillRows(panel, (chars) => view.items.map((item) => label(`[${item.kind}] ${item.title}`, chars)))
    hints(view, view.note)
    describe(view)
  } catch (error) {
    if (ctx.state.modal === panel.dialog) panel.show(`Memories unavailable: ${errorText(error)}`)
  }
}

function describe(view: View) {
  const { panel, place } = view
  view.armed = undefined
  const item = view.items[panel.list.getSelectedIndex()]
  if (!item)
    return panel.show(place.roomID ? "No memories here yet. a adds one." : "No memories yet. Open a room to add one.")
  const anchor = [item.anchor.path, item.anchor.symbol].filter(Boolean).join(" · ")
  panel.show(
    new StyledText([
      // The list row already shows a title that fits, so the pane repeats it only when the row cut it.
      ...(panel.list.options[panel.list.getSelectedIndex()]?.name === `[${item.kind}] ${display(item.title, 500)}`
        ? []
        : [fg(color.text)(`${display(item.title, 500)}\n`)]),
      fg(color.muted)(
        `Recorded by ${label(item.provenance.assertedBy, 40)} (${label(item.provenance.source, 40)})${anchor ? ` · ${label(anchor, 200)}` : ""}\n\n`,
      ),
      fg(color.text)(display(item.body, 48000)),
    ]),
  )
}

function remove(view: View, repeat: boolean) {
  const { panel } = view
  const item = view.items[panel.list.getSelectedIndex()]
  // Key auto-repeat is not a second press, and a delete in flight is not sent again.
  if (!item || repeat || view.deleting) return
  if (view.armed?.id !== item.id || view.armed.until < Date.now()) {
    view.armed = { id: item.id, until: Date.now() + 2500 }
    hints(view, `Ctrl+D again deletes "${label(item.title, 40)}".`)
    return
  }
  view.armed = undefined
  view.deleting = true
  void view.ctx.connection.client.memories
    .remove({ drawerID: item.id, wingID: item.wingID })
    .then(
      () => {
        view.ctx.say(`Deleted "${label(item.title, 40)}".`)
        hints(view, `Deleted "${label(item.title, 40)}".`)
        return load(view)
      },
      (error: unknown) => hints(view, `! ${errorText(error)}`),
    )
    .finally(() => (view.deleting = false))
}
