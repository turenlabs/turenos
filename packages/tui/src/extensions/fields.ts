import { openPicker } from "../picker"
import { secretField } from "../secret-field"
import { label } from "../state"
import type { Extension, ExtensionsContext, Field } from "./types"

/** Saves a secret or a setting; every change is idempotent by operation ID and answers with the whole list. */
export function patch(ctx: ExtensionsContext, item: Extension, change: Record<string, unknown>) {
  return ctx.connection.api(`/extension/${encodeURIComponent(item.id)}`, {
    method: "PATCH",
    directory: ctx.directory(),
    body: { enabled: item.enabled, operationID: crypto.randomUUID(), ...change },
    timeout: 30000,
  })
}

/** Lists the extension's secrets or settings; `back` reopens the extension list. */
export function pickField(
  ctx: ExtensionsContext,
  item: Extension,
  fields: Field[],
  kind: "secret" | "setting",
  back: () => void,
) {
  const set = kind === "secret" ? item.secretsSet : item.configurationSet
  ctx.dialogs.close(false)
  openPicker(ctx.renderer, ctx.dialogs, {
    title: `${label(item.name, 40)} · ${kind}s`,
    text:
      kind === "secret"
        ? "Secrets are stored encrypted on the server and never shown again."
        : "Settings are saved on the server.",
    back,
    choices: fields.map((entry) => ({
      name: `${set[entry.id] ? "●" : "○"} ${label(entry.label, 60)}${entry.required ? " · required" : ""}`,
      description: set[entry.id] ? "Set; entering a value replaces it" : "Not set",
      run: () => enter(ctx, item, entry, kind, back),
    })),
  })
}

function enter(ctx: ExtensionsContext, item: Extension, entry: Field, kind: "secret" | "setting", back: () => void) {
  const { dialogs } = ctx
  const dialog = dialogs.open(label(entry.label, 60), false, 14)
  if (!dialog) return
  const masked = kind === "secret" ? secretField(ctx.renderer, { limit: 8192, reject: () => undefined }) : undefined
  const plain = masked ? undefined : dialogs.input(dialog, entry.label)
  if (masked) {
    dialog.form.add(masked.field)
    dialogs.track(dialog, masked.field)
  }
  dialog.submit = async () => {
    const value = masked ? masked.take() : plain!.value
    if (!value) throw new Error("Enter a value.")
    await patch(ctx, item, { enabled: true, [kind === "secret" ? "secrets" : "configuration"]: { [entry.id]: value } })
  }
  dialog.afterSubmit = back
  dialog.error.content = "Ctrl+S save · Esc cancel"
  ;(masked?.field ?? plain!).focus()
}
