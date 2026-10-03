import type { InputRenderable, TextRenderable } from "@opentui/core"
import type { Session } from "../server"
import type { ModalState } from "../state"
import type { MenuContext } from "./context"

export type Scope = "recent" | "all" | "archived"

export type ScopeButton = { value: Scope; button: TextRenderable }

/** Everything the session switcher changes while its dialog is open. */
export type Switcher = {
  ctx: MenuContext
  dialog: ModalState
  sidebar: boolean
  /** Loaded sessions the recent scope searches locally. */
  sessions: Session[]
  query: InputRenderable
  scopeButtons: ScopeButton[]
  details: TextRenderable
  scope: Scope
  remote: Session[]
  cursors: { next?: string | null; previous?: string | null }
  loading: boolean
  failure: string
  version: number
  searchTimer: ReturnType<typeof setTimeout> | undefined
  controller: AbortController | undefined
  matches: Session[]
  selected: number
  rows: TextRenderable[]
  headings: TextRenderable[]
  offsets: number[]
}
