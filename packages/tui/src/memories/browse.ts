import { StyledText, fg } from "@opentui/core"
import { matchesKey } from "../keys"
import { display } from "../messages"
import { openPanel } from "../panel"
import { errorText } from "../server"
import { label } from "../state"
import { color } from "../theme"
import { edit } from "./edit"
import type { MemoriesContext, Memory, Place } from "./types"

type Panel = NonNullable<ReturnType<typeof openPanel>>

/** The open memory list; `armed` is the memory a first Ctrl+D has marked for deletion. */
type View = { ctx: MemoriesContext; panel: Panel; place: Place; items: Memory[]; armed: string }

const keys = "↑↓ choose · a add · E edit · Ctrl+D delete · Ctrl+R refresh · Esc back"

export function browse(ctx: MemoriesContext, place: Place, back: () => void) {
  const panel = openPanel(ctx.renderer, ctx.dialogs, `Memories · ${label(place.name, 60)}`)
  if (!panel) return
  panel.dialog.back = back
  const view: View = { ctx, panel, place, items: [], armed: "" }
  const reopen = () => browse(ctx, place, back)
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
            ? () =>
                void (panel.dialog.error.content = `All rooms is a read-only view; open a room to add a memory.\n${keys}`)
            : key.sequence === "E" && item
              ? () => edit(ctx, place, item, reopen)
              : undefined
    if (!action) return false
    void action()
    return true
  }
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
    panel.dialog.error.content = keys
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
    panel.dialog.error.content = `Ctrl+D again deletes "${label(item.title, 40)}".\n${keys}`
    return
  }
  void view.ctx.connection.client.memories.remove({ drawerID: item.id, wingID: item.wingID }).then(
    () => load(view),
    (error: unknown) => (panel.dialog.error.content = `! ${errorText(error)}\n${keys}`),
  )
}
