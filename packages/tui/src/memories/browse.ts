import { StyledText, fg } from "@opentui/core"
import { matchesKey } from "../keys"
import { display } from "../messages"
import { fitHints } from "../changes/heading"
import { openPanel } from "../panel"
import { errorText } from "../server"
import { label } from "../state"
import { color } from "../theme"
import { edit } from "./edit"
import type { MemoriesContext, Memory, Place } from "./types"

type Panel = NonNullable<ReturnType<typeof openPanel>>

/** The open memory list; `armed` is the memory a first Ctrl+D has marked for deletion. */
type View = { ctx: MemoriesContext; panel: Panel; place: Place; items: Memory[]; armed: string; note: string }

/** The hint fits two lines at any width; a note takes the first line and leaves one of hints. */
function hints(view: View, note = "") {
  const { panel } = view
  view.note = note
  panel.fit(
    "hints",
    () =>
      (panel.dialog.error.content = view.note
        ? `${view.note}\n${fitHints(panel.width() - 2, [], ["a add", "E edit", "Ctrl+D delete", "Esc back"])}`
        : fitHints(
            panel.width() - 2,
            ["↑↓ choose", "a add", "E edit", "Ctrl+R refresh"],
            ["Ctrl+D delete", "Esc back"],
          )),
  )
}

/** `note` reports what the form or action that reopened the list just did. */
export function browse(ctx: MemoriesContext, place: Place, back: () => void, note = "") {
  const title = `${ctx.root} › ${label(place.name, 60)}${place.room ? ` › ${label(place.room, 60)}` : ""}`
  const panel = openPanel(ctx.renderer, ctx.dialogs, title)
  if (!panel) return
  panel.dialog.back = back
  const view: View = { ctx, panel, place, items: [], armed: "", note }
  const reopen = (done?: string) => browse(ctx, place, back, done)
  panel.list.on("selectionChanged", () => describe(view))
  panel.dialog.key = (key) => {
    const item = view.items[panel.list.getSelectedIndex()]
    const action = matchesKey(key, "r", { ctrl: true })
      ? () => load(view)
      : matchesKey(key, "d", { ctrl: true })
        ? () => remove(view)
        : key.sequence === "a" && place.roomID
          ? () => edit(ctx, place, undefined, reopen)
          : key.sequence === "a"
            ? () => hints(view, "All rooms is a read-only view; open a room to add a memory.")
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
  try {
    const list = await ctx.connection.client.memories.list({ wingID: place.wingID, roomID: place.roomID })
    if (ctx.state.modal !== panel.dialog) return
    view.items = list
      .filter((item) => !item.supersededBy)
      .toSorted((a, b) => Number(b.timeUpdated) - Number(a.timeUpdated))
    panel.heading.content = `${view.items.length} memor${view.items.length === 1 ? "y" : "ies"}`
    panel.list.options = view.items.map((item) => ({
      name: `[${item.kind}] ${label(item.title, 60)}`,
      description: "",
    }))
    hints(view, view.note)
    describe(view)
  } catch (error) {
    if (ctx.state.modal === panel.dialog) panel.show(`Memories unavailable: ${errorText(error)}`)
  }
}

function describe(view: View) {
  const { panel, place } = view
  view.armed = ""
  const item = view.items[panel.list.getSelectedIndex()]
  if (!item)
    return panel.show(place.roomID ? "No memories here yet. a adds one." : "No memories yet. Open a room to add one.")
  const anchor = [item.anchor.path, item.anchor.symbol].filter(Boolean).join(" · ")
  panel.show(
    new StyledText([
      fg(color.text)(`${display(item.title, 500)}\n`),
      fg(color.muted)(
        `${item.kind} · by ${label(item.provenance.assertedBy, 40)} (${item.provenance.source})${anchor ? ` · ${label(anchor, 200)}` : ""}\n\n`,
      ),
      fg(color.text)(display(item.body, 48000)),
    ]),
  )
}

function remove(view: View) {
  const { panel } = view
  const item = view.items[panel.list.getSelectedIndex()]
  if (!item) return
  if (view.armed !== item.id) {
    view.armed = item.id
    hints(view, `Ctrl+D again deletes "${label(item.title, 40)}".`)
    return
  }
  void view.ctx.connection.client.memories.remove({ drawerID: item.id, wingID: item.wingID }).then(
    () => {
      view.ctx.say(`Deleted "${label(item.title, 40)}".`)
      hints(view, `Deleted "${label(item.title, 40)}".`)
      return load(view)
    },
    (error: unknown) => hints(view, `! ${errorText(error)}`),
  )
}
