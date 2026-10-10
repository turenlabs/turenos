import { sessionTitle } from "../state"
import type { Session } from "../server"
import { modelIdentity } from "./identity"
import { pick } from "./pick"
import type { ModelsContext } from "./types"

/** Opens the picker for one session; the choice switches that session's model for subsequent turns. */
export function pickForSession(ctx: ModelsContext, session: Session) {
  pick(ctx, {
    directory: session.location.directory,
    current: session.model ? `${session.model.providerID}/${session.model.id}` : "",
    recipient: session,
    choose: (value) => switchModel(ctx, session, value),
  })
}

async function switchModel(ctx: ModelsContext, session: Session, value: string) {
  const { state, connection } = ctx
  if (ctx.blocked(session.id)) throw new Error("Task-owned subagent: use its owning session.")
  // Another client may have changed the model or variant while the picker was open.
  const current = await connection.client.sessions.get({ sessionID: session.id })
  if (state.closed) return
  if (ctx.blocked(session.id)) throw new Error("Task-owned subagent: use its owning session.")
  const slash = value.indexOf("/")
  const model = { providerID: value.slice(0, slash), id: value.slice(slash + 1) }
  const unchanged = current.model?.providerID === model.providerID && current.model.id === model.id
  if (!unchanged) await connection.client.sessions.switchModel({ sessionID: session.id, model })
  if (state.closed) return
  const updated = { ...current, model: unchanged ? current.model : model }
  if (state.snapshot)
    state.snapshot.sessions = state.snapshot.sessions.map((item) => (item.id === session.id ? updated : item))
  if (state.inspected?.id === updated.id) state.inspected = updated
  ctx.onUpdate(updated)
  if (unchanged) {
    ctx.say(
      `Model unchanged: ${modelIdentity(current.model)}. No switch sent for ${sessionTitle(current.title || current.id, 80)}.`,
    )
    return
  }
  ctx.say(
    `${current.model?.variant && current.model.variant !== "default" ? "Variant reset to model default. " : ""}Model selected for ${sessionTitle(current.title || current.id, 80)}: ${value}. Applies to subsequent turns.`,
  )
}
