import { SelectRenderable, TextRenderable, type CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import type { AuthMethod } from "./providers"
import type { Connection } from "./server"
import { label, type DashboardState, type ModalState } from "./state"
import { color } from "./theme"
import { matchesKey } from "./keys"
import { secretField } from "./secret-field"

export function createModelConnections(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
) {
  function open(directory: string, done: () => void): void {
    if (state.modal || state.closed) return
    const controller = new AbortController()
    const answers = new Map<string, string>()
    controller.signal.addEventListener("abort", () => answers.clear(), { once: true })
    let current: ModalState | undefined

    function close() {
      current = undefined
      dialogs.close(false)
    }

    function show(title: string, height = 26) {
      if (state.closed || controller.signal.aborted || (state.modal && state.modal !== current)) return
      if (current) close()
      const dialog = dialogs.open(title, false, height)
      if (!dialog) return
      current = dialog
      dialog.frame.add(
        new TextRenderable(renderer, {
          content: `Server-global credentials and configuration\nServer: ${label(URL.parse(connection.address)?.origin ?? "Unknown server", 512)}`,
          fg: color.muted,
          flexShrink: 0,
          wrapMode: "word",
        }),
        0,
      )
      dialog.box.once("destroyed", () => {
        if (current !== dialog) return
        current = undefined
        controller.abort()
        // Escape is handled by dialogs before dialog.key. Destruction cancels
        // waiting OAuth without marking the modal busy or persisting a draft.
        queueMicrotask(() => {
          if (!state.closed && !renderer.isDestroyed && !state.modal) done()
        })
      })
      return dialog
    }

    function finish(message: string, error = false) {
      close()
      controller.abort()
      done()
      say(message, error)
    }

    function wait<T>(title: string, work: () => Promise<T>, next: (result: T) => void, instructions = "") {
      const dialog = show(title, 28)
      if (!dialog) return
      dialog.form.add(
        new TextRenderable(renderer, { content: instructions || title, fg: color.text, wrapMode: "word" }),
      )
      dialog.error.content = "Esc cancel waiting; a request already sent may still save on the server."
      dialog.form.focus()
      void (async () => {
        try {
          const result = await work()
          if (state.closed || controller.signal.aborted || state.modal !== dialog) return
          next(result)
        } catch (error) {
          if (state.closed || controller.signal.aborted || state.modal !== dialog) return
          answers.clear()
          // Only recognize fixed adapter messages, never display an exception
          // body that could contain a credential or an OAuth response.
          const partial =
            "Provider configuration was saved, but the API key could not be confirmed. Refresh providers and reconnect this provider before retrying."
          const message =
            error instanceof Error && error.message === partial
              ? partial
              : "Provider request could not be confirmed. Check the connection and entered settings. Refresh providers before retrying."
          dialog.error.content = `${message}\nEnter refresh providers | Esc return to models`
          dialog.error.fg = color.error
          dialog.error.height = 5
          dialog.key = (key) => {
            if (!matchesKey(key, "enter")) return false
            load()
            return true
          }
        }
      })()
    }

    function saved() {
      wait(
        "Checking model availability",
        () =>
          connection.providers.list(directory).then(
            () => true,
            () => false,
          ),
        (checked) =>
          finish(
            checked
              ? "Provider saved; availability checked by catalog, not an upstream key test."
              : "Provider saved; catalog refresh failed. The upstream key was not tested.",
            !checked,
          ),
      )
    }

    function choose(
      dialog: ModalState,
      choices: { name: string; description: string; run: () => void }[],
      searchable = false,
    ) {
      const query = searchable ? dialogs.input(dialog, "Find a provider", "", "Name or provider ID") : undefined
      if (query) query.maxLength = 256
      let matches = choices
      const select = new SelectRenderable(renderer, {
        height: Math.min(12, Math.max(2, choices.length * 2)),
        minHeight: 2,
        options: choices,
        showDescription: true,
        showSelectionIndicator: false,
        showScrollIndicator: true,
        backgroundColor: color.panel,
        textColor: color.text,
        descriptionColor: color.muted,
        focusedBackgroundColor: color.selected,
        focusedTextColor: color.text,
        selectedBackgroundColor: color.accent,
        selectedTextColor: color.bg,
        selectedDescriptionColor: color.bg,
      })
      dialog.form.add(select)
      dialogs.track(dialog, select)
      const update = () => {
        const selected = matches[select.getSelectedIndex()]
        const terms = query?.value.toLowerCase().trim().split(/\s+/).filter(Boolean) ?? []
        matches = choices.filter((choice) =>
          terms.every((term) => `${choice.name} ${choice.description}`.toLowerCase().includes(term)),
        )
        select.options = matches
        select.setSelectedIndex(Math.max(0, selected ? matches.indexOf(selected) : 0))
        dialog.error.content = matches.length
          ? "Up/Down choose | Enter continue | Tab focus | Esc return to models"
          : "No matches. Clear the search to see providers and custom setup."
      }
      const pick = () => {
        if (state.modal === dialog) matches[select.getSelectedIndex()]?.run()
      }
      query?.on("input", update)
      dialog.key = (key) => {
        if (matchesKey(key, "up") || matchesKey(key, "down")) {
          if (key.name === "up") select.moveUp()
          if (key.name === "down") select.moveDown()
          dialogs.reveal(dialog, select)
          return true
        }
        if (!matchesKey(key, "enter")) return false
        pick()
        return true
      }
      select.on("itemSelected", pick)
      update()
      ;(query ?? select).focus()
    }

    function load() {
      answers.clear()
      wait(
        "Loading providers",
        () => connection.providers.list(directory),
        (catalog) => {
          const dialog = show("Connect a provider")
          if (!dialog) return
          choose(
            dialog,
            [
              { name: "+ Add custom provider", description: "OpenAI-compatible endpoint and model", run: custom },
              ...catalog.providers.map((provider) => ({
                name: label(provider.name, 512),
                description: `${label(provider.id, 256)}${provider.connected ? " | connected; replace credentials" : " | not connected"}`,
                run: () =>
                  wait(
                    "Loading authentication methods",
                    () => connection.providers.auth(directory),
                    (auth) => {
                      const dialog = show(`Connect ${label(provider.name, 80)}`)
                      if (!dialog) return
                      // Use the original advertised index, even when methods share a type.
                      choose(
                        dialog,
                        (auth[provider.id] ?? [{ type: "api" as const, label: "API key" }]).map((method, index) => ({
                          name: label(method.label, 512),
                          description: method.type === "api" ? "API key" : "OAuth | browser or headless instructions",
                          run: () => prompt(provider.id, method, index, 0),
                        })),
                      )
                      if (auth[provider.id]?.length === 0)
                        dialog.error.content =
                          "No authentication methods advertised for this provider. Esc return to models."
                    },
                  ),
              })),
            ],
            true,
          )
        },
      )
    }

    function prompt(providerID: string, method: AuthMethod, index: number, offset: number) {
      const item = method.prompts?.[offset]
      if (!item) {
        if (method.type === "api") {
          const dialog = show("Save API key")
          if (!dialog) return
          const key = secret(dialog, "API key (hidden)")
          dialog.error.content = "Enter save | Ctrl+U clear | Esc cancel (no draft)"
          dialog.key = (event) => {
            if (!matchesKey(event, "enter")) return false
            const value = key()
            if (!credential(dialog, value)) return true
            const metadata = answers.size ? Object.fromEntries(answers) : undefined
            answers.clear()
            wait(
              "Saving provider credentials",
              () => connection.providers.connectKey(providerID, value, metadata, controller.signal),
              saved,
            )
            return true
          }
          return
        }
        const inputs = Object.fromEntries(answers)
        answers.clear()
        wait(
          "Starting OAuth",
          () => connection.providers.authorize(directory, providerID, index, inputs, controller.signal),
          (auth) => {
            const instructions = `Open this URL in a browser (on another device if headless):\n${auth.url}\n\n${auth.instructions}\n\nFor a remote server, a loopback browser redirect may need SSH port forwarding to that server. No browser is launched by this TUI.`
            if (auth.method === "auto") {
              wait(
                "Waiting for OAuth",
                () => connection.providers.complete(directory, providerID, index, undefined, controller.signal),
                saved,
                instructions,
              )
              return
            }
            const dialog = show("Complete OAuth", 30)
            if (!dialog) return
            dialog.form.add(new TextRenderable(renderer, { content: instructions, fg: color.text, wrapMode: "word" }))
            const code = secret(dialog, "Authorization code (hidden)")
            dialog.error.content = "Page Up/Down instructions | Enter complete | Ctrl+U clear | Esc cancel"
            dialog.key = (event) => {
              if (!matchesKey(event, "enter")) return false
              const value = code()
              if (!credential(dialog, value)) return true
              wait(
                "Completing OAuth",
                () => connection.providers.complete(directory, providerID, index, value, controller.signal),
                saved,
              )
              return true
            }
          },
        )
        return
      }
      if (item.when) {
        const value = answers.get(item.when.key)
        if (value === undefined || (item.when.op === "eq" ? value !== item.when.value : value === item.when.value)) {
          prompt(providerID, method, index, offset + 1)
          return
        }
      }
      const dialog = show(label(method.label, 80))
      if (!dialog) return
      const next = (value: string) => {
        answers.set(item.key, value)
        prompt(providerID, method, index, offset + 1)
      }
      if (item.type === "select") {
        dialog.form.add(new TextRenderable(renderer, { content: item.message, fg: color.text }))
        choose(
          dialog,
          item.options.map((option) => ({
            name: option.label,
            description: option.hint ?? "",
            run: () => next(option.value),
          })),
        )
        if (!item.options.length) dialog.error.content = "No options advertised for this prompt. Esc cancel."
        return
      }
      const value = secret(dialog, `${item.message} (hidden)`, 4096, item.placeholder)
      dialog.error.content = "Enter continue (empty allowed) | Ctrl+U clear | Esc cancel"
      dialog.key = (event) => {
        if (!matchesKey(event, "enter")) return false
        next(value())
        return true
      }
    }

    function custom() {
      const dialog = show("Add OpenAI-compatible provider", 30)
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
      const key = secret(dialog, "API key (optional, hidden)")
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
        wait("Saving custom provider", () => connection.providers.addCustom(input, directory, controller.signal), saved)
        return true
      }
      providerID.focus()
    }

    load()
  }

  function secret(dialog: ModalState, title: string, limit = 8192, placeholder = "") {
    dialog.form.add(new TextRenderable(renderer, { content: title, fg: color.muted }))
    const { field, take } = secretField(renderer, {
      limit,
      placeholder,
      reject: () => {
        dialog.error.content = `Input rejected: at most ${limit} characters; no control characters. Ctrl+U clears.`
        dialog.error.fg = color.error
      },
    })
    dialog.form.add(field)
    dialogs.track(dialog, field)
    field.focus()
    return take
  }

  function credential(dialog: ModalState, value: string) {
    if (value.trim() && value === value.trim()) return true
    dialog.error.content = "Enter a credential without surrounding whitespace. The hidden field was cleared."
    dialog.error.fg = color.error
    return false
  }

  return { open }
}
