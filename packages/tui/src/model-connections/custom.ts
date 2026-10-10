import { matchesKey } from "../keys"
import { color } from "../theme"
import { credential, secret } from "./fields"
import { saveWithCtrlS, saved, show, wait, type Flow } from "./flow"

const hint = "Tab fields · Enter / Ctrl+S save · Esc back (key not kept)"

/** The OpenAI-compatible provider form. Only the API key is optional. Esc runs `back`; typed text survives it. */
export function custom(flow: Flow, back: () => void) {
  const dialog = show(flow, "Add OpenAI-compatible provider", 30)
  if (!dialog) return
  dialog.back = back
  const text = textField(flow, dialog)
  const providerID = text("providerID", "Provider ID (unique)", "my-gateway", 256)
  const name = text("name", "Provider name", "My Gateway", 512)
  const baseURL = text("baseURL", "Base URL (no credentials, query, or fragment)", "https://gateway.example/v1", 4096)
  const modelID = text("modelID", "Model ID", "organization/model", 512)
  const modelName = text("modelName", "Model name", "My Model", 512)
  const fields = [
    ["providerID", providerID],
    ["name", name],
    ["baseURL", baseURL],
    ["modelID", modelID],
    ["modelName", modelName],
  ] as const
  const key = secret(flow, dialog, "API key (optional, hidden)")
  dialog.error.content = hint
  const save = () => {
    if (fields.some(([, field]) => !field.value.trim())) {
      dialog.error.content = `Fill in all provider and model fields. Only the API key is optional.\n${hint}`
      dialog.error.height = 4
      dialog.error.fg = color.error
      return
    }
    const value = key()
    if (value && !credential(dialog, value)) return
    const input = {
      providerID: providerID.value,
      name: name.value,
      baseURL: baseURL.value,
      modelID: modelID.value,
      modelName: modelName.value,
      ...(value ? { key: value } : {}),
    }
    wait(
      flow,
      "Saving custom provider",
      () => flow.connection.providers.addCustom(input, flow.directory, flow.controller.signal),
      () => saved(flow),
    )
  }
  saveWithCtrlS(dialog, save)
  dialog.key = (event) => {
    if (!matchesKey(event, "enter")) return false
    save()
    return true
  }
  providerID.focus()
}

type Dialog = NonNullable<ReturnType<typeof show>>

/** A form field that keeps what is typed in the flow's drafts and clears a stale error as it changes. */
function textField(flow: Flow, dialog: Dialog) {
  const height = dialog.error.height
  return (key: string, title: string, placeholder: string, limit: number) => {
    const field = flow.dialogs.input(dialog, title, flow.drafts.get(key) ?? "", `e.g. ${placeholder}`)
    field.maxLength = limit
    field.on("input", () => {
      // Esc destroys the fields before it runs `back`, so the draft is kept as it is typed.
      flow.drafts.set(key, field.value)
      dialog.error.content = hint
      dialog.error.fg = color.muted
      dialog.error.height = height
    })
    return field
  }
}
