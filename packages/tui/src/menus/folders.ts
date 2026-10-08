import { SelectRenderable, TextRenderable } from "@opentui/core"
import { errorText, httpStatus } from "../server"
import { label, type ModalState } from "../state"
import { color } from "../theme"
import { matchesKey } from "../keys"
import type { MenuContext } from "./context"

/** The menu context plus the dashboard's status line, which announces the result of an open or close. */
export type FoldersContext = MenuContext

const INTRO =
  "Working folders are shared with other clients on this server. Closing only hides a folder; it does not delete sessions or stop work."

export function workingFolders(ctx: FoldersContext) {
  const { state, dialogs, connection, renderer } = ctx
  if (!dialogs.navigate()) return
  const dialog = dialogs.open("Working folders › Open", false, 28)
  if (!dialog) return
  let directories = state.snapshot?.workingFolders ?? []
  const note = new TextRenderable(renderer, { content: "", fg: color.muted, wrapMode: "word" })
  dialog.form.add(note)
  const list = folderList(ctx, dialog, directories)
  const describe = () => {
    note.content = `${INTRO}\n${directories.length ? `Open folders (${directories.length}): choose one to fill the field` : "No folders are open yet, so the sidebar shows every session folder."}`
  }
  describe()
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
    dialog.frame.title = ` Working folders › ${closing ? "Close" : "Open"} `
    dialog.error.content = `Ctrl+S ${closing ? "Close" : "Open"} folder\nCtrl+R switch to ${closing ? "Open" : "Close"} mode · Tab switch field\nEsc close`
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
      describe()
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

async function applyFolder(ctx: FoldersContext, target: string, closing: boolean) {
  const { state, connection } = ctx
  if (!closing) await requireFolder(ctx, target)
  const result = await (closing ? connection.folders.close(target) : connection.folders.open(target))
  if (state.closed) return
  if (state.snapshot) state.snapshot.workingFolders = result
  if (!closing) state.workingDirectory = target
  else if (state.workingDirectory === target) state.workingDirectory = undefined
  ctx.actions.say(`${closing ? "Closed" : "Opened"} ${label(target, 200)}.`)
}

/** Opening a folder the server cannot read would only fail later, as an HTTP 500 on session creation. */
async function requireFolder(ctx: MenuContext, target: string) {
  await ctx.connection.client.files.list({ location: { directory: target } }).catch((error: unknown) => {
    const status = httpStatus(error)
    if (status === undefined || status === 401 || status === 403) throw error
    throw new Error("Folder not found on the server.")
  })
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
