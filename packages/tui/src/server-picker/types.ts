import type {
  BoxRenderable,
  CliRenderer,
  InputRenderable,
  KeyEvent,
  ScrollBoxRenderable,
  TextRenderable,
} from "@opentui/core"
import type { Entry, Servers, Target } from "../servers"

export type Tone = "muted" | "warning" | "error"

export type Hooks = {
  current: () => { target: Target; connected: boolean } | undefined
  drafts: () => number
  connect: (target: Target, signal: AbortSignal, progress: (text: string) => void) => Promise<void>
  closed: () => void
  quit: () => void
}

export type View = {
  overlay: BoxRenderable
  frame: BoxRenderable
  logo: TextRenderable
  heading: TextRenderable
  list: ScrollBoxRenderable
  fields: BoxRenderable
  status: TextRenderable
  keys: TextRenderable
  rows: TextRenderable[]
}

/** Everything one server picker remembers; the flow modules operate on it. */
export type Picker = {
  renderer: CliRenderer
  servers: Servers
  hooks: Hooks
  view: View | undefined
  entries: Entry[]
  selected: number
  mode: "list" | "connecting" | "add" | "password"
  controller: AbortController | undefined
  /** The server the next scan puts the cursor on; set when the picker opens. */
  focusID: string | undefined
  /** Where Esc returns instead of closing to the dashboard, when another menu opened the picker. */
  back: (() => void) | undefined
  armed: { action: "switch" | "remove" | "quit"; id: string; until: number } | undefined
  scanning: ReturnType<typeof setInterval> | undefined
  form: { inputs: InputRenderable[]; index: number } | undefined
  secret: { target: Target; field: InputRenderable; take: () => string } | undefined
  visited: Map<string, Extract<Target, { kind: "url" }>>
  /** Registered on the renderer while open, and released in close(). */
  listeners: { keypress: (key: KeyEvent) => void; resize: () => void }
  /** Chooses the selected entry; set by the picker so row clicks need not import the flow that handles them. */
  choose: () => void
}
