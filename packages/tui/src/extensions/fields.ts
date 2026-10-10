import { matchesKey } from "../keys"
import { openPicker } from "../picker"
import { secretField } from "../secret-field"
import { label } from "../state"
import type { Extension, ExtensionsContext, Field } from "./types"

/**
 * Saves a secret or a setting and answers with the whole list. The caller makes the operation ID once per
 * user action, so a retry of the same action sends the same ID instead of a new one.
 */
export function patch(
  ctx: ExtensionsContext,
  item: Extension,
  change: Record<string, unknown>,
  operationID: string,
  secret = false,
) {
  return ctx.connection.api(`/extension/${encodeURIComponent(item.id)}`, {
    method: "PATCH",
    directory: ctx.directory(),
    body: { enabled: item.enabled, operationID, ...change },
    timeout: 30000,
    secret,
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
  // Field ids come from the server; an inherited name such as `constructor` must not read as set.
  const isSet = (id: string) => Object.hasOwn(set, id) && !!set[id]
  ctx.dialogs.close(false)
  openPicker(ctx.renderer, ctx.dialogs, {
    title: `${root} › ${label(item.name, 40)} › ${kind === "secret" ? "Secrets" : "Settings"}`,
    text:
      kind === "secret"
        ? "Secrets are stored encrypted on the server and never shown again."
        : "Settings are saved on the server.",
    back: () => back(),
    choices: fields.map((entry) => ({
      name: `${isSet(entry.id) ? "●" : "○"} ${label(entry.label, 60)}${entry.required ? " · required" : ""}`,
      description: isSet(entry.id) ? "Set; entering a value replaces it" : "Not set",
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
  const masked =
    kind === "secret"
      ? secretField(ctx.renderer, {
          limit: 8192,
          reject: () => (dialog.error.content = "Rejected: control characters or more than 8,192 characters."),
        })
      : undefined
  const plain = masked ? undefined : dialogs.input(dialog, entry.label, ctx.drafts.get(draft) ?? "")
  if (masked) {
    dialog.form.add(masked.field)
    dialogs.track(dialog, masked.field)
  }
  let done = ""
  let attempt: { value: string; operationID: string } | undefined
  dialog.submit = async () => {
    const value = masked ? masked.take() : plain!.value
    if (!value) throw new Error("Enter a value.")
    // Saving the same value again after a failure is a retry; a changed value is a new action.
    if (attempt?.value !== value) attempt = { value, operationID: crypto.randomUUID() }
    await patch(
      ctx,
      item,
      { enabled: true, [kind === "secret" ? "secrets" : "configuration"]: { [entry.id]: value } },
      attempt.operationID,
      kind === "secret",
    )
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
