import { SelectRenderable, TextAttributes, TextareaRenderable, TextRenderable } from "@opentui/core"
import type { KeyEvent } from "@opentui/core"
import { matchesKey } from "../keys"
import { color } from "../theme"
import { KINDS, type MemoriesContext, type Memory, type Place } from "./types"

/** The memory form; saving or leaving returns to the list through `reopen`. */
export function edit(ctx: MemoriesContext, place: Place, item: Memory | undefined, reopen: () => void) {
  const { dialogs } = ctx
  const memories = ctx.connection.client.memories
  dialogs.close(false)
  const dialog = dialogs.open(item ? "Edit memory" : "New memory", false, 30)
  if (!dialog) return
  const title = dialogs.input(dialog, "Title", item?.title ?? "")
  const body = bodyField(ctx, dialog, item?.body ?? "")
  const kind = kindField(ctx, dialog, item?.kind)
  dialog.key = (key: KeyEvent) => {
    if (!kind.focused || (!matchesKey(key, "up") && !matchesKey(key, "down"))) return false
    if (key.name === "up") kind.moveUp()
    else kind.moveDown()
    return true
  }
  dialog.submit = async () => {
    if (!title.value.trim() || !body.plainText.trim()) throw new Error("Enter a title and a body.")
    const fields = { kind: KINDS[kind.getSelectedIndex()]!, title: title.value.trim(), body: body.plainText }
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
  dialog.error.content = "Tab next field · ↑↓ change kind · Ctrl+S save · Esc cancel"
  title.focus()
}

type FormDialog = NonNullable<ReturnType<MemoriesContext["dialogs"]["open"]>>

function kindField(ctx: MemoriesContext, dialog: FormDialog, current: string | undefined) {
  dialog.form.add(new TextRenderable(ctx.renderer, { content: "Kind", fg: color.muted }))
  const select = new SelectRenderable(ctx.renderer, {
    height: KINDS.length,
    options: KINDS.map((name) => ({ name, description: "" })),
    showDescription: false,
    showSelectionIndicator: true,
    backgroundColor: color.panel,
    textColor: color.text,
    selectedBackgroundColor: color.selected,
    selectedTextColor: color.accent,
    marginBottom: 1,
  })
  select.setSelectedIndex(Math.max(0, KINDS.indexOf(current as (typeof KINDS)[number])))
  dialog.form.add(select)
  ctx.dialogs.track(dialog, select)
  return select
}

// The shared prompt field carries the message editor's placeholder and Send button, which a memory has no use for.
function bodyField(ctx: MemoriesContext, dialog: FormDialog, value: string) {
  dialog.form.add(
    new TextRenderable(ctx.renderer, {
      content: "Body (Enter adds a line)",
      fg: color.text,
      attributes: TextAttributes.BOLD,
    }),
  )
  const body = new TextareaRenderable(ctx.renderer, {
    height: 6,
    minHeight: 3,
    backgroundColor: color.bg,
    textColor: color.text,
    focusedBackgroundColor: color.selected,
    wrapMode: "word",
    placeholder: "What should agents remember?",
    placeholderColor: color.muted,
    initialValue: value,
  })
  dialog.form.add(body)
  ctx.dialogs.track(dialog, body)
  return body
}
