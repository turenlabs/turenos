import { matchesKey } from "../keys"
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

/** Lists the extension's secrets or settings; `back` reopens the extension list, with a note on what was saved. */
export function pickField(
  ctx: ExtensionsContext,
  item: Extension,
  fields: Field[],
  kind: "secret" | "setting",
  back: (note?: string) => void,
  root: string,
) {
  const set = kind === "secret" ? item.secretsSet : item.configurationSet
  ctx.dialogs.close(false)
  openPicker(ctx.renderer, ctx.dialogs, {
    title: `${root} › ${label(item.name, 40)} › ${kind === "secret" ? "Secrets" : "Settings"}`,
    text:
      kind === "secret"
        ? "Secrets are stored encrypted on the server and never shown again."
        : "Settings are saved on the server.",
    back: () => back(),
    choices: fields.map((entry) => ({
      name: `${set[entry.id] ? "●" : "○"} ${label(entry.label, 60)}${entry.required ? " · required" : ""}`,
      description: set[entry.id] ? "Set; entering a value replaces it" : "Not set",
      run: () => enter(ctx, item, entry, kind, back, root),
    })),
  })
}

function enter(
  ctx: ExtensionsContext,
  item: Extension,
  entry: Field,
  kind: "secret" | "setting",
  back: (note?: string) => void,
  root: string,
) {
  const { dialogs } = ctx
  const dialog = dialogs.open(`${label(item.name, 30)} › ${label(entry.label, 40)}`, false, 14)
  if (!dialog) return
  const draft = `${item.id}/${entry.id}`
  const masked = kind === "secret" ? secretField(ctx.renderer, { limit: 8192, reject: () => undefined }) : undefined
  const plain = masked ? undefined : dialogs.input(dialog, entry.label, ctx.drafts.get(draft) ?? "")
  if (masked) {
    dialog.form.add(masked.field)
    dialogs.track(dialog, masked.field)
  }
  let done = ""
  dialog.submit = async () => {
    const value = masked ? masked.take() : plain!.value
    if (!value) throw new Error("Enter a value.")
    await patch(ctx, item, { enabled: true, [kind === "secret" ? "secrets" : "configuration"]: { [entry.id]: value } })
    ctx.drafts.delete(draft)
    done = `${kind === "secret" ? "Secret" : "Setting"} ${label(entry.label, 40)} saved${item.enabled ? "" : "; extension turned on"}.`
  }
  dialog.afterSubmit = () => back(done)
  // Typed settings survive Esc; a secret never does.
  dialog.back = () => {
    if (plain) ctx.drafts.set(draft, plain.value)
    pickField(ctx, item, fieldsOf(item, kind), kind, back, root)
  }
  dialog.key = (key) => {
    if (!plain || !matchesKey(key, "enter")) return false
    void dialogs.submit()
    return true
  }
  dialog.error.content = plain ? "Enter / Ctrl+S save · Esc back" : "Ctrl+S save · Esc back"
  ;(masked?.field ?? plain!).focus()
}

function fieldsOf(item: Extension, kind: "secret" | "setting") {
  return item.contributions.flatMap((entry) => (kind === "secret" ? entry.secrets : entry.configuration))
}
