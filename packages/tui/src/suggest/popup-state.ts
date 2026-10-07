import { TextRenderable, type CliRenderer, type TextareaRenderable } from "@opentui/core"
import type { DashboardState, ModalState } from "../state"
import { color } from "../theme"

export type Trigger = { query: string; start: number; end: number }

export type PopupOptions<T> = {
  id: string
  dialog: ModalState
  editor: TextareaRenderable
  locked: () => boolean
  rows: (count: number) => void
  match: (text: string, cursor: number) => Trigger | undefined
  scope: (query: string) => string
  load: (query: string, signal: AbortSignal) => Promise<readonly T[]>
  debounce?: number
  /** How many choices the popup lists at once; three when absent. */
  window?: () => number
  filter: (items: readonly T[], query: string) => T[]
  /** One list row without its two-column marker; `width` is the columns left for it. */
  line: (item: T, width: number) => string
  messages: { loading: string; error: string; empty?: string | ((query: string) => string) }
}

/** Everything one popup mutates; the operations in `popup-ops` and `refresh` take it explicitly. */
export type PopupState<T> = {
  app: Pick<DashboardState, "modal" | "closed">
  options: PopupOptions<T>
  suggestions: TextRenderable
  generation: number
  status: "idle" | "loading" | "ready" | "error"
  inventory: readonly T[]
  choices: T[]
  selected: number
  query: string
  scope: string
  trigger: Trigger
  rows: number
  /** The editor text an Esc closed the list for; the list stays closed until the text changes. */
  dismissed: string | undefined
  timer: ReturnType<typeof setTimeout> | undefined
  pending: AbortController | undefined
  /** Runs once when the inventory arrives, so a key pressed while it loads is not lost. */
  afterLoad: (() => void) | undefined
}

export function createPopupState<T>(
  renderer: CliRenderer,
  app: Pick<DashboardState, "modal" | "closed">,
  options: PopupOptions<T>,
): PopupState<T> {
  const suggestions = new TextRenderable(renderer, {
    id: options.id,
    content: "",
    visible: false,
    height: 1,
    maxHeight: 9,
    flexShrink: 0,
    wrapMode: "none",
    fg: color.muted,
    selectable: false,
  })
  options.dialog.form.add(suggestions, options.dialog.form.getChildren().indexOf(options.editor) + 1)
  return {
    app,
    options,
    suggestions,
    generation: 0,
    status: "idle",
    inventory: [],
    choices: [],
    selected: 0,
    query: "",
    scope: "",
    trigger: { query: "", start: 0, end: 0 },
    rows: 0,
    dismissed: undefined,
    timer: undefined,
    pending: undefined,
    afterLoad: undefined,
  }
}
