import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import type { Connection } from "./server"
import type { DashboardState } from "./state"
import { commands } from "./menus/commands"
import type { MenuActions } from "./menus/context"
import { workingFolders } from "./menus/folders"
import { help } from "./menus/help"
import { information } from "./menus/information"
import { openByID } from "./menus/open-by-id"
import { openSwitcher } from "./menus/switcher"

export function createMenus(
  renderer: CliRenderer,
  state: DashboardState,
  dialogs: Dialogs,
  connection: Connection,
  actions: MenuActions,
) {
  const ctx = { renderer, state, dialogs, connection, actions }
  return {
    switcher: (initialScope?: "recent" | "all" | "archived", sidebar?: boolean) =>
      openSwitcher(ctx, initialScope, sidebar),
    workingFolders: () => workingFolders(ctx),
    openByID: (value?: string) => openByID(ctx, value),
    commands: (list: { name: string; description: string; run: () => void }[]) => commands(ctx, list),
    information: (address: string) => information(ctx, address),
    help: () => help(ctx),
  }
}
