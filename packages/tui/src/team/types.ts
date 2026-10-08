import type { TeamStateOutput } from "@turenlabs/client"
import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "../dialogs"
import type { Connection, Session } from "../server"
import type { DashboardState } from "../state"

/** The server's numbers are finite here: the response validator rejects the non-finite strings the generated types allow. */
type Finite<T, Depth extends unknown[] = []> = Depth["length"] extends 5
  ? T
  : T extends number | "Infinity" | "-Infinity" | "NaN"
    ? number
    : T extends string
      ? T
      : { [K in keyof T]: Finite<T[K], [...Depth, 0]> }

export type Answer = Finite<TeamStateOutput>
export type Room = Answer["rooms"][number]
export type Teammate = Answer["teammates"][number]
export type Message = Answer["messages"][number]
export type Task = Answer["tasks"][number]

/** What the Team tab shows: the latest answer for one room, with its log merged across polls. */
export type TeamView = {
  rooms: readonly Room[]
  /** The room the log belongs to; undefined until the first answer. */
  room: Room | undefined
  teammates: readonly Teammate[]
  messages: readonly Message[]
  tasks: readonly Task[]
  duties: Answer["duties"]
  factoryRuns: Readonly<NonNullable<Answer["factoryRuns"]>>
  /** Older messages exist than the log holds. */
  hasMore: boolean
  /** Why the tab cannot show a room: a server without the route, or a failed request. */
  error?: string
  showArchived: boolean
  /** Set when this client posted, so the next paint follows the tail. */
  follow?: boolean
}

/** At most this many messages stay in memory; the oldest drop first and `hasMore` says so. */
export const MAX_MESSAGES = 500
export const PAGE = 100

export type TeamContext = {
  renderer: CliRenderer
  state: DashboardState
  connection: Connection
  dialogs: Dialogs
  say: (message: string, error?: boolean) => void
  openSession: (id: string, inspect?: boolean, session?: Session) => void
  /** Repaints the sidebar and the room after the view changed. */
  repaint: () => void
}

export function emptyView(): TeamView {
  return {
    rooms: [],
    room: undefined,
    teammates: [],
    messages: [],
    tasks: [],
    duties: [],
    factoryRuns: [],
    hasMore: false,
    showArchived: false,
  }
}

/** The tab's view, created on first use. */
export function viewOf(state: DashboardState) {
  return (state.team ??= emptyView())
}

/** The rooms the sidebar lists: archived ones only when asked for. */
export function visibleRooms(view: TeamView) {
  return view.rooms.filter((room) => view.showArchived || !room.archived)
}
