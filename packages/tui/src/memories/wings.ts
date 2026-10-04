import type { KeyEvent } from "@opentui/core"
import { openSection, type Picker } from "../picker"
import { label } from "../state"
import { browse } from "./browse"
import { edit } from "./edit"
import type { MemoriesContext, Place } from "./types"

export function openWings(ctx: MemoriesContext, back?: () => void) {
  const { dialogs, connection } = ctx
  const memories = connection.client.memories
  if (!dialogs.navigate()) return
  return openSection(ctx.renderer, dialogs, ctx.state, { title: "Memories", back }, memories.wings, (wings, picker) => {
    picker.text.content = "Wings group memories by project or person."
    onKey(picker, (key) => addHint(picker, key.sequence, "Open a wing, then a room, to add a memory there."))
    picker.set([
      ...wings.map((wing) => ({
        name: label(wing.name, 60),
        description: `${wing.kind} · ${label(wing.key, 80)}`,
        run: () => rooms(ctx, { wingID: wing.id, name: wing.name }, () => void openWings(ctx, back)),
      })),
      {
        name: "+ New personal wing",
        description: "For notes that are about you rather than one project",
        run: async () => {
          const wing = await memories.wing({ kind: "person", key: "personal", name: "Personal" })
          await memories.room({ wingID: wing.id, slug: "general", name: "General" })
          await openWings(ctx, back)
        },
      },
    ])
  })
}

function rooms(ctx: MemoriesContext, wing: Place, back: () => void) {
  return openSection(
    ctx.renderer,
    ctx.dialogs,
    ctx.state,
    { title: label(wing.name, 60), back },
    () => ctx.connection.client.memories.rooms({ wingID: wing.wingID }),
    (list, picker) => {
      picker.text.content = "Rooms are topics within the wing."
      const reopen = () => void rooms(ctx, wing, back)
      onKey(picker, (key) => {
        const room = list[picker.list.getSelectedIndex() - 1]
        if (key.sequence === "a" && room) {
          edit(ctx, { ...wing, roomID: room.id, name: `${wing.name} · ${room.name}` }, undefined, reopen)
          return true
        }
        return addHint(picker, key.sequence, "Select a room to add a memory; All rooms is a read-only view.")
      })
      picker.set([
        { name: "All rooms", run: () => browse(ctx, wing, () => void rooms(ctx, wing, back)) },
        ...list.map((room) => ({
          name: label(room.name, 60),
          description: room.slug,
          run: () =>
            browse(
              ctx,
              { ...wing, roomID: room.id, name: `${wing.name} · ${room.name}` },
              () => void rooms(ctx, wing, back),
            ),
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
