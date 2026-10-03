import { label } from "../state"
import type { Session } from "../server"
import { show } from "./show"
import type { VariantsContext } from "./types"

/** Opens the variant picker for the selected session; nothing is sent until a choice is confirmed. */
export function openForSession(ctx: VariantsContext) {
  const { state, say } = ctx
  const selected =
    state.tab === "sessions" ? state.snapshot?.sessions.find((session) => session.id === state.selected) : undefined
  if (!selected) return say("Select a session first.", true)
  if (!state.connected) return say("Reconnect before choosing a variant.", true)
  if (ctx.blocked(selected.id)) return say("Task-owned subagent: use its owning session. Nothing changed.", true)
  if (!selected.model) return say("This session has no known model. Choose a model first.", true)
  const session = structuredClone(selected)
  const model = { providerID: selected.model.providerID, id: selected.model.id }
  const attempt = { attempted: false, acknowledged: false }
  show(
    ctx,
    {
      directory: session.location.directory,
      model,
      current: session.model?.variant,
      choose: (variant, currentOnly) => chooseVariant(ctx, session, model, attempt, variant, currentOnly),
    },
    session,
  )
}

type Attempt = { attempted: boolean; acknowledged: boolean }

async function chooseVariant(
  ctx: VariantsContext,
  session: Session,
  model: { providerID: string; id: string },
  attempt: Attempt,
  variant: string | undefined,
  currentOnly: boolean | undefined,
) {
  const { state, connection } = ctx
  let current = await fresh(ctx, session, model)
  const unchanged = current.model?.variant === variant
  if (currentOnly && !unchanged)
    throw new Error("This variant is no longer current or advertised. Close and reload the available choices.")
  if (!attempt.attempted && !unchanged) {
    attempt.attempted = true
    try {
      await connection.client.sessions.switchModel({
        sessionID: session.id,
        model: { ...model, ...(variant === undefined ? {} : { variant }) },
      })
      attempt.acknowledged = true
    } catch {
      throw new Error("Variant outcome unknown. Choice frozen; retry checks only. Esc to close and inspect.")
    }
    current = await fresh(ctx, session, model)
  }
  if (current.model?.variant !== variant)
    throw new Error("Variant not confirmed. Choice frozen; retry checks only. Close and inspect before changing it.")
  const confirmed = current
  if (state.snapshot)
    state.snapshot.sessions = state.snapshot.sessions.map((item) => (item.id === session.id ? confirmed : item))
  if (state.inspected?.id === session.id) state.inspected = current
  ctx.onUpdate(current)
  ctx.say(
    `${!attempt.attempted ? "Variant unchanged; no switch sent" : attempt.acknowledged ? "Variant confirmed" : "Variant observed after unconfirmed request"}: ${label(variant ?? "Model default", 512)}. Applies to subsequent turns.`,
  )
}

/** The session as the server has it now, provided it is still the same session and model. */
async function fresh(ctx: VariantsContext, session: Session, model: { providerID: string; id: string }) {
  const { state } = ctx
  if (state.closed || !state.connected) throw new Error("Reconnect before changing this session.")
  if (ctx.blocked(session.id)) throw new Error("Task-owned subagent: use its owning session. Nothing changed.")
  const current = await ctx.connection.client.sessions.get({ sessionID: session.id })
  if (state.closed || ctx.blocked(session.id)) throw new Error("Session is no longer available for this action.")
  if (
    current.id !== session.id ||
    current.projectID !== session.projectID ||
    current.parentID !== session.parentID ||
    current.subpath !== session.subpath ||
    current.time.created !== session.time.created ||
    current.location.directory !== session.location.directory ||
    current.location.workspaceID !== session.location.workspaceID
  )
    throw new Error("Session identity changed. Close and reopen this control.")
  if (current.model?.providerID !== model.providerID || current.model.id !== model.id)
    throw new Error("Model identity changed. Close and reopen this control.")
  return current
}
