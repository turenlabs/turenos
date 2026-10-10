import { errorText } from "../server"
import { color } from "../theme"
import { renderActions } from "./actions"
import { renderList } from "./list"
import { renderStatus } from "./status"
import type { DashboardContext } from "./context"

/** Joins the in-flight snapshot refresh, or starts one. */
export async function refresh(d: DashboardContext) {
  if (d.state.closed) return
  d.run.refreshing ??= update(d).finally(() => {
    d.run.refreshing = undefined
  })
  return d.run.refreshing
}

async function update(d: DashboardContext) {
  const state = d.state
  if (d.run.timer) clearTimeout(d.run.timer)
  try {
    const snapshot = await d.connection.snapshot(state.folder)
    if (state.closed) return
    keepKnownSessions(d, snapshot)
    state.snapshot = snapshot
    state.connected = true
    state.connectionError = ""
    // The room is read after the snapshot succeeded, so a Team failure never reads as a lost connection.
    if (state.tab === "team") await d.c.team.poll()
    d.ui.status.fg = color.muted
    renderStatus(d)
    renderList(d)
    if (!state.modal?.inline) await d.c.conversation.render()
  } catch (error) {
    if (state.closed) return
    showDisconnected(d, error)
  } finally {
    if (!state.closed) d.run.timer = setTimeout(() => void refresh(d), 2000)
  }
}

/** Sessions the server page omits but the client still needs: inspected, replying, and drafted ones. */
function keepKnownSessions(
  d: DashboardContext,
  snapshot: Awaited<ReturnType<DashboardContext["connection"]["snapshot"]>>,
) {
  const state = d.state
  if (state.inspected && !snapshot.sessions.some((session) => session.id === state.inspected!.id))
    snapshot.sessions.push(state.inspected)
  const recipient = state.modal?.recipient
  if (recipient && !snapshot.sessions.some((session) => session.id === recipient.id)) snapshot.sessions.push(recipient)
  for (const saved of d.c.requests.savedSessions()) {
    if (!snapshot.sessions.some((session) => session.id === saved.id)) snapshot.sessions.push(saved)
  }
}

function showDisconnected(d: DashboardContext, error: unknown) {
  d.state.connected = false
  d.state.connectionError = errorText(error)
  d.state.detail = undefined
  ++d.state.detailVersion
  d.ui.status.fg = color.error
  renderStatus(d)
  renderActions(d)
  // The sidebar keeps the last known list; its rows stop claiming live state.
  if (d.state.snapshot) renderList(d)
  if (!d.state.snapshot)
    d.ui.renderContent(
      errorText(error).includes("Authentication required")
        ? "Authentication required.\n\nSet FORGE_SERVER_PASSWORD to the server's password and restart the TUI.\nUse --username if the server has a custom username."
        : `Could not connect to the server.\n\n${errorText(error)}\n\nPress r to retry.`,
    )
}
