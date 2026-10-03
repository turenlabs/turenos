import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import { styledPatch } from "./diff"
import { matchesKey } from "./keys"
import { mentionInReply, openPanel, type Drafts } from "./panel"
import { array, choice, numeric, object, optional, string } from "./response-validation"
import { errorText, type Connection, type Detail, type Session } from "./server"
import { label, type DashboardState } from "./state"

type Mode = "git" | "branch" | "turn"
type FileDiff = { file: string; patch?: string; additions: number; deletions: number; status?: string }

const MODES: Record<Mode, string> = {
  git: "Uncommitted changes",
  branch: "Changes on this branch",
  turn: "Files the last turn changed",
}
const STATUS: Record<string, string> = { added: "A", deleted: "D", modified: "M" }

/**
 * The desktop's review panel: the working tree's uncommitted changes, the branch against its base,
 * or the files the agent's last turn changed with their current uncommitted diff, one file at a
 * time. Read-only; `@` mentions a file in the reply so the agent can be asked about it.
 */
export function createChanges(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
  drafts: Drafts,
) {
  function open() {
    const session = state.snapshot?.sessions.find((item) => item.id === state.selected)
    if (state.tab !== "sessions" || !session) return say("Select a session first.")
    if (!dialogs.navigate()) return
    const panel = openPanel(renderer, dialogs, "Changes")
    if (!panel) return
    panel.dialog.recipient = session
    let mode: Mode = "git"
    let files: FileDiff[] = []
    let request = 0
    const keys = "↑↓ file · PgUp/PgDn scroll · m mode · @ mention in reply · Ctrl+R refresh · Esc close"

    async function load() {
      const version = ++request
      panel!.heading.content = `${MODES[mode]} · loading…`
      try {
        const result = await fetchDiff(session!, mode)
        if (version !== request || state.modal !== panel!.dialog) return
        files = result
        const added = files.reduce((total, file) => total + file.additions, 0)
        const removed = files.reduce((total, file) => total + file.deletions, 0)
        panel!.heading.content = `${MODES[mode]} · ${files.length} file${files.length === 1 ? "" : "s"} +${added} -${removed} · ${label(session!.location.directory, 120)}`
        panel!.list.options = files.map((file) => ({
          name: `${STATUS[file.status ?? ""] ?? "M"} ${label(file.file, 200)}  +${file.additions} -${file.deletions}`,
          description: "",
        }))
        panel!.list.setSelectedIndex(0)
        showFile()
        panel!.dialog.error.content = keys
      } catch (error) {
        if (version !== request || state.modal !== panel!.dialog) return
        files = []
        panel!.list.options = []
        panel!.show(`${MODES[mode]} unavailable: ${errorText(error)}`)
        panel!.dialog.error.content = `m mode · Ctrl+R retry · Esc close`
      }
    }

    function showFile() {
      const file = files[panel!.list.getSelectedIndex()]
      if (!file)
        return panel!.show(
          mode === "turn" ? "The last turn changed no files." : "No changes. The working tree matches its base.",
        )
      if (file.patch) return panel!.show(styledPatch(file.patch))
      panel!.show(
        mode === "turn" && !file.additions && !file.deletions
          ? "No uncommitted change to this file now; it may have been committed or reverted since."
          : "No patch text: the file is binary or too large to show.",
      )
    }

    async function fetchDiff(session: Session, mode: Mode) {
      const vcs = async (mode: "git" | "branch") =>
        diffList(
          await connection.api("/vcs/diff", { directory: session.location.directory, query: { mode, context: 3 } }),
        )
      if (mode !== "turn") return vcs(mode)
      // Assistant messages name the files each turn touched; the patch is what is uncommitted now.
      const touched = state.detail?.sessionID === session.id ? turnFiles(state.detail.messages) : []
      if (!touched.length) return []
      const current = await vcs("git")
      return touched.map((file) => current.find((item) => item.file === file) ?? { file, additions: 0, deletions: 0 })
    }

    function cycle() {
      mode = mode === "git" ? "branch" : mode === "branch" ? "turn" : "git"
      return load()
    }

    const mentionFile = () =>
      mentionInReply(panel!, dialogs, session!, files[panel!.list.getSelectedIndex()]?.file, drafts)

    panel.list.on("selectionChanged", showFile)
    panel.dialog.key = (key) => {
      const action = matchesKey(key, "r", { ctrl: true })
        ? load
        : key.sequence === "m"
          ? cycle
          : key.sequence === "@"
            ? mentionFile
            : undefined
      if (!action) return false
      void action()
      return true
    }
    void load()
  }

  return { open }
}

/** Files the agent changed since the newest prompt the user typed. */
function turnFiles(messages: Detail["messages"]) {
  const start = messages.findLastIndex(
    (message) => message.type === "user" && (!message.source || message.source === "user"),
  )
  return [
    ...new Set(
      messages
        .slice(start + 1)
        .flatMap((message) => (message.type === "assistant" ? (message.snapshot?.files ?? []) : [])),
    ),
  ]
}

function diffList(value: unknown): FileDiff[] {
  return array(value, 5000).flatMap((item) => {
    const entry = object(item)
    if (entry.file === undefined) return []
    optional(entry.status, (status) => choice(status, ["added", "deleted", "modified"]))
    return [
      {
        file: string(entry.file, 4096),
        patch: entry.patch === undefined ? undefined : string(entry.patch),
        additions: numeric(entry.additions),
        deletions: numeric(entry.deletions),
        status: entry.status as string | undefined,
      },
    ]
  })
}
