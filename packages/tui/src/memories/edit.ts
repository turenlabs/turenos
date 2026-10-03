import { KINDS, type MemoriesContext, type Memory, type Place } from "./types"

/** The memory form; saving or leaving returns to the list through `reopen`. */
export function edit(ctx: MemoriesContext, place: Place, item: Memory | undefined, reopen: () => void) {
  const { dialogs } = ctx
  const memories = ctx.connection.client.memories
  dialogs.close(false)
  const dialog = dialogs.open(item ? "Edit memory" : "New memory", false, 30)
  if (!dialog) return
  const kind = dialogs.input(dialog, `Kind: ${KINDS.join(", ")}`, item?.kind ?? "note")
  const title = dialogs.input(dialog, "Title", item?.title ?? "")
  const body = dialogs.prompt(dialog, "Body (Shift+Enter adds a line)", item?.body ?? "")
  dialog.submit = async () => {
    const value = kind.value.trim() as (typeof KINDS)[number]
    if (!KINDS.includes(value)) throw new Error(`Kind must be one of: ${KINDS.join(", ")}.`)
    if (!title.value.trim() || !body.plainText.trim()) throw new Error("Enter a title and a body.")
    const fields = { kind: value, title: title.value.trim(), body: body.plainText }
    // Updates name the version they edited, so another client's newer edit is never overwritten.
    if (item)
      await memories.update({
        drawerID: item.id,
        expectedTimeUpdated: item.timeUpdated,
        wingID: item.wingID,
        roomID: item.roomID,
        ...fields,
      })
    else await memories.create({ wingID: place.wingID, roomID: place.roomID!, ...fields })
    ctx.say(item ? "Memory saved." : "Memory added.")
  }
  dialog.afterSubmit = reopen
  dialog.back = reopen
  dialog.error.content = "Tab next field · Ctrl+S save · Esc cancel"
  title.focus()
}
