import { BoxRenderable, TextRenderable, type InputRenderable, type KeyEvent } from "@opentui/core"
import { pathKey } from "@turenlabs/client/path-key"
import { errorText } from "../server"
import { label, type ModalState } from "../state"
import { color } from "../theme"
import { matchesKey } from "../keys"
import { inFolder, resolveFolder } from "../working-folders"
import type { MenuContext } from "./context"

/** The menu context plus the dashboard's status line, which announces the result of an open or close. */
export type FoldersContext = MenuContext

const INTRO =
  "Choose the folder the sidebar shows; new sessions start there. Opening and closing folders is shared with other clients on this server; closing only hides a folder."

/** A row of the list: one folder, or every open folder when `directory` is undefined. */
type Row = { directory: string | undefined; text: TextRenderable }

type Pane = {
  ctx: FoldersContext
  dialog: ModalState
  note: TextRenderable
  list: BoxRenderable
  field: InputRenderable
  /** The shared list as last read. */
  directories: string[]
  rows: Row[]
  cursor: number
  closing: boolean
  /** The row Enter or a tap acted on; undefined when Ctrl+S acts on the typed folder. */
  chosen: Row | undefined
}

export function workingFolders(ctx: FoldersContext) {
  const { state, dialogs, connection, renderer } = ctx
  if (!dialogs.navigate()) return
  const dialog = dialogs.open("Working folders › Show", false, 28)
  if (!dialog) return
  const note = new TextRenderable(renderer, { content: "", fg: color.muted, wrapMode: "word" })
  dialog.form.add(note)
  const list = new BoxRenderable(renderer, { flexDirection: "column", flexShrink: 0, marginTop: 1, marginBottom: 1 })
  dialog.form.add(list)
  const field = dialogs.input(dialog, "Open another folder (its path on the server, then Ctrl+S)", "", "/absolute/path")
  const directories = state.snapshot?.workingFolders ?? []
  const pane: Pane = { ctx, dialog, note, list, field, directories, rows: [], cursor: -1, closing: false, chosen: undefined }
  build(pane)
  hint(pane)
  dialog.key = (key) => paneKey(pane, key)
  dialog.submit = () => apply(pane)
  void connection.folders
    .read()
    .then((result) => {
      if (state.closed || state.modal !== dialog || dialog.busy || list.isDestroyed) return
      pane.directories = result ?? []
      build(pane)
    })
    .catch((error) => {
      if (state.closed || state.modal !== dialog || dialog.busy || dialog.error.isDestroyed) return
      dialog.error.content = `${errorText(error)}\nCtrl+S retries the chosen operation · Esc close`
    })
  field.focus()
}

/** The rows: every open folder, the folder on screen when it is not one of them, then the open folders. */
function build(pane: Pane) {
  const { ctx } = pane
  const current = ctx.state.folder?.directory
  const known = (directory: string) => pane.directories.some((item) => pathKey(item) === pathKey(directory))
  const directories = [...(current && !known(current) ? [current] : []), ...pane.directories]
  const previous = pane.rows[pane.cursor]?.directory
  pane.rows.forEach((row) => row.text.destroyRecursively())
  pane.rows = [undefined, ...directories].map((directory, index) => ({ directory, text: rowText(pane, index) }))
  const at = (directory: string | undefined) => pane.rows.findIndex((row) => row.directory === directory)
  // The cursor stays on its row across a re-read, and starts on the folder on screen, so Enter keeps it.
  pane.cursor = Math.max(0, pane.cursor < 0 ? at(current) : at(previous))
  pane.rows.forEach((row) => pane.list.add(row.text))
  paint(pane)
  pane.note.content = `${INTRO}${
    pane.directories.length ? "" : "\nNo folders are open yet, so All folders lists every session folder."
  }`
}

function rowText(pane: Pane, index: number) {
  return new TextRenderable(pane.ctx.renderer, {
    content: "",
    height: 1,
    flexShrink: 0,
    wrapMode: "none",
    truncate: true,
    onMouseDown: (event) => {
      event.preventDefault()
      if (event.button !== 0 || pane.dialog.busy) return
      pane.cursor = index
      paint(pane)
      // A tap shows the folder at once; closing one still takes Enter or Ctrl+S.
      if (pane.closing) return
      pane.chosen = pane.rows[index]
      void pane.ctx.dialogs.submit()
    },
  })
}

function paint(pane: Pane) {
  const current = pane.ctx.state.folder?.directory
  // A server that stores no list shows every folder, so no folder reads as closed there.
  const listed = pane.ctx.state.snapshot?.workingFolders !== undefined
  const all = listed ? "All open folders" : "All folders"
  pane.rows.forEach((row, index) => {
    const name = row.directory === undefined ? all : label(row.directory, 512)
    const open = !listed || !row.directory || pane.directories.some((item) => pathKey(item) === pathKey(row.directory!))
    const marks = `${row.directory === current ? "  · showing" : ""}${open ? "" : "  · not open"}`
    row.text.content = `${index === pane.cursor ? "▶" : " "} ${name}${marks}`
    row.text.fg = index === pane.cursor ? color.accent : color.text
  })
}

function hint(pane: Pane) {
  const { dialog, closing } = pane
  dialog.error.height = 3
  dialog.frame.title = ` Working folders › ${closing ? "Close" : "Show"} `
  dialog.error.content = closing
    ? "↑↓ choose · Enter close it\nCtrl+S close typed or chosen · Ctrl+R show mode · Esc"
    : "↑↓ choose · Enter or tap: show it\nCtrl+S open typed folder · Ctrl+R close mode · Esc"
  dialog.error.fg = closing ? color.warning : color.muted
}

function paneKey(pane: Pane, key: KeyEvent) {
  if (matchesKey(key, "up") || matchesKey(key, "down")) {
    const step = matchesKey(key, "up") ? -1 : 1
    pane.cursor = (pane.cursor + step + pane.rows.length) % pane.rows.length
    paint(pane)
    return true
  }
  if (matchesKey(key, "enter")) {
    pane.chosen = pane.rows[pane.cursor]
    void pane.ctx.dialogs.submit()
    return true
  }
  if (!matchesKey(key, "r", { ctrl: true })) return false
  pane.closing = !pane.closing
  hint(pane)
  return true
}

/** Enter or a tap acts on its row; Ctrl+S acts on the typed folder, or on the chosen row when nothing is typed. */
async function apply(pane: Pane) {
  const row = pane.chosen
  pane.chosen = undefined
  const typed = pane.field.value.trim()
  const target = row ? row.directory : typed || pane.rows[pane.cursor]?.directory
  if (pane.closing) {
    if (target === undefined) throw new Error("Choose a folder to close.")
    return closeFolder(pane.ctx, target)
  }
  if (!row && typed) return openFolder(pane.ctx, typed)
  return showFolder(pane.ctx, target)
}

async function showFolder(ctx: FoldersContext, directory: string | undefined) {
  const { state } = ctx
  if (directory === undefined) {
    state.folder = undefined
    state.workingDirectory = undefined
    return ctx.actions.say("Showing every open folder.")
  }
  await focusFolder(ctx, directory)
  ctx.actions.say(`Showing ${label(directory, 200)}.`)
}

async function openFolder(ctx: FoldersContext, directory: string) {
  const { state, connection } = ctx
  const folder = await resolveFolder(connection.client, directory)
  const result = await connection.folders.open(directory)
  if (state.closed) return
  if (state.snapshot) state.snapshot.workingFolders = result
  await focusFolder(ctx, directory, folder)
  ctx.actions.say(`Opened ${label(directory, 200)}. ${connection.folders.takeNotice()}`.trim())
}

async function closeFolder(ctx: FoldersContext, directory: string) {
  const { state, connection } = ctx
  const result = await connection.folders.close(directory)
  if (state.closed) return
  if (state.snapshot) state.snapshot.workingFolders = result
  if (state.workingDirectory === directory) state.workingDirectory = undefined
  if (state.folder && pathKey(state.folder.directory) === pathKey(directory)) state.folder = undefined
  ctx.actions.say(`Closed ${label(directory, 200)}. ${connection.folders.takeNotice()}`.trim())
}

/**
 * Makes the folder the one on screen, as the desktop opens a project: new work starts in it, and when the session
 * on screen is outside it, the folder's newest session takes its place.
 */
async function focusFolder(ctx: FoldersContext, directory: string, known?: Awaited<ReturnType<typeof resolveFolder>>) {
  const { state } = ctx
  const folder = known ?? (await resolveFolder(ctx.connection.client, directory))
  if (state.closed) return
  state.folder = folder
  const sessions = state.snapshot?.sessions ?? []
  const current = sessions.find((session) => session.id === state.selected)
  const newest = sessions.find((session) => !session.parentID && inFolder(folder, session))
  if (state.tab === "sessions" && newest && !(current && inFolder(folder, current))) ctx.actions.openSession(newest.id)
  // Opening a session forgets the folder last opened; this one is the default for new work.
  state.workingDirectory = directory
}
