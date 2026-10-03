import type { CliRenderer, KeyEvent, TextareaRenderable } from "@opentui/core"
import { matchesKey } from "./keys"
import { display } from "./messages"
import type { DashboardState, ModalState } from "./state"
import { createSuggestionPopup } from "./suggest"

type Command = { name: string; description?: string }
type Choice = Command & { local: boolean }
type Location = { directory: string; workspaceID?: string }

export function createSlashCommands(
  renderer: CliRenderer,
  state: Pick<DashboardState, "modal" | "closed">,
  connection: { commands: (directory: string, workspaceID?: string) => Promise<readonly Command[]> },
  localCommands: () => { name: string; description: string; run: () => void }[],
  runLocal: (name: string, dialog: ModalState, editor: TextareaRenderable) => void,
  onChange: () => void = () => {},
) {
  let controller: { key: (event: KeyEvent) => boolean } | undefined
  let current: ReturnType<typeof createSuggestionPopup<Choice>> | undefined

  function attach(dialog: ModalState, editor: TextareaRenderable, location: () => Location, locked = () => false) {
    current?.hide()
    const popup = createSuggestionPopup<Choice>(renderer, state, {
      id: `${editor.id}-slash`,
      dialog,
      editor,
      locked,
      rows: (count) => {
        dialog.suggestionRows = count
        onChange()
      },
      match(text) {
        const prefix = /^\/([^\s/]*)[ \t]*$/.exec(text)
        if (!prefix || prefix[0] !== text) return undefined
        return { query: prefix[1]!, start: 0, end: text.length }
      },
      scope: () => JSON.stringify([location().directory, location().workspaceID]),
      async load() {
        const items = await connection.commands(location().directory, location().workspaceID)
        if (!Array.isArray(items) || items.length > 2048) throw new Error("Invalid command inventory")
        return items.filter(validName).map((item) => ({ ...item, local: false }))
      },
      filter(items, query) {
        const merged = new Map(items.map((item) => [item.name, item]))
        for (const item of localCommands().filter(validName)) {
          if (!merged.has(item.name))
            merged.set(item.name, { name: item.name, description: item.description, local: true })
        }
        return [...merged.values()].filter((item) => item.name.startsWith(query))
      },
      line: (item) => `/${item.name} - ${display(item.description ?? "", 120).replace(/\s/g, " ")}`,
      messages: {
        loading: "Loading commands...",
        error: "Commands unavailable. Retype / to retry; your draft is kept.",
      },
    })
    current = popup

    function complete(chosen: Choice) {
      popup.replace(`/${chosen.name} `, chosen.name.length + 2)
      popup.refresh()
    }

    // Mouse Send and modified submit keys must admit local actions exactly as
    // Enter does, so submission routes through here rather than the key handler.
    function submit() {
      if (!popup.usable()) return false
      popup.refresh()
      if (!popup.visible) return false
      if (popup.status === "loading") return true
      if (popup.status !== "ready" || !popup.choices.length) return false
      const exact = popup.choices.find((item) => item.name === popup.query)
      if (exact && !exact.local) return false
      if (exact) runLocal(exact.name, dialog, editor)
      else complete(popup.current!)
      return true
    }
    // Chain rather than assign: several controllers attach to the same editor
    // and none of them may depend on attach order.
    const previousSubmit = dialog.beforeSubmit
    dialog.beforeSubmit = () => submit() || (previousSubmit?.() ?? false)

    return {
      key(event: KeyEvent) {
        if (!popup.usable()) {
          popup.hide()
          return false
        }
        if (!editor.focused) return false
        popup.refresh()
        if (!popup.visible) return false
        const enter = matchesKey(event, "enter")
        const tab = matchesKey(event, "tab")
        if (!enter && !tab && !matchesKey(event, "up") && !matchesKey(event, "down")) return false
        // Do not send a partial command or run a colliding local action while
        // discovery is pending.
        if (popup.status === "loading") {
          if (!enter && !tab) return false
          event.preventDefault()
          return true
        }
        if (popup.status !== "ready" || !popup.choices.length) return false
        if (enter) return submit()
        if (popup.move(event)) return true
        event.preventDefault()
        complete(popup.current!)
        return true
      },
    }
  }

  function validName(item: Command) {
    // Reject unsafe names rather than rewriting the command that would be submitted.
    return (
      typeof item?.name === "string" &&
      item.name.length <= 120 &&
      /^[^\s/]+$/.test(item.name) &&
      display(item.name, 120) === item.name &&
      (item.description === undefined || typeof item.description === "string")
    )
  }

  return {
    attach(dialog: ModalState, editor: TextareaRenderable, location: () => Location, locked = () => false) {
      controller = attach(dialog, editor, location, locked)
    },
    key: (event: KeyEvent) => controller?.key(event) ?? false,
  }
}

export type SlashCommands = ReturnType<typeof createSlashCommands>
