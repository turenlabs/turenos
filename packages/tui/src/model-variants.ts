import { SelectRenderable, TextRenderable, type CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import { matchesKey } from "./keys"
import { errorText, type Connection, type Session } from "./server"
import { label, type DashboardState } from "./state"
import { color } from "./theme"

type Target = {
  directory: string
  model: { providerID: string; id: string }
  current?: string
  choose: (variant: string | undefined, currentOnly?: boolean) => void | Promise<void>
  cancel?: () => void
}

export function createModelVariants(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
  onUpdate: (session: Session) => void = () => {},
  blocked: (id: string) => boolean = () => false,
) {
  function pick(target: Target) {
    return show({ ...target, model: { ...target.model } })
  }

  function show(target: Target, recipient?: Session) {
    if (state.closed || !dialogs.navigate()) return
    const opened = dialogs.open("Model variant / effort", false, 20)
    if (!opened) return
    const dialog = opened
    dialog.recipient = recipient
    dialog.back = target.cancel
    dialog.form.add(
      new TextRenderable(renderer, {
        content: recipient
          ? `For: ${label(recipient.title || recipient.id, 100)}`
          : "Launch draft only. No task is sent.",
        height: 1,
        flexShrink: 0,
        wrapMode: "none",
        truncate: true,
        fg: color.muted,
      }),
    )
    dialog.form.add(
      new TextRenderable(renderer, {
        content: label(`${target.model.providerID}/${target.model.id}`, 1024),
        height: 1,
        flexShrink: 0,
        wrapMode: "none",
        truncate: true,
        fg: color.text,
      }),
    )
    dialog.form.add(
      new TextRenderable(renderer, {
        content: recipient
          ? "Applies to subsequent turns. No prompt is sent."
          : "Select an advertised variant or the model default.",
        height: 1,
        flexShrink: 0,
        wrapMode: "none",
        truncate: true,
        fg: color.muted,
      }),
    )
    const select = new SelectRenderable(renderer, {
      height: 7,
      minHeight: 2,
      options: [],
      showDescription: false,
      showScrollIndicator: true,
      showSelectionIndicator: true,
      backgroundColor: color.panel,
      textColor: color.text,
      selectedBackgroundColor: color.selected,
      selectedTextColor: color.accent,
    })
    dialog.form.add(select)
    dialogs.track(dialog, select)
    let rows: (string | undefined)[] = []
    let ready = false
    let loading = false
    let intent: { variant: string | undefined; currentOnly: boolean } | undefined
    let unadvertised: string | undefined

    async function load() {
      if (loading || intent) return
      loading = true
      ready = false
      rows = []
      select.options = []
      dialog.error.content = "Loading variants (read-only)... Esc back"
      try {
        const catalog = await connection.providers.list(target.directory)
        if (state.closed || state.modal !== dialog) return
        const model = catalog.models.find(
          (item) => item.providerID === target.model.providerID && item.id === target.model.id,
        )
        if (!model) throw new Error("Model is not available in the connected catalog.")
        rows = [undefined, ...(model.variants ?? [])]
        unadvertised = target.current !== undefined && !rows.includes(target.current) ? target.current : undefined
        if (unadvertised !== undefined) rows.push(unadvertised)
        select.options = rows.map((variant) => ({
          name: `${variant === target.current ? "* " : "  "}${variant === undefined ? "Model default" : label(variant, 512)}${variant !== undefined && variant === unadvertised ? " (current only)" : ""}`,
          description: "",
        }))
        select.setSelectedIndex(Math.max(0, rows.indexOf(target.current)))
        ready = true
        dialog.error.content = "Up/Down choose - Enter / Ctrl+S select\nEsc back - Ctrl+R reload"
        select.focus()
      } catch (error) {
        if (state.closed || state.modal !== dialog) return
        dialog.error.height = 3
        dialog.error.content = `Cannot load variants: ${errorText(error)}\nCtrl+R retry - Esc back`
      } finally {
        loading = false
      }
    }

    dialog.submit = async () => {
      if (!ready) throw new Error("Variants are not loaded. Ctrl+R retry or Esc back.")
      if (!intent) {
        const variant = rows[select.getSelectedIndex()]
        intent = { variant, currentOnly: variant !== undefined && variant === unadvertised }
        if (!recipient && intent.currentOnly) {
          intent = undefined
          throw new Error("This variant is no longer advertised. Choose an available variant or Model default.")
        }
        // Mouse and native Select bindings must not visually change a frozen retry choice either.
        select.options = [{ name: label(intent.variant ?? "Model default", 512), description: "" }]
        select.setSelectedIndex(0)
      }
      await target.choose(intent.variant, intent.currentOnly)
    }
    dialog.key = (key) => {
      if (matchesKey(key, "r", { ctrl: true })) {
        void load()
        return true
      }
      if (matchesKey(key, "up") || matchesKey(key, "down")) {
        if (!intent) {
          if (key.name === "up") select.moveUp()
          else select.moveDown()
          dialogs.reveal(dialog, select)
        }
        return true
      }
      if (matchesKey(key, "enter")) {
        void dialogs.submit()
        return true
      }
      // Do not let modified navigation fall through to native Select bindings.
      return key.name === "up" || key.name === "down" || key.name === "enter"
    }
    void load()
  }

  function open() {
    const selected =
      state.tab === "sessions" ? state.snapshot?.sessions.find((session) => session.id === state.selected) : undefined
    if (!selected) return say("Select a session first.", true)
    if (!state.connected) return say("Reconnect before choosing a variant.", true)
    if (blocked(selected.id)) return say("Task-owned subagent: use its owning session. Nothing changed.", true)
    if (!selected.model) return say("This session has no known model. Choose a model first.", true)
    const session = structuredClone(selected)
    const model = { providerID: selected.model.providerID, id: selected.model.id }
    let attempted = false
    let acknowledged = false

    async function fresh() {
      if (state.closed || !state.connected) throw new Error("Reconnect before changing this session.")
      if (blocked(session.id)) throw new Error("Task-owned subagent: use its owning session. Nothing changed.")
      const current = await connection.client.sessions.get({ sessionID: session.id })
      if (state.closed || blocked(session.id)) throw new Error("Session is no longer available for this action.")
      if (
        current.id !== session.id ||
        current.projectID !== session.projectID ||
        current.parentID !== session.parentID ||
        current.subpath !== session.subpath ||
        current.time.created !== session.time.created ||
        current.location.directory !== session.location.directory ||
        current.location.workspaceID !== session.location.workspaceID
      )
        throw new Error("Session identity changed. Close and reopen this control.")
      if (current.model?.providerID !== model.providerID || current.model.id !== model.id)
        throw new Error("Model identity changed. Close and reopen this control.")
      return current
    }

    show(
      {
        directory: session.location.directory,
        model,
        current: session.model?.variant,
        choose: async (variant, currentOnly) => {
          let current = await fresh()
          const unchanged = current.model?.variant === variant
          if (currentOnly && !unchanged)
            throw new Error("This variant is no longer current or advertised. Close and reload the available choices.")
          if (!attempted && !unchanged) {
            attempted = true
            try {
              await connection.client.sessions.switchModel({
                sessionID: session.id,
                model: { ...model, ...(variant === undefined ? {} : { variant }) },
              })
              acknowledged = true
            } catch {
              throw new Error("Variant outcome unknown. Choice frozen; retry checks only. Esc to close and inspect.")
            }
            current = await fresh()
          }
          if (current.model?.variant !== variant)
            throw new Error(
              "Variant not confirmed. Choice frozen; retry checks only. Close and inspect before changing it.",
            )
          if (state.snapshot)
            state.snapshot.sessions = state.snapshot.sessions.map((item) => (item.id === session.id ? current : item))
          if (state.inspected?.id === session.id) state.inspected = current
          onUpdate(current)
          say(
            `${!attempted ? "Variant unchanged; no switch sent" : acknowledged ? "Variant confirmed" : "Variant observed after unconfirmed request"}: ${label(variant ?? "Model default", 512)}. Applies to subsequent turns.`,
          )
        },
      },
      session,
    )
  }

  return { open, pick }
}

export type ModelVariants = ReturnType<typeof createModelVariants>
