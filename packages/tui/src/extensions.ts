import { StyledText, fg, type CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import { matchesKey } from "./keys"
import { display } from "./messages"
import { openPanel } from "./panel"
import { openPicker } from "./picker"
import { array, isRecord, object, string } from "./response-validation"
import { secretField } from "./secret-field"
import { errorText, type Connection } from "./server"
import { label, type DashboardState } from "./state"
import { color } from "./theme"

type Field = { id: string; label: string; required: boolean }
type Contribution = {
  type: string
  id: string
  name: string
  description: string
  secrets: Field[]
  configuration: Field[]
  authentication?: string
}
type Extension = {
  id: string
  name: string
  description: string
  enabled: boolean
  mutable: boolean
  status: string
  detail?: string
  contributions: Contribution[]
  secretsSet: Record<string, boolean>
  configurationSet: Record<string, boolean>
}

/**
 * The desktop's Extend page: skills, MCP servers, and data sources from the catalog or your
 * configuration. Enter turns one on or off; s and c fill in its secrets and settings; o starts an
 * MCP sign-in, which the server opens in a browser on its own computer.
 */
export function createExtensions(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  directory: () => string,
) {
  /** Every change is idempotent by operation ID and answers with the whole updated list. */
  function patch(item: Extension, change: Record<string, unknown>) {
    return connection.api(`/extension/${encodeURIComponent(item.id)}`, {
      method: "PATCH",
      directory: directory(),
      body: { enabled: item.enabled, operationID: crypto.randomUUID(), ...change },
      timeout: 30000,
    })
  }

  function open(back?: () => void) {
    if (!dialogs.navigate()) return
    const panel = openPanel(renderer, dialogs, "Extensions")
    if (!panel) return
    panel.dialog.back = back
    let items: Extension[] = []
    const keys = "↑↓ choose · Enter on/off · s secret · c setting · o sign in · Ctrl+R refresh · Esc back"

    function show(list: Extension[], select?: string) {
      items = list.toSorted((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name))
      const enabled = items.filter((item) => item.enabled).length
      panel!.heading.content = `${enabled} of ${items.length} enabled · ${label(directory(), 120)}`
      panel!.list.options = items.map((item) => ({
        name: `${item.enabled ? "●" : "○"} ${label(item.name, 40)} · ${item.status}`,
        description: "",
      }))
      panel!.list.setSelectedIndex(
        Math.max(
          0,
          items.findIndex((item) => item.id === select),
        ),
      )
      panel!.dialog.error.content = keys
      describe()
    }

    function describe() {
      const item = items[panel!.list.getSelectedIndex()]
      if (!item) return panel!.show("No extensions on this server.")
      panel!.show(details(item))
    }

    async function load() {
      try {
        const result = extensionList(await connection.api("/extension", { directory: directory() }))
        if (state.modal === panel!.dialog) show(result, items[panel!.list.getSelectedIndex()]?.id)
      } catch (error) {
        if (state.modal === panel!.dialog) panel!.show(`Extensions unavailable: ${errorText(error)}`)
      }
    }

    async function update(item: Extension, change: Record<string, unknown>, done: string) {
      if (!item.mutable) return note("This extension is managed and cannot change on this server.")
      try {
        const result = extensionList(await patch(item, change))
        if (state.modal !== panel!.dialog) return
        show(result, item.id)
        note(done)
      } catch (error) {
        note(`! ${errorText(error)}`)
      }
    }

    function note(text: string) {
      panel!.dialog.error.content = `${text}\n${keys}`
    }

    function field(kind: "secret" | "setting") {
      const item = items[panel!.list.getSelectedIndex()]
      const fields =
        item?.contributions.flatMap((contribution) =>
          kind === "secret" ? contribution.secrets : contribution.configuration,
        ) ?? []
      if (!item || !fields.length) return note(`This extension has no ${kind}s.`)
      const set = kind === "secret" ? item.secretsSet : item.configurationSet
      dialogs.close(false)
      openPicker(renderer, dialogs, {
        title: `${label(item.name, 40)} · ${kind}s`,
        text:
          kind === "secret"
            ? "Secrets are stored encrypted on the server and never shown again."
            : "Settings are saved on the server.",
        back: () => open(back),
        choices: fields.map((entry) => ({
          name: `${set[entry.id] ? "●" : "○"} ${label(entry.label, 60)}${entry.required ? " · required" : ""}`,
          description: set[entry.id] ? "Set; entering a value replaces it" : "Not set",
          run: () => enter(item, entry, kind),
        })),
      })
    }

    function enter(item: Extension, entry: Field, kind: "secret" | "setting") {
      const dialog = dialogs.open(label(entry.label, 60), false, 14)
      if (!dialog) return
      const masked = kind === "secret" ? secretField(renderer, { limit: 8192, reject: () => undefined }) : undefined
      const plain = masked ? undefined : dialogs.input(dialog, entry.label)
      if (masked) {
        dialog.form.add(masked.field)
        dialogs.track(dialog, masked.field)
      }
      dialog.submit = async () => {
        const value = masked ? masked.take() : plain!.value
        if (!value) throw new Error("Enter a value.")
        await patch(item, { enabled: true, [kind === "secret" ? "secrets" : "configuration"]: { [entry.id]: value } })
      }
      dialog.afterSubmit = () => open(back)
      dialog.error.content = "Ctrl+S save · Esc cancel"
      ;(masked?.field ?? plain!).focus()
    }

    panel.list.on("selectionChanged", describe)
    panel.dialog.key = (key) => {
      const item = items[panel.list.getSelectedIndex()]
      const action = matchesKey(key, "r", { ctrl: true })
        ? load
        : !item
          ? undefined
          : matchesKey(key, "enter")
            ? () => update(item, { enabled: !item.enabled }, item.enabled ? "Turned off." : "Turned on.")
            : key.sequence === "s"
              ? () => field("secret")
              : key.sequence === "c"
                ? () => field("setting")
                : key.sequence === "o"
                  ? () =>
                      update(
                        item,
                        { enabled: true, connect: true },
                        "Sign-in started; the server opens it in a browser on its computer.",
                      )
                  : undefined
      if (!action) return false
      void action()
      return true
    }
    panel.show("Loading extensions…")
    void load()
  }

  return { open }
}

function details(item: Extension) {
  const missing = item.contributions.flatMap((contribution) =>
    contribution.secrets
      .filter((secret) => secret.required && !item.secretsSet[secret.id])
      .map((secret) => secret.label),
  )
  return new StyledText([
    fg(color.text)(`${display(item.name, 200)}\n`),
    fg(color.muted)(
      `${item.enabled ? "On" : "Off"} · ${item.status}${item.mutable ? "" : " · managed (read-only here)"}\n\n`,
    ),
    fg(color.text)(`${display(item.description, 4000)}\n\n`),
    ...(item.detail ? [fg(color.warning)(`${display(item.detail, 2000)}\n\n`)] : []),
    ...(missing.length
      ? [fg(color.warning)(`Needs: ${missing.map((name) => label(name, 60)).join(", ")} (s)\n\n`)]
      : []),
    fg(color.muted)("PROVIDES\n"),
    ...item.contributions.map((contribution) =>
      fg(color.text)(
        `  ${contribution.type} · ${label(contribution.name, 60)}${contribution.authentication && contribution.authentication !== "none" ? ` · sign-in: ${contribution.authentication}` : ""}\n    ${label(contribution.description, 200)}\n`,
      ),
    ),
  ])
}

function extensionList(value: unknown): Extension[] {
  return array(value, 2048).map((value) => {
    const item = object(value)
    const manifest = object(item.manifest)
    const flags = (value: unknown) =>
      isRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, set]) => [key, set === true])) : {}
    return {
      id: string(manifest.id, 256),
      name: string(manifest.name, 512),
      description: typeof manifest.description === "string" ? manifest.description : "",
      enabled: item.enabled === true,
      mutable: item.mutable === true,
      status: string(item.status, 32),
      detail: typeof item.detail === "string" ? item.detail : undefined,
      secretsSet: flags(item.secretsSet),
      configurationSet: flags(item.configurationSet),
      contributions: array(manifest.contributions, 256).map((value) => {
        const contribution = object(value)
        return {
          type: string(contribution.type, 32),
          id: string(contribution.id, 256),
          name: typeof contribution.name === "string" ? contribution.name : string(contribution.id, 256),
          description: typeof contribution.description === "string" ? contribution.description : "",
          secrets: fields(contribution.secrets),
          configuration: fields(contribution.configuration),
          authentication: typeof contribution.authentication === "string" ? contribution.authentication : undefined,
        }
      }),
    }
  })
}

function fields(value: unknown): Field[] {
  if (value === undefined) return []
  return array(value, 64).map((value) => {
    const field = object(value)
    return { id: string(field.id, 256), label: string(field.label, 512), required: field.required === true }
  })
}

export type Extensions = ReturnType<typeof createExtensions>
