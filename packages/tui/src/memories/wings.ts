import { openSection } from "../picker"
import { label } from "../state"
import { browse } from "./browse"
import type { MemoriesContext, Place } from "./types"

export function openWings(ctx: MemoriesContext, back?: () => void) {
  const { dialogs, connection } = ctx
  const memories = connection.client.memories
  if (!dialogs.navigate()) return
  return openSection(ctx.renderer, dialogs, ctx.state, { title: "Memories", back }, memories.wings, (wings, picker) => {
    picker.text.content = "Wings group memories by project or person."
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
