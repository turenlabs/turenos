import type { KeyEvent } from "@opentui/core"
import { matchesKey } from "../keys"
import { openSection, type Picker } from "../picker"
import { label } from "../state"
import { browse } from "./browse"
import { edit } from "./edit"
import type { MemoriesContext, Place } from "./types"

export function openWings(ctx: MemoriesContext, back?: () => void, note = "") {
  const { dialogs, connection } = ctx
  const memories = connection.client.memories
  if (!dialogs.navigate()) return
  return openSection(ctx.renderer, dialogs, ctx.state, { title: ctx.root, back }, memories.wings, (wings, picker) => {
    picker.text.content = `${note ? `${note}\n` : ""}Wings group memories by project or person.`
    picker.fit()
    onKey(picker, (key) => addHint(picker, key.sequence, "Open a wing, then a room, to add a memory there."))
    picker.set([
      ...wings.map((wing) => ({
        name: label(wing.name, 60),
        description: `${label(wing.kind, 32)} · ${label(wing.key, 80)}`,
        run: () => rooms(ctx, { wingID: wing.id, name: wing.name }, () => void openWings(ctx, back)),
      })),
      {
        name: "+ New personal wing",
        description: "For notes that are about you rather than one project",
        run: () => newWing(ctx, back),
      },
    ])
  })
}

/** Asks for the wing's name, then creates it with a General room. */
function newWing(ctx: MemoriesContext, back?: () => void) {
  const memories = ctx.connection.client.memories
  const dialog = ctx.dialogs.open("New personal wing", false, 12)
  if (!dialog) return
  const name = ctx.dialogs.input(dialog, "Name", "Personal")
  name.maxLength = 60
  let done = ""
  dialog.submit = async () => {
    const value = name.value.trim()
    if (!value) throw new Error("Enter a name.")
    const key =
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "personal"
    const wing = await memories.wing({ kind: "person", key, name: value })
    await memories.room({ wingID: wing.id, slug: "general", name: "General" })
    done = `Created wing ${label(value, 60)} with a General room.`
    ctx.say(done)
  }
  dialog.key = (key) => {
    if (!matchesKey(key, "enter")) return false
    void ctx.dialogs.submit()
    return true
  }
  dialog.afterSubmit = () => void openWings(ctx, back, done)
  dialog.back = () => void openWings(ctx, back)
  dialog.error.content = "Enter / Ctrl+S save · Esc back"
  name.focus()
}

function rooms(ctx: MemoriesContext, wing: Place, back: () => void, note = "") {
  return openSection(
    ctx.renderer,
    ctx.dialogs,
    ctx.state,
    { title: `${ctx.root} › ${label(wing.name, 60)}`, back },
    () => ctx.connection.client.memories.rooms({ wingID: wing.wingID }),
    (list, picker) => {
      picker.text.content = `${note ? `${note}\n` : ""}Rooms are topics within the wing.`
      picker.fit()
      const reopen = (done?: string) => void rooms(ctx, wing, back, done)
      onKey(picker, (key) => {
        const room = list[picker.list.getSelectedIndex() - 1]
        if (key.sequence === "a" && room) {
          edit(ctx, { ...wing, roomID: room.id, room: room.name }, undefined, reopen)
          return true
        }
        return addHint(picker, key.sequence, "Select a room to add a memory; All rooms is a read-only view.")
      })
      picker.set([
        { name: "All rooms", run: () => browse(ctx, wing, () => void rooms(ctx, wing, back)) },
        ...list.map((room) => ({
          name: label(room.name, 60),
          description: label(room.slug, 60),
          run: () => browse(ctx, { ...wing, roomID: room.id, room: room.name }, () => void rooms(ctx, wing, back)),
        })),
      ])
    },
  )
}

/** Adds a key handler ahead of the picker's own Enter handling. */
function onKey(picker: Picker, handle: (key: KeyEvent) => boolean) {
  const enter = picker.dialog.key
  picker.dialog.key = (key) => handle(key) || (enter?.(key) ?? false)
}

/** `a` adds a memory in a room; elsewhere it says why nothing happened. */
function addHint(picker: Picker, sequence: string, text: string) {
  if (sequence !== "a") return false
  picker.dialog.error.content = text
  return true
}
