import { matchesKey } from "../keys"
import { color } from "../theme"
import { credential, secret } from "./fields"
import { saved, show, wait, type Flow } from "./flow"

/** The OpenAI-compatible provider form. Only the API key is optional. */
export function custom(flow: Flow) {
  const { dialogs } = flow
  const dialog = show(flow, "Add OpenAI-compatible provider", 30)
  if (!dialog) return
  const providerID = dialogs.input(dialog, "Provider ID (unique)", "", "my-gateway")
  providerID.maxLength = 256
  const name = dialogs.input(dialog, "Provider name", "", "My Gateway")
  name.maxLength = 512
  const baseURL = dialogs.input(
    dialog,
    "Base URL (no credentials, query, or fragment)",
    "",
    "https://gateway.example/v1",
  )
  const modelID = dialogs.input(dialog, "Model ID", "", "organization/model")
  modelID.maxLength = 512
  const modelName = dialogs.input(dialog, "Model name", "", "My Model")
  modelName.maxLength = 512
  const key = secret(flow, dialog, "API key (optional, hidden)")
  dialog.error.content = "Tab fields | Enter save | Ctrl+U clear key | Esc cancel (no draft)"
  dialog.key = (event) => {
    if (!matchesKey(event, "enter")) return false
    if ([providerID, name, baseURL, modelID, modelName].some((field) => !field.value.trim())) {
      dialog.error.content = "Fill in all provider and model fields. Only the API key is optional."
      dialog.error.fg = color.error
      return true
    }
    const value = key()
    if (value && !credential(dialog, value)) return true
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
    return true
  }
  providerID.focus()
}
