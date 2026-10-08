import type { CliRenderer, KeyEvent } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import type { Connection, Session } from "./server"
import type { DashboardState } from "./state"
import { teamActions } from "./team/actions"
import { load, newLoader, older, sync } from "./team/load"
import { openPost, unsent, type Poster } from "./team/post"
import { roomNote, roomRows } from "./team/rooms"
import { openTasks } from "./team/tasks"
import { viewOf, type TeamContext } from "./team/types"
import { showRoom } from "./team/view"

export { roomNote, roomRows, showRoom }

/**
 * The desktop's Team page: rooms in the sidebar, the selected room's log in the detail pane, and a docked
 * editor that posts into it. The dashboard's 2-second refresh calls `poll` while the tab is shown.
 */
export function createTeam(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
  openSession: (id: string, inspect?: boolean, session?: Session) => void,
  hooks: Pick<TeamContext, "repaint" | "pickModel" | "openAutomation"> & { atTop: () => boolean },
) {
  const ctx: TeamContext = {
    renderer,
    state,
    connection,
    dialogs,
    say,
    openSession,
    repaint: hooks.repaint,
    pickModel: hooks.pickModel,
    openAutomation: hooks.openAutomation,
  }
  const loader = newLoader(ctx)
  const poster: Poster = {
    ctx,
    drafts: new Map(),
    key: () => false,
    atTop: hooks.atTop,
    older: () => void older(loader),
    reload: () => void sync(loader),
  }
  const actions = teamActions(ctx, {
    post: () => openPost(poster),
    tasks: () => openTasks(ctx, () => load(loader)),
    older: () => void older(loader),
    repaint: hooks.repaint,
    sync: () => sync(loader),
  })
  return {
    /** Loads for the selected room and repaints: the tab opened, or the selection moved. */
    sync: () => sync(loader),
    /** One reconciliation, without repainting; the dashboard repaints after its refresh. */
    poll: () => load(loader),
    older: () => older(loader),
    post: () => openPost(poster),
    /** The `@handle` list of the open post editor. */
    key: (event: KeyEvent) => poster.key(event),
    unsent: () => unsent(poster),
    selected: () => {
      const view = viewOf(state)
      return view.room?.id === state.selected ? view.room : undefined
    },
    actions,
    /** Key → action for the Team tab. */
    keys: Object.fromEntries(actions.map((action) => [action.key, action.run])),
  }
}
