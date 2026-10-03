import { SelectRenderable, TextRenderable, type CliRenderer } from "@opentui/core"
import { errorText, type Connection, type Session } from "./server"
import { label, type DashboardState } from "./state"
import { color } from "./theme"
import type { Dialogs } from "./dialogs"
import { createModelConnections } from "./model-connections"
import { matchesKey } from "./keys"

export function createModels(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
  onUpdate: (session: Session) => void = () => {},
  blocked: (sessionID: string) => boolean = () => false,
) {
  const connections = createModelConnections(renderer, state, connection, dialogs, say)

  function pick(target: {
    directory: string
    current: string
    recipient?: Session
    choose: (model: string) => Promise<void> | void
    cancel?: () => void
  }) {
    if (state.closed || !dialogs.navigate()) return
    const dialog = dialogs.open("Choose model", false, 26)
    if (!dialog) return
    dialog.recipient = target.recipient
    dialog.form.add(
      new TextRenderable(renderer, {
        content: target.recipient
          ? `For: ${label(target.recipient.title || target.recipient.id, 80)}\n${target.recipient.id}\nApplies to subsequent turns, not the in-flight response.\nA different model uses its default variant.`
          : "For this launch draft. Selecting a model does not send the task.",
        fg: color.muted,
      }),
    )
    dialog.form.add(
      new TextRenderable(renderer, {
        content: `${label(target.directory, 150)}\nCurrent: ${target.recipient?.model ? modelIdentity(target.recipient.model) : label(target.current || "Server default", 150)}`,
        fg: color.text,
        marginBottom: 1,
      }),
    )
    const setup = () => {
      if (dialog.busy) return
      dialogs.close(false)
      connections.open(target.directory, () => pick(target))
    }
    dialog.form.add(
      new TextRenderable(renderer, {
        content: "+ Connect provider / add custom model  F2",
        fg: color.accent,
        marginBottom: 1,
        onMouseDown: (event) => {
          if (event.button !== 0) return
          event.preventDefault()
          setup()
        },
      }),
    )
    const query = dialogs.input(dialog, "Find a model or provider", "", "Type to filter connected models")
    query.maxLength = 256
    const select = new SelectRenderable(renderer, {
      height: 8,
      minHeight: 2,
      options: [],
      showDescription: true,
      showScrollIndicator: true,
      showSelectionIndicator: true,
      backgroundColor: color.panel,
      textColor: color.text,
      descriptionColor: color.muted,
      selectedBackgroundColor: color.selected,
      selectedTextColor: color.accent,
    })
    dialog.form.add(select)
    dialogs.track(dialog, select)
    let catalog: Awaited<ReturnType<Connection["providers"]["list"]>> | undefined
    let matches: { ref: string; name: string; description: string }[] = []
    let loading = false
    const update = () => {
      if (!catalog) return
      const selected = matches[select.getSelectedIndex()]?.ref
      const terms = query.value.toLowerCase().trim().split(/\s+/).filter(Boolean)
      const rows = [
        ...(!target.recipient
          ? [{ ref: "", name: "Server default", description: "Let the server select an available model" }]
          : []),
        ...catalog.models.map((model) => ({
          ref: `${model.providerID}/${model.id}`,
          name: `${model.name} (${model.providerName})`,
          description:
            `${model.providerID}/${model.id}` === target.current && target.recipient?.model
              ? modelIdentity(target.recipient.model)
              : `${model.providerID}/${model.id}`,
        })),
      ].filter((model) => terms.every((term) => `${model.name} ${model.description}`.toLowerCase().includes(term)))
      matches = rows.slice(0, 100)
      select.options = matches.map((model) => ({
        name: `${model.ref === target.current ? "* " : "  "}${label(model.name, 150)}`,
        description: label(model.description, 2048),
      }))
      select.setSelectedIndex(
        Math.max(
          0,
          matches.findIndex((model) => model.ref === selected),
        ),
      )
      dialog.error.content = !catalog.models.length
        ? "No connected models. F2 connects a provider.\nCtrl+R refresh catalog · Esc back"
        : !matches.length
          ? "No matching models. Change the search or F2 to connect.\nCtrl+R refresh catalog · Esc back"
          : `Up/Down choose · Enter select · Esc back\nF2 connect · Ctrl+R refresh${rows.length > 100 ? " · First 100; narrow search" : ""}`
    }
    const load = async () => {
      if (loading) return
      loading = true
      catalog = undefined
      matches = []
      select.options = []
      dialog.error.content = "Loading models... Esc back"
      try {
        const result = await connection.providers.list(target.directory)
        if (state.closed || state.modal !== dialog) return
        catalog = result
        update()
      } catch (error) {
        if (state.closed || state.modal !== dialog) return
        dialog.error.height = 3
        dialog.error.content = `Cannot load models: ${errorText(error)}\nCtrl+R retry · F2 provider setup · Esc back`
      } finally {
        loading = false
      }
    }
    const choose = async () => {
      const model = matches[select.getSelectedIndex()]
      if (!model || dialog.busy) return
      dialog.busy = true
      dialog.error.content = "Selecting model..."
      try {
        // Only session selection mutates the server. Draft selection is local.
        if (target.recipient) await target.choose(model.ref)
        if (state.closed || state.modal !== dialog) return
        dialog.busy = false
        dialogs.close(false)
        if (!target.recipient) await target.choose(model.ref)
      } catch (error) {
        if (state.closed || state.modal !== dialog) return
        dialog.busy = false
        dialog.error.height = 3
        dialog.error.content = `Could not select model: ${errorText(error)}\nEnter retry · Esc back`
      }
    }
    query.on("input", update)
    select.on("itemSelected", () => void choose())
    dialog.key = (key) => {
      if (matchesKey(key, "f2")) {
        setup()
        return true
      }
      if (matchesKey(key, "r", { ctrl: true })) {
        void load()
        return true
      }
      if (matchesKey(key, "up") || matchesKey(key, "down")) {
        if (key.name === "up") select.moveUp()
        if (key.name === "down") select.moveDown()
        dialogs.reveal(dialog, select)
        return true
      }
      if (!matchesKey(key, "enter")) return false
      void choose()
      return true
    }
    // Navigation may leave the picker; only explicit Back reopens the draft.
    dialog.allowNavigation = true
    dialog.back = target.cancel
    query.focus()
    void load()
  }

  function open() {
    if (!dialogs.navigate()) return
    if (!state.connected || !state.snapshot) return say("Connect to the server before choosing a model.", true)
    const session =
      state.tab === "sessions" ? state.snapshot.sessions.find((item) => item.id === state.selected) : undefined
    if (!session) return connections.open(state.snapshot.location.directory, () => {})
    if (blocked(session.id)) return say("Task-owned subagent: choose a model in its owning session.", true)
    pick({
      directory: session.location.directory,
      current: session.model ? `${session.model.providerID}/${session.model.id}` : "",
      recipient: session,
      choose: async (value) => {
        if (blocked(session.id)) throw new Error("Task-owned subagent: use its owning session.")
        // Another client may have changed the model or variant while the picker was open.
        const current = await connection.client.sessions.get({ sessionID: session.id })
        if (state.closed) return
        if (blocked(session.id)) throw new Error("Task-owned subagent: use its owning session.")
        const slash = value.indexOf("/")
        const model = { providerID: value.slice(0, slash), id: value.slice(slash + 1) }
        const unchanged = current.model?.providerID === model.providerID && current.model.id === model.id
        if (!unchanged) await connection.client.sessions.switchModel({ sessionID: session.id, model })
        if (state.closed) return
        const updated = { ...current, model: unchanged ? current.model : model }
        if (state.snapshot)
          state.snapshot.sessions = state.snapshot.sessions.map((item) => (item.id === session.id ? updated : item))
        if (state.inspected?.id === updated.id) state.inspected = updated
        onUpdate(updated)
        if (unchanged) {
          say(
            `Model unchanged: ${modelIdentity(current.model)}. No switch sent for ${label(current.title || current.id, 80)}.`,
          )
          return
        }
        say(
          `${current.model?.variant && current.model.variant !== "default" ? "Variant reset to model default. " : ""}Model selected for ${label(current.title || current.id, 80)}: ${value}. Applies to subsequent turns.`,
        )
      },
    })
  }

  function connect() {
    if (!dialogs.navigate()) return
    if (!state.connected || !state.snapshot) return say("Connect to the server before adding a provider.", true)
    const directory =
      state.snapshot.sessions.find((item) => item.id === state.selected)?.location.directory ??
      state.snapshot.location.directory
    connections.open(directory, open)
  }

  return { pick, open, connect }
}

function modelIdentity(model: NonNullable<Session["model"]>) {
  return label(`${model.providerID}/${model.id} (variant: ${model.variant ?? "default"})`, 2048)
}

export type Models = ReturnType<typeof createModels>
