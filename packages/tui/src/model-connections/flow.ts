import { TextRenderable, type CliRenderer } from "@opentui/core"
import type { Dialogs } from "../dialogs"
import { matchesKey } from "../keys"
import type { Connection } from "../server"
import { label, type DashboardState, type ModalState } from "../state"
import { color } from "../theme"

/** One provider-connection session: the open modal, the answers typed so far, and the abort scope. */
export type Flow = {
  renderer: CliRenderer
  state: DashboardState
  connection: Connection
  dialogs: Dialogs
  say: (message: string, error?: boolean) => void
  directory: string
  done: () => void
  controller: AbortController
  answers: Map<string, string>
  current?: ModalState
  /** Restarts the flow from the provider list; Enter on a failed request runs it. */
  reload: () => void
}

export type FlowDeps = Pick<Flow, "renderer" | "state" | "connection" | "dialogs" | "say">

export function createFlow(deps: FlowDeps, directory: string, done: () => void, reload: (flow: Flow) => void): Flow {
  const controller = new AbortController()
  const answers = new Map<string, string>()
  controller.signal.addEventListener("abort", () => answers.clear(), { once: true })
  const flow: Flow = { ...deps, directory, done, controller, answers, reload: () => reload(flow) }
  return flow
}

export function closeFlowDialog(flow: Flow) {
  flow.current = undefined
  flow.dialogs.close(false)
}

export function show(flow: Flow, title: string, height = 26) {
  const { state, controller, dialogs, renderer, connection } = flow
  if (state.closed || controller.signal.aborted || (state.modal && state.modal !== flow.current)) return
  if (flow.current) closeFlowDialog(flow)
  const dialog = dialogs.open(title, false, height)
  if (!dialog) return
  flow.current = dialog
  dialog.frame.add(
    new TextRenderable(renderer, {
      content: `Server-global credentials and configuration\nServer: ${label(URL.parse(connection.address)?.origin ?? "Unknown server", 512)}`,
      fg: color.muted,
      flexShrink: 0,
      wrapMode: "word",
    }),
    0,
  )
  dialog.box.once("destroyed", () => {
    if (flow.current !== dialog) return
    flow.current = undefined
    controller.abort()
    // Escape is handled by dialogs before dialog.key. Destruction cancels
    // waiting OAuth without marking the modal busy or persisting a draft.
    queueMicrotask(() => {
      if (!state.closed && !renderer.isDestroyed && !state.modal) flow.done()
    })
  })
  return dialog
}

export function finish(flow: Flow, message: string, error = false) {
  closeFlowDialog(flow)
  flow.controller.abort()
  flow.done()
  flow.say(message, error)
}

export function wait<T>(
  flow: Flow,
  title: string,
  work: () => Promise<T>,
  next: (result: T) => void,
  instructions = "",
) {
  const { state, controller } = flow
  const dialog = show(flow, title, 28)
  if (!dialog) return
  dialog.form.add(
    new TextRenderable(flow.renderer, { content: instructions || title, fg: color.text, wrapMode: "word" }),
  )
  dialog.error.content = "Esc cancel waiting; a request already sent may still save on the server."
  dialog.form.focus()
  void (async () => {
    try {
      const result = await work()
      if (state.closed || controller.signal.aborted || state.modal !== dialog) return
      next(result)
    } catch (error) {
      if (state.closed || controller.signal.aborted || state.modal !== dialog) return
      flow.answers.clear()
      // Only recognize fixed adapter messages, never display an exception
      // body that could contain a credential or an OAuth response.
      const partial =
        "Provider configuration was saved, but the API key could not be confirmed. Refresh providers and reconnect this provider before retrying."
      const message =
        error instanceof Error && error.message === partial
          ? partial
          : "Provider request could not be confirmed. Check the connection and entered settings. Refresh providers before retrying."
      dialog.error.content = `${message}\nEnter refresh providers | Esc return to models`
      dialog.error.fg = color.error
      dialog.error.height = 5
      dialog.key = (key) => {
        if (!matchesKey(key, "enter")) return false
        flow.reload()
        return true
      }
    }
  })()
}

export function saved(flow: Flow) {
  wait(
    flow,
    "Checking model availability",
    () =>
      flow.connection.providers.list(flow.directory).then(
        () => true,
        () => false,
      ),
    (checked) =>
      finish(
        flow,
        checked
          ? "Provider saved; availability checked by catalog, not an upstream key test."
          : "Provider saved; catalog refresh failed. The upstream key was not tested.",
        !checked,
      ),
  )
}
