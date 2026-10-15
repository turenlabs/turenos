import { sessionTitle } from "../state"
import { refused, sameSession, type Session } from "../server"
import { modelIdentity } from "./identity"
import { pick } from "./pick"
import type { ModelsContext } from "./types"

/** Opens the picker for one session; the choice switches that session's model for subsequent turns. */
export function pickForSession(ctx: ModelsContext, session: Session) {
  const captured = structuredClone(session)
  const attempt: { value?: string } = {}
  pick(ctx, {
    directory: captured.location.directory,
    current: captured.model ? `${captured.model.providerID}/${captured.model.id}` : "",
    recipient: captured,
    choose: (value) => switchModel(ctx, captured, value, attempt),
  })
}

async function switchModel(ctx: ModelsContext, session: Session, value: string, attempt: { value?: string }) {
  const { state, connection } = ctx
  if (ctx.blocked(session.id)) throw new Error("Task-owned subagent: use its owning session.")
  // Another client may have changed the model or variant while the picker was open.
  const current = await connection.client.sessions.get({ sessionID: session.id })
  if (state.closed) return
  if (ctx.blocked(session.id)) throw new Error("Task-owned subagent: use its owning session.")
  if (!sameSession(current, session)) throw new Error("Session identity changed. Close and reopen this control.")
  const slash = value.indexOf("/")
  const model = { providerID: value.slice(0, slash), id: value.slice(slash + 1) }
  const retried = attempt.value === value
  const unchanged = current.model?.providerID === model.providerID && current.model.id === model.id
  if (!unchanged) {
    attempt.value = value
    await connection.client.sessions.switchModel({ sessionID: session.id, model }).catch((error) => {
      if (refused(error)) attempt.value = undefined
      throw error
    })
  }
  if (state.closed) return
  const updated = { ...current, model: unchanged ? current.model : model }
  if (state.snapshot)
    state.snapshot.sessions = state.snapshot.sessions.map((item) => (item.id === session.id ? updated : item))
  if (state.inspected?.id === updated.id) state.inspected = updated
  ctx.onUpdate(updated)
  if (unchanged && !retried) {
    ctx.say(
      `Model unchanged: ${modelIdentity(current.model)}. No switch sent for ${sessionTitle(current.title || current.id, 80)}.`,
    )
    return
  }
  ctx.say(
    `${current.model?.variant && current.model.variant !== "default" ? "Variant reset to model default. " : ""}Model selected for ${sessionTitle(current.title || current.id, 80)}: ${value}. Applies to subsequent turns.`,
  )
}
