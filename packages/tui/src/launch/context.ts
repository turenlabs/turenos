import type { InputRenderable, CliRenderer, SelectRenderable, TextRenderable } from "@opentui/core"
import type { Dialogs } from "../dialogs"
import type { Mentions } from "../mentions"
import type { ModelVariants } from "../model-variants"
import type { Models } from "../models"
import type { Connection, Session } from "../server"
import type { SlashCommands } from "../slash"
import type { DashboardState, LaunchDraft, ModalState } from "../state"

/** Collaborators the launch dialog talks to. */
export type LaunchDeps = {
  renderer: CliRenderer
  state: DashboardState
  connection: Connection
  dialogs: Dialogs
  say: (message: string, error?: boolean) => void
  openSession: (id: string, inspect?: boolean, session?: Session) => void
  models: Models
  slash: SlashCommands
  variants: ModelVariants
  mentions: Mentions
}

/** What survives between dialog openings: the kept draft and the last launched agent/model. */
export type LaunchStore = {
  draft?: LaunchDraft
  /** The settings fields were opened, so the dialog reopens with them showing. */
  settings?: boolean
  defaults?: Pick<LaunchDraft, "directory" | "agent" | "model" | "variant">
}

/** One open launch dialog: its widgets, the draft it edits and the agent-discovery state. */
export type LaunchForm = {
  deps: LaunchDeps
  store: LaunchStore
  reopen: () => void
  dialog: ModalState
  current: LaunchDraft
  task: ReturnType<Dialogs["prompt"]>
  directory: InputRenderable
  agent: SelectRenderable
  model: InputRenderable
  workspace: SelectRenderable
  context: TextRenderable
  choices: string[]
  loaded: string | undefined
  loadError: unknown
  loading: Promise<void> | undefined
  /** Set while a worktree is being prepared; aborting it stops the wait and keeps the draft. */
  preparing?: AbortController
  /** The escaping mention paths the user already saw and sent past once. */
  outsideAck?: string
}
