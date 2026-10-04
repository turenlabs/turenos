import type { CliRenderer, KeyEvent, PasteEvent } from "@opentui/core"
import type { Connection, Session } from "../server"
import type { DashboardState, Tab } from "../state"
import type { DashboardLayout } from "../layout"
import type { createContextLimits } from "../context-meter"
import type { createCopyControls } from "../copy"
import type { createConversation } from "../conversation"
import type { createLiveSession } from "../live-session"
import type { createDialogs } from "../dialogs"
import type { createSlashCommands } from "../slash"
import type { createMentions } from "../mentions"
import type { createRequests } from "../requests"
import type { createRewindControls } from "../rewind"
import type { createSessionControls } from "../session-controls"
import type { createModelVariants } from "../model-variants"
import type { createGoalControls } from "../goal-controls"
import type { createHarnessControls } from "../harness"
import type { createQueueControls } from "../queue"
import type { createChanges } from "../changes"
import type { createFiles } from "../files"
import type { createTerminals } from "../terminals"
import type { createSwarmRoom } from "../swarm"
import type { createAutomations } from "../automations"
import type { createExtensions } from "../extensions"
import type { createMemories } from "../memories"
import type { createIntel } from "../intel"
import type { createInspect } from "../inspect"
import type { createSettings } from "../settings"
import type { createModels } from "../models"
import type { createLaunch } from "../launch"
import type { createSessionActions } from "../session-actions"
import type { createMenus } from "../menus"

export type DashboardOptions = {
  /** The connected server, shown in the header. */
  server?: string
  /** Opens the server picker; its absence hides server switching. */
  servers?: (back?: () => void) => void
  /** True while another surface, such as the server picker, owns the keyboard. */
  blocked?: () => boolean
}

/** The renderer listeners one dashboard registers; `dispose` releases every one of them. */
export type Listeners = {
  keypress: (key: KeyEvent) => void
  paste: (event: PasteEvent) => void
  resize: () => void
  dispose: () => void
}

/** Everything a dashboard changes after it is mounted, apart from the shared `DashboardState`. */
export type Runtime = {
  /** The next reconciliation poll. */
  timer: ReturnType<typeof setTimeout> | undefined
  /** The in-flight snapshot refresh, joined by every concurrent caller. */
  refreshing: Promise<void> | undefined
  noticeTimer: ReturnType<typeof setTimeout> | undefined
  noticeMessage: string
  activityTimer: ReturnType<typeof setInterval> | undefined
  activityStep: number
  /** True while `renderList` resets the list selection, so its own events are ignored. */
  renderingList: boolean
  /** Until this time a second quit key confirms the quit. */
  quitArmedUntil: number
  disposed: boolean
  /** The selection and search of each tab, restored when switching back. */
  views: Map<Tab, { selected: string; query: string }>
  listeners: Listeners | undefined
}

/** The feature controllers, installed group by group in `createControls`; callbacks read them lazily. */
export type Controls = {
  limits: ReturnType<typeof createContextLimits>
  copy: ReturnType<typeof createCopyControls>
  conversation: ReturnType<typeof createConversation>
  live: ReturnType<typeof createLiveSession>
  dialogs: ReturnType<typeof createDialogs>
  slash: ReturnType<typeof createSlashCommands>
  mentions: ReturnType<typeof createMentions>
  requests: ReturnType<typeof createRequests>
  rewind: ReturnType<typeof createRewindControls>
  controls: ReturnType<typeof createSessionControls>
  variants: ReturnType<typeof createModelVariants>
  goals: ReturnType<typeof createGoalControls>
  harness: ReturnType<typeof createHarnessControls>
  queue: ReturnType<typeof createQueueControls>
  changes: ReturnType<typeof createChanges>
  files: ReturnType<typeof createFiles>
  terminals: ReturnType<typeof createTerminals>
  room: ReturnType<typeof createSwarmRoom>
  automations: ReturnType<typeof createAutomations>
  extensions: ReturnType<typeof createExtensions>
  memories: ReturnType<typeof createMemories>
  intel: ReturnType<typeof createIntel>
  inspect: ReturnType<typeof createInspect>
  settings: ReturnType<typeof createSettings>
  models: ReturnType<typeof createModels>
  launch: ReturnType<typeof createLaunch>
  sessions: ReturnType<typeof createSessionActions>
  menus: ReturnType<typeof createMenus>
}

/** The explicit state every dashboard module operates on. */
export type DashboardContext = {
  renderer: CliRenderer
  connection: Connection
  state: DashboardState
  ui: DashboardLayout
  options: DashboardOptions
  /** The address shown in the details dialog, prefixed by the server name when there is one. */
  serverAddress: string
  onQuit: () => void
  run: Runtime
  c: Controls
  say: (message: string, error?: boolean) => void
  openSession: (id: string, inspect?: boolean, session?: Session) => void
  refresh: () => Promise<void>
}
