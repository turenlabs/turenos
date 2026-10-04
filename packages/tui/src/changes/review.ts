import { styledPatch } from "../diff"
import type { Panel } from "../panel"
import { errorText, type Connection, type Session } from "../server"
import { label, type DashboardState } from "../state"
import { fitHeading, fitRow, panelWidth } from "./heading"
import { diffList, turnFiles, type FileDiff, type Mode } from "./diffs"

const MODES: Record<Mode, string> = {
  git: "Uncommitted changes",
  branch: "Changes on this branch",
  turn: "Files the last turn changed",
}
const STATUS: Record<string, string> = { added: "A", deleted: "D", modified: "M" }

/** Hint parts by priority: the trailing ones drop first when the panel is narrow. */
const HINTS = ["↑↓ file", "m mode", "@ mention in reply", "PgUp/PgDn scroll", "Ctrl+R refresh"]

/** One open Changes panel: the mode shown, its files, and the latest request that may still paint. */
export type Review = {
  state: DashboardState
  connection: Connection
  session: Session
  panel: Panel
  mode: Mode
  files: FileDiff[]
  /** Set once the files are fetched, so a resize does not paint a stale heading over "loading…". */
  loaded: boolean
  request: number
}

export async function load(r: Review) {
  const { panel } = r
  const version = ++r.request
  r.loaded = false
  panel.heading.content = `${MODES[r.mode]} · loading…`
  try {
    const result = await fetchDiff(r)
    if (version !== r.request || r.state.modal !== panel.dialog) return
    r.files = result
    r.loaded = true
    paint(r)
    panel.list.setSelectedIndex(0)
    showFile(r)
    panel.hints(HINTS, ["Esc close"])
  } catch (error) {
    if (version !== r.request || r.state.modal !== panel.dialog) return
    r.files = []
    panel.list.options = []
    panel.show(`${MODES[r.mode]} unavailable: ${errorText(error)}`)
    panel.dialog.error.content = `m mode · Ctrl+R retry · Esc close`
  }
}

/** Heading and rows fitted to the panel's current width; the paths shorten, the counts stay whole. */
export function paint(r: Review) {
  if (!r.loaded) return
  const { panel } = r
  const added = r.files.reduce((total, file) => total + file.additions, 0)
  const removed = r.files.reduce((total, file) => total + file.deletions, 0)
  panel.heading.content = fitHeading(
    panelWidth(panel),
    `${MODES[r.mode]} · ${r.files.length} file${r.files.length === 1 ? "" : "s"} +${added} -${removed} · `,
    label(r.session.location.directory, 400),
    "",
    "start",
  )
  panel.list.options = r.files.map((file) => ({
    name: fitRow(
      panelWidth(panel),
      `${STATUS[file.status ?? ""] ?? "M"} `,
      label(file.file, 200),
      `  +${file.additions} -${file.deletions}`,
    ),
    description: "",
  }))
}

export function showFile(r: Review) {
  const file = r.files[r.panel.list.getSelectedIndex()]
  if (!file)
    return r.panel.show(
      r.mode === "turn" ? "The last turn changed no files." : "No changes. The working tree matches its base.",
    )
  if (file.patch) return r.panel.show(styledPatch(file.patch))
  r.panel.show(
    r.mode === "turn" && !file.additions && !file.deletions
      ? "No uncommitted change to this file now; it may have been committed or reverted since."
      : "No patch text: the file is binary or too large to show.",
  )
}

async function fetchDiff(r: Review) {
  const { session } = r
  const vcs = async (mode: "git" | "branch") =>
    diffList(
      await r.connection.api("/vcs/diff", { directory: session.location.directory, query: { mode, context: 3 } }),
    )
  if (r.mode !== "turn") return vcs(r.mode)
  // Assistant messages name the files each turn touched; the patch is what is uncommitted now.
  const touched = r.state.detail?.sessionID === session.id ? turnFiles(r.state.detail.messages) : []
  if (!touched.length) return []
  const current = await vcs("git")
  return touched.map((file) => current.find((item) => item.file === file) ?? { file, additions: 0, deletions: 0 })
}

export function cycle(r: Review) {
  r.mode = r.mode === "git" ? "branch" : r.mode === "branch" ? "turn" : "git"
  return load(r)
}
