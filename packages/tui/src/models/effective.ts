import type { Session } from "../server"
import type { DashboardState } from "../state"

/** The model the session's latest loaded reply ran on; it stands in when the session chose none. */
export function lastReplyModel(state: DashboardState, session: Session | undefined) {
  if (!session || state.detail?.sessionID !== session.id) return undefined
  const model = state.detail.messages.findLast((message) => message.type === "assistant")?.model
  return model && (model.providerID !== "unknown" || model.id !== "unknown") ? model : undefined
}
