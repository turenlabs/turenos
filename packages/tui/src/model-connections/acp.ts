import { TextRenderable } from "@opentui/core"
import { createAcpLoginController, type AcpLoginView } from "@turenlabs/client/acp-login"
import { matchesKey } from "../keys"
import { color } from "../theme"
import { finish, show, type Flow } from "./flow"

export function acp(flow: Flow, back: () => void) {
  const dialog = show(flow, "Antigravity ACP · Sign in with Google", 30)
  if (!dialog) return
  dialog.back = back
  const instructions = new TextRenderable(flow.renderer, {
    content: "Uses the official ACP runtime installed on the server. Press Enter to sign in with Google.",
    fg: color.text,
    wrapMode: "word",
  })
  dialog.form.add(instructions)
  dialog.error.content = "Enter sign in · Esc back"
  const controller = createAcpLoginController({
    authorize: () => flow.connection.providers.acp.authorize(flow.directory),
    status: (id, signal) => flow.connection.providers.acp.status(flow.directory, id, signal),
    cancel: (id) => flow.connection.providers.acp.cancel(flow.directory, id),
    complete: async () => {
      await flow.connection.providers.acp.complete()
      await flow.connection.providers.list(flow.directory)
    },
    onAuthenticated: () => finish(flow, "Antigravity ACP signed in; native session verified."),
    onState: (state) => {
      if (flow.state.closed || flow.state.modal !== dialog) return
      instructions.content = description(state)
      dialog.error.content =
        state.error ?? (pending(state) ? "C cancel sign-in · Esc back" : "Enter sign in · Esc back")
      dialog.error.fg = state.error ? color.error : color.muted
    },
    failure: "Antigravity ACP sign-in could not be confirmed. Check the server connection and runtime, then retry.",
    cancellationFailure: "Cancellation could not be confirmed. The server may still be waiting for Google sign-in.",
  })
  flow.controller.signal.addEventListener("abort", () => controller.dispose(), { once: true })
  dialog.key = (key) => {
    if (matchesKey(key, "enter")) void controller.start()
    else if (matchesKey(key, "c")) void controller.cancel()
    else return false
    return true
  }
  dialog.form.focus()
}

function pending(state: AcpLoginView) {
  return ["starting", "waiting", "finishing", "cancelling"].includes(state.phase)
}

function description(state: AcpLoginView) {
  if (state.url)
    return `Open this Google sign-in URL in a browser:\n${state.url}\n\nKeep this dialog open. The browser must reach the callback on the server; a remote server may need SSH port forwarding. No browser is launched by this TUI.`
  if (state.phase === "starting") return "Starting the official Antigravity ACP runtime…"
  if (state.phase === "waiting") return "Waiting for Google sign-in…"
  if (state.phase === "finishing") return "Google sign-in verified. Refreshing model availability…"
  if (state.phase === "cancelling") return "Cancelling sign-in on the server…"
  if (state.phase === "cancelled") return "Sign-in cancelled. Press Enter to try again."
  return "Press Enter to sign in with Google."
}
