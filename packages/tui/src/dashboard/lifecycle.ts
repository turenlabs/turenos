import type { KeyEvent, PasteEvent } from "@opentui/core"
import { routeKey } from "./key-router"
import { clearTitle, resize } from "./status"
import type { DashboardContext } from "./context"

/**
 * Ctrl+C / q: closes at once when nothing would be lost. Otherwise the first press stops the selected
 * session's running turn (Ctrl+C) or warns that it keeps running (q), or arms a confirmation for drafts.
 */
export function quit(d: DashboardContext, stop = false) {
  const state = d.state
  if (Date.now() < d.run.quitArmedUntil) return close(d)
  if (state.modal?.busy) return arm(d, "Request still running. Ctrl+C again quits; server work may continue.")
  // The reply editor stays open, so it is not a dialog to close first; its text counts as a draft.
  if (state.modal && !state.modal.composer) {
    const draft = !!state.modal.save
    d.c.dialogs.close()
    if (!draft) return
    return arm(d, "Draft kept. Ctrl+C again quits and discards unsent drafts.")
  }
  const drafts = d.c.launch.hasDraft || d.c.requests.unsentDrafts() > 0
  const again = `Ctrl+C again quits${drafts ? " and discards unsent drafts" : ""}.`
  if (stop && d.c.requests.stopRunning(again)) return arm(d, `Stopping this turn. ${again}`)
  if (!stop && state.selected && Object.hasOwn(state.snapshot?.active ?? {}, state.selected))
    return arm(
      d,
      `The agent is still working. Press q again to quit; it keeps running on the server${drafts ? ", and unsent drafts are discarded" : ""}.`,
    )
  // q types into an open reply editor, so only Ctrl+C is named there.
  if (drafts && state.modal?.composer) return arm(d, "Draft kept. Ctrl+C again quits and discards unsent drafts.")
  if (drafts)
    return arm(d, "Unsent drafts are kept only until you quit. Press q or Ctrl+C again to quit and discard them.")
  close(d)
}

function arm(d: DashboardContext, message: string) {
  d.run.quitArmedUntil = Date.now() + 3000
  d.say(message)
}

function close(d: DashboardContext) {
  if (d.state.closed) return
  d.state.closed = true
  d.onQuit()
}

export function openServers(d: DashboardContext, back?: () => void) {
  if (!d.options.servers || d.state.modal?.busy) return
  d.run.quitArmedUntil = 0
  d.options.servers(back)
}

/** Registers the dashboard's renderer listeners; `dispose` releases exactly these. */
export function attach(d: DashboardContext) {
  const listeners = {
    keypress: (key: KeyEvent) => routeKey(d, key),
    paste: (event: PasteEvent) => {
      if (!d.options.blocked?.()) d.c.dialogs.paste(event)
    },
    resize: () => resize(d),
    dispose: () => dispose(d),
  }
  d.run.listeners = listeners
  d.renderer.on("resize", listeners.resize)
  d.renderer.keyInput.on("keypress", listeners.keypress)
  d.renderer.keyInput.on("paste", listeners.paste)
  d.renderer.once("destroy", listeners.dispose)
  return listeners
}

/** Releases everything this dashboard holds so another can mount on the same renderer. */
export function dispose(d: DashboardContext) {
  if (d.run.disposed) return
  d.run.disposed = true
  d.state.closed = true
  clearTitle(d)
  d.c.live.dispose()
  if (d.run.timer) clearTimeout(d.run.timer)
  if (d.run.noticeTimer) clearTimeout(d.run.noticeTimer)
  if (d.run.activityTimer) clearInterval(d.run.activityTimer)
  d.connection.close()
  if (d.run.listeners) {
    d.renderer.keyInput.off("keypress", d.run.listeners.keypress)
    d.renderer.keyInput.off("paste", d.run.listeners.paste)
    d.renderer.off("resize", d.run.listeners.resize)
    d.renderer.off("destroy", d.run.listeners.dispose)
  }
  d.c.conversation.dispose()
  if (!d.renderer.isDestroyed) d.ui.root.destroyRecursively()
}
