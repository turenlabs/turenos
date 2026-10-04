import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import { matchesKey } from "./keys"
import { mentionInReply, openPanel, type Drafts } from "./panel"
import type { Connection } from "./server"
import type { DashboardState } from "./state"
import { enter, listFolder, preview, up, type FileBrowser, type FilesContext } from "./files/browser"

/**
 * The desktop's file browser for the selected session's folder on the server: folders open in
 * place, files show read-only on the right, and `@` mentions the chosen file in the reply.
 */
export function createFiles(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
  drafts: Drafts,
) {
  const ctx: FilesContext = { state, connection }

  function open() {
    const session = state.snapshot?.sessions.find((item) => item.id === state.selected)
    if (state.tab !== "sessions" || !session) return say("Select a session first.")
    if (!dialogs.navigate()) return
    const panel = openPanel(renderer, dialogs, "Files")
    if (!panel) return
    panel.dialog.recipient = session
    panel.dialog.error.marginRight = 2
    const browser: FileBrowser = {
      ctx,
      session,
      directory: session.location.directory,
      panel,
      folder: "",
      entries: [],
      request: 0,
    }
    panel.list.on("selectionChanged", () => void preview(browser))
    panel.dialog.key = (key) => {
      const action = matchesKey(key, "enter")
        ? () => enter(browser)
        : matchesKey(key, "left") || matchesKey(key, "backspace")
          ? () => up(browser)
          : key.sequence === "@"
            ? () =>
                mentionInReply(panel, dialogs, session, browser.entries[panel.list.getSelectedIndex()]?.path, drafts)
            : undefined
      if (!action) return false
      void action()
      return true
    }
    void listFolder(browser, "")
  }

  return { open }
}
