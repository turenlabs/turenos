import { TextRenderable } from "@opentui/core"
import { matchesKey } from "../keys"
import type { AuthMethod } from "../providers"
import { label } from "../state"
import { color } from "../theme"
import { choose } from "./choose"
import { credential, secret } from "./fields"
import { saveWithCtrlS, saved, show, wait, type Flow } from "./flow"

/** One step of a provider's sign-in: its prompts in order, then the key entry or OAuth start. */
export function prompt(
  flow: Flow,
  providerID: string,
  method: AuthMethod,
  index: number,
  offset: number,
  back: () => void,
) {
  const item = method.prompts?.[offset]
  if (!item) {
    if (method.type === "api") return apiKey(flow, providerID, back)
    return startOAuth(flow, providerID, index, back)
  }
  if (item.when) {
    const value = flow.answers.get(item.when.key)
    if (value === undefined || (item.when.op === "eq" ? value !== item.when.value : value === item.when.value)) {
      prompt(flow, providerID, method, index, offset + 1, back)
      return
    }
  }
  const dialog = show(flow, label(method.label, 80))
  if (!dialog) return
  dialog.back = back
  const next = (value: string) => {
    flow.answers.set(item.key, value)
    prompt(flow, providerID, method, index, offset + 1, back)
  }
  if (item.type === "select") {
    dialog.form.add(new TextRenderable(flow.renderer, { content: item.message, fg: color.text }))
    choose(
      flow,
      dialog,
      item.options.map((option) => ({
        name: option.label,
        description: option.hint ?? "",
        run: () => next(option.value),
      })),
    )
    if (!item.options.length) dialog.error.content = "No options advertised for this prompt. Esc back."
    return
  }
  const value = secret(flow, dialog, `${item.message} (hidden)`, 4096, item.placeholder)
  dialog.error.content = "Enter continue (empty allowed) · Ctrl+U clear · Esc back"
  dialog.key = (event) => {
    if (!matchesKey(event, "enter")) return false
    next(value())
    return true
  }
}

function apiKey(flow: Flow, providerID: string, back: () => void) {
  const dialog = show(flow, "Save API key")
  if (!dialog) return
  dialog.back = back
  const key = secret(flow, dialog, "API key (hidden)")
  dialog.error.content = "Enter / Ctrl+S save · Ctrl+U clear · Esc back (key not kept)"
  const save = () => {
    const value = key()
    if (!credential(dialog, value)) return
    const metadata = flow.answers.size ? Object.fromEntries(flow.answers) : undefined
    flow.answers.clear()
    wait(
      flow,
      "Saving provider credentials",
      () => flow.connection.providers.connectKey(providerID, value, metadata, flow.controller.signal),
      () => saved(flow),
    )
  }
  saveWithCtrlS(dialog, save)
  dialog.key = (event) => {
    if (!matchesKey(event, "enter")) return false
    save()
    return true
  }
}

function startOAuth(flow: Flow, providerID: string, index: number, back: () => void) {
  const { connection, directory, controller } = flow
  const inputs = Object.fromEntries(flow.answers)
  flow.answers.clear()
  wait(
    flow,
    "Starting OAuth",
    () => connection.providers.authorize(directory, providerID, index, inputs, controller.signal),
    (auth) => {
      const instructions = `Open this URL in a browser (on another device if headless):\n${auth.url}\n\n${auth.instructions}\n\nFor a remote server, a loopback browser redirect may need SSH port forwarding to that server. No browser is launched by this TUI.`
      if (auth.method === "auto") {
        wait(
          flow,
          "Waiting for OAuth",
          () => connection.providers.complete(directory, providerID, index, undefined, controller.signal),
          () => saved(flow),
          instructions,
        )
        return
      }
      codeEntry(flow, providerID, index, instructions, back)
    },
  )
}

function codeEntry(flow: Flow, providerID: string, index: number, instructions: string, back: () => void) {
  const dialog = show(flow, "Complete OAuth", 30)
  if (!dialog) return
  dialog.back = back
  dialog.form.add(new TextRenderable(flow.renderer, { content: instructions, fg: color.text, wrapMode: "word" }))
  const code = secret(flow, dialog, "Authorization code (hidden)")
  dialog.error.content = "Page Up/Down instructions · Enter / Ctrl+S complete · Ctrl+U clear · Esc back"
  const complete = () => {
    const value = code()
    if (!credential(dialog, value)) return
    wait(
      flow,
      "Completing OAuth",
      () => flow.connection.providers.complete(flow.directory, providerID, index, value, flow.controller.signal),
      () => saved(flow),
    )
  }
  saveWithCtrlS(dialog, complete)
  dialog.key = (event) => {
    if (!matchesKey(event, "enter")) return false
    complete()
    return true
  }
}
