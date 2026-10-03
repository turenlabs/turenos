import { TextRenderable, type CliRenderer, type KeyEvent, type TextareaRenderable } from "@opentui/core"
import { matchesKey } from "./keys"
import type { DashboardState, ModalState } from "./state"
import { color } from "./theme"

export type Trigger = { query: string; start: number; end: number }

/**
 * The shared editor-completion popup: a bounded three-row list under a prompt
 * editor, backed by a generation-guarded async inventory. Callers supply what
 * activates it and how results are named; accepting a choice stays with the
 * caller because command admission and path completion resolve differently.
 */
export function createSuggestionPopup<T>(
  renderer: CliRenderer,
  state: Pick<DashboardState, "modal" | "closed">,
  options: {
    id: string
    dialog: ModalState
    editor: TextareaRenderable
    locked: () => boolean
    rows: (count: number) => void
    match: (text: string, cursor: number) => Trigger | undefined
    scope: (query: string) => string
    load: (query: string, signal: AbortSignal) => Promise<readonly T[]>
    debounce?: number
    filter: (items: readonly T[], query: string) => T[]
    line: (item: T) => string
    messages: { loading: string; error: string; empty?: string }
  },
) {
  const { dialog, editor } = options
  const suggestions = new TextRenderable(renderer, {
    id: options.id,
    content: "",
    visible: false,
    height: 1,
    maxHeight: 3,
    flexShrink: 0,
    wrapMode: "none",
    fg: color.muted,
    selectable: false,
  })
  dialog.form.add(suggestions, dialog.form.getChildren().indexOf(editor) + 1)

  let generation = 0
  let status: "idle" | "loading" | "ready" | "error" = "idle"
  let inventory: readonly T[] = []
  let choices: T[] = []
  let selected = 0
  let query = ""
  let scope = ""
  let trigger: Trigger = { query: "", start: 0, end: 0 }
  let rows = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: AbortController | undefined

  // A superseded query is aborted, not merely ignored, so a fast typist cannot
  // leave recursive server searches running to completion.
  function cancelPending() {
    clearTimeout(timer)
    timer = undefined
    pending?.abort()
    pending = undefined
  }

  function show(count: number) {
    suggestions.visible = count > 0
    suggestions.height = Math.max(1, count)
    if (rows === count) return
    rows = count
    options.rows(count)
  }

  function usable() {
    return (
      !state.closed &&
      state.modal === dialog &&
      !dialog.busy &&
      !options.locked() &&
      !editor.isDestroyed &&
      !suggestions.isDestroyed
    )
  }

  function hide() {
    generation++
    cancelPending()
    if (status === "loading") status = "idle"
    if (!suggestions.isDestroyed) show(0)
  }

  function dismiss() {
    generation++
    cancelPending()
    status = "idle"
    show(0)
  }

  function paint() {
    const start = Math.max(0, selected - 2)
    const lines = choices.slice(start, start + 3).map((item, index) => {
      return `${start + index === selected ? ">" : " "} ${options.line(item)}`
    })
    suggestions.content = lines.join("\n")
    show(lines.length)
  }

  function refresh() {
    if (!usable()) return hide()
    const next = options.match(editor.plainText, editor.cursorOffset)
    if (!next) {
      show(0)
      if (status !== "ready") {
        generation++
        status = "idle"
      }
      return
    }
    trigger = next
    if (query !== next.query) selected = 0
    query = next.query
    const nextScope = options.scope(query)
    if (nextScope !== scope) {
      scope = nextScope
      generation++
      cancelPending()
      status = "idle"
      inventory = []
    }
    if (status === "idle") {
      status = "loading"
      const request = ++generation
      cancelPending()
      const controller = (pending = new AbortController())
      const start = () =>
        void Promise.resolve()
          .then(() => options.load(query, controller.signal))
          .then((items) => {
            if (request !== generation) return
            if (!usable()) return hide()
            if (options.scope(query) !== scope) return refresh()
            inventory = items
            status = "ready"
            refresh()
          })
          .catch(() => {
            if (request !== generation) return
            if (!usable()) return hide()
            status = "error"
            refresh()
          })
      if (options.debounce) timer = setTimeout(start, options.debounce)
      else start()
    }
    if (status !== "ready") {
      choices = []
      suggestions.content = status === "error" ? options.messages.error : options.messages.loading
      show(1)
      return
    }
    choices = options.filter(inventory, query)
    if (!choices.length && options.messages.empty) {
      suggestions.content = options.messages.empty
      show(1)
      return
    }
    selected = Math.min(selected, Math.max(0, choices.length - 1))
    paint()
  }

  const previous = editor.onContentChange
  editor.onContentChange = (event) => {
    previous?.(event)
    refresh()
  }

  return {
    refresh,
    hide,
    dismiss,
    usable,
    move(event: KeyEvent) {
      const up = matchesKey(event, "up")
      if (!up && !matchesKey(event, "down")) return false
      event.preventDefault()
      selected = (selected + (up ? -1 : 1) + choices.length) % choices.length
      paint()
      return true
    },
    replace(text: string, cursor: number) {
      editor.setText(editor.plainText.slice(0, trigger.start) + text + editor.plainText.slice(trigger.end))
      editor.cursorOffset = trigger.start + cursor
    },
    get visible() {
      return suggestions.visible
    },
    get status() {
      return status
    },
    get choices(): readonly T[] {
      return choices
    },
    get current() {
      return choices[selected]
    },
    get query() {
      return query
    },
  }
}

export type SuggestionPopup<T> = ReturnType<typeof createSuggestionPopup<T>>
