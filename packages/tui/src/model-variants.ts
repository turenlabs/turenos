import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import { openForSession } from "./model-variants/session-variant"
import { show } from "./model-variants/show"
import type { Target, VariantsContext } from "./model-variants/types"
import type { Connection, Session } from "./server"
import type { DashboardState } from "./state"

export function createModelVariants(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
  onUpdate: (session: Session) => void = () => {},
  blocked: (id: string) => boolean = () => false,
) {
  const ctx: VariantsContext = { renderer, state, connection, dialogs, say, onUpdate, blocked }

  function pick(target: Target) {
    return show(ctx, { ...target, model: { ...target.model } })
  }

  return { open: () => openForSession(ctx), pick }
}

export type ModelVariants = ReturnType<typeof createModelVariants>
