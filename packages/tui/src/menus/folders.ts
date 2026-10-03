import { SelectRenderable, TextRenderable } from "@opentui/core"
import { errorText } from "../server"
import { label, type ModalState } from "../state"
import { color } from "../theme"
import { matchesKey } from "../keys"
import type { MenuContext } from "./context"

export function workingFolders(ctx: MenuContext) {
  const { state, dialogs, connection, renderer } = ctx
  if (!dialogs.navigate()) return
  const dialog = dialogs.open("Working folders", false, 28)
  if (!dialog) return
  dialog.form.add(
    new TextRenderable(renderer, {
      content:
        "Open folders are shared with the GUI. Closing only hides a folder; it does not delete sessions or stop work.",
      fg: color.muted,
    }),
  )
  let directories = state.snapshot?.workingFolders ?? []
  const list = folderList(ctx, dialog, directories)
  const directory = dialogs.input(
    dialog,
    "Directory on the server",
    state.workingDirectory ?? directories[0] ?? state.snapshot?.location.directory ?? "",
  )
  let replacing = false
  list.on("selectionChanged", (index: number) => {
    if (!replacing && directories[index]) directory.value = directories[index]!
  })
  let closing = false
  const hint = () => {
    dialog.error.height = 3
    dialog.error.content = `Ctrl+S ${closing ? "Close folder in both clients" : "Open folder in both clients"}\nCtrl+R ${closing ? "Open" : "Close"} mode · Tab switch field\nEsc cancel`
    dialog.error.fg = closing ? color.warning : color.muted
  }
  hint()
  dialog.key = (key) => {
    if (matchesKey(key, "enter")) return true
    if (!matchesKey(key, "r", { ctrl: true })) return false
    closing = !closing
    hint()
    return true
  }
  dialog.submit = () => applyFolder(ctx, directory.value.trim(), closing)
  void connection.folders
    .read()
    .then((result) => {
      if (state.closed || state.modal !== dialog || dialog.busy) return
      directories = result ?? []
      replacing = true
      list.options = directories.map((value) => ({ name: label(value, 512), description: "" }))
      replacing = false
    })
    .catch((error) => {
      if (state.modal === dialog && !dialog.busy)
        dialog.error.content = `${errorText(error)}\nCtrl+S retries the chosen operation · Esc close`
    })
  directory.focus()
}

async function applyFolder(ctx: MenuContext, target: string, closing: boolean) {
  const { state, connection } = ctx
  const result = await (closing ? connection.folders.close(target) : connection.folders.open(target))
  if (state.closed) return
  if (state.snapshot) state.snapshot.workingFolders = result
  if (!closing) state.workingDirectory = target
  else if (state.workingDirectory === target) state.workingDirectory = undefined
}

function folderList(ctx: MenuContext, dialog: ModalState, directories: string[]) {
  const list = new SelectRenderable(ctx.renderer, {
    height: 4,
    options: directories.map((directory) => ({ name: label(directory, 512), description: "" })),
    showDescription: false,
    backgroundColor: color.panel,
    textColor: color.text,
    selectedBackgroundColor: color.selected,
    selectedTextColor: color.accent,
  })
  dialog.form.add(list)
  ctx.dialogs.track(dialog, list)
  return list
}
