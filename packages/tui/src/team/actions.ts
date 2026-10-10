import type { TeamContext } from "./types"
import { factoryActions } from "./factory"
import { memberActions } from "./members"
import { roomActions } from "./room-actions"
import { viewOf } from "./types"

/** What the Team tab can do from the keyboard. */
export type TeamAction = { key: string; name: string; description: string; run: () => void }

/** The operations the actions call; the façade (`src/team.ts`) provides them. */
export type TeamOperations = {
  post: () => void
  tasks: () => void
  older: () => void
  repaint: () => void
  sync: () => Promise<void>
}

/**
 * The Team tab's key map and command-palette entries come from this one list. Another feature adds its
 * keys by writing `<name>Actions(ctx, ops): TeamAction[]` in its
 * own file under `src/team/` and spreading it here; key routing, the palette and help read the list as it is.
 */
export function teamActions(ctx: TeamContext, ops: TeamOperations): TeamAction[] {
  return [
    { key: "f", name: "Post to room", description: "Write a message to the room (Enter in the log)", run: ops.post },
    { key: "t", name: "Room tasks", description: "Open, cancel or refresh teammate tasks", run: ops.tasks },
    {
      key: "A",
      name: "Show or hide archived rooms",
      description: "Archived rooms are read-only",
      run: () => {
        const view = viewOf(ctx.state)
        view.showArchived = !view.showArchived
        ctx.say(view.showArchived ? "Archived rooms shown." : "Archived rooms hidden.")
        ops.repaint()
        void ops.sync()
      },
    },
    { key: "[", name: "Older room messages", description: "Load the page before the log", run: ops.older },
    ...roomActions(ctx, ops),
    ...memberActions(ctx, ops),
    ...factoryActions(ctx, ops),
  ]
}
