import type { KeyEvent, PasteEvent } from "@opentui/core"
import { routeKey } from "./key-router"
import { resize } from "./status"
import type { DashboardContext } from "./context"

/** Ctrl+C / q: closes at once, or arms a confirmation when work or drafts would be lost. */
export function quit(d: DashboardContext) {
  const state = d.state
  if (Date.now() < d.run.quitArmedUntil) return close(d)
  if (state.modal?.busy) {
    d.run.quitArmedUntil = Date.now() + 3000
    return d.say("Request still running. Ctrl+C again quits; server work may continue.")
  }
  if (state.modal) {
    const draft = !!state.modal.save
    d.c.dialogs.close()
    if (!draft) return
    d.run.quitArmedUntil = Date.now() + 3000
    return d.say("Draft kept. Ctrl+C again quits and discards saved drafts.")
  }
  if (d.c.launch.hasDraft || d.c.requests.savedSessions().length) {
    d.run.quitArmedUntil = Date.now() + 3000
    return d.say("Unsent drafts are saved locally. Press q or Ctrl+C again to quit and discard them.")
  }
  close(d)
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
