import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import { matchesKey } from "./keys"
import { mentionInReply, openPanel, type Drafts } from "./panel"
import type { Connection } from "./server"
import type { DashboardState } from "./state"
import { cycle, load, paint, showFile, type Review } from "./changes/review"

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
    panel.dialog.error.marginRight = 2
    const review: Review = { state, connection, session, panel, mode: "git", files: [], loaded: false, request: 0 }
    panel.list.on("selectionChanged", () => showFile(review))
    panel.fit("rows", () => paint(review))
    panel.dialog.key = (key) => {
      const action = matchesKey(key, "r", { ctrl: true })
        ? () => load(review)
        : key.sequence === "m"
          ? () => cycle(review)
          : key.sequence === "@"
            ? () => mentionInReply(panel, dialogs, session, review.files[panel.list.getSelectedIndex()]?.file, drafts)
            : undefined
      if (!action) return false
      void action()
      return true
    }
    void load(review)
  }

  return { open }
}
