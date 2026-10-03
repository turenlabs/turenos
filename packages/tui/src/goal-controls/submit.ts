import type { SessionsGoalSetInput } from "@turenlabs/client"
import { errorText } from "../server"
import type { GoalSubmission } from "./confirm"
import { current, fresh, sameGoal, type Goal } from "./context"

const TASK_OWNED = "Task-owned session: use its owning session. Nothing changed."

export async function submitGoal(flow: GoalSubmission) {
  const { action, session } = flow
  current(flow.env, session, flow.dialog)
  if (flow.env.blocked(session.id)) throw new Error(TASK_OWNED)
  if (flow.typed && flow.typed.value !== "clear") throw new Error("Type clear exactly, then Ctrl+S.")
  const intent = prepareIntent(flow)
  const { goal: next, remote } = await fresh(flow.env, session, flow.dialog)
  if (flow.env.blocked(session.id)) throw new Error(TASK_OWNED)
  if (flow.attempted && observed(flow, intent, next)) {
    flow.env.say("Desired goal state observed. Ordinary reply drafts are unchanged.")
    return
  }
  if (session.revert?.messageID !== remote.revert?.messageID)
    throw new Error("Undo boundary changed. No write sent; close and reopen Goal.")
  if (flow.conflict || !sameGoal(flow.base, next)) {
    flow.conflict = true
    throw new Error("Goal revision changed. No overwrite; Esc to inspect and confirm again.")
  }
  if (flow.attempted && action !== "Set")
    throw new Error("Outcome unconfirmed. Retry checks GET only; Esc to inspect. No write repeated.")
  flow.attempted = true
  await write(flow, intent)
  flow.env.say(
    `Goal ${action.toLowerCase()} acknowledged. ${flow.starts ? "Execution requested." : action === "Pause" || action === "Clear" ? "Active work stopped." : "Objective updated."} Reply drafts unchanged.`,
  )
}

/** Validates the objective and freezes the goal and message IDs on the first submit so retries reuse them. */
function prepareIntent(flow: GoalSubmission) {
  const { editor, session } = flow
  const objective = editor ? editor.plainText.trim() : (flow.base?.objective ?? "")
  if (editor && (!objective || objective.length > 4000)) throw new Error("Objective must contain 1-4000 characters.")
  if (flow.intent && objective !== flow.intent.objective)
    throw new Error("Retry keeps the original objective. Esc and reopen to change it.")
  flow.intent ??= {
    sessionID: session.id,
    id: `goal_${crypto.randomUUID().replaceAll("-", "")}`,
    messageID: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
    objective,
    agent: session.agent,
    model: session.model ? structuredClone(session.model) : undefined,
  }
  return flow.intent
}

function desired(flow: GoalSubmission, intent: SessionsGoalSetInput, value: Goal) {
  const { action, base } = flow
  return (
    value !== null &&
    value.sessionID === flow.session.id &&
    value.id === (action === "Set" ? intent.id : base!.id) &&
    value.objective === (action === "Set" || action === "Edit" ? intent.objective : base!.objective) &&
    value.status === (action === "Edit" ? base!.status : action === "Set" ? "active" : flow.status) &&
    value.revision >= (action === "Set" ? 1 : base!.revision)
  )
}

/** True when the fetched goal already shows the confirmed change, so no further write is needed. */
function observed(flow: GoalSubmission, intent: SessionsGoalSetInput, next: Goal) {
  const { action, base } = flow
  if (action === "Clear") return next === null
  return (
    desired(flow, intent, next) &&
    (action === "Set" ||
      next!.revision === base!.revision + 1 ||
      (action === "Edit" && intent.objective === base!.objective && next!.revision === base!.revision))
  )
}

async function write(flow: GoalSubmission, intent: SessionsGoalSetInput) {
  const { action, base, session } = flow
  const sessions = flow.env.connection.client.sessions
  try {
    let acknowledged: Goal = null
    if (action === "Set") acknowledged = await sessions.goalSet(intent)
    else {
      const guard = { sessionID: session.id, goalID: base!.id, expectedRevision: base!.revision }
      if (action === "Edit") acknowledged = await sessions.goalEdit({ ...guard, objective: intent.objective })
      else if (action === "Clear") await sessions.goalClear(guard)
      else acknowledged = await sessions.goalStatus({ ...guard, status: flow.status })
    }
    if (action !== "Clear" && !desired(flow, intent, acknowledged))
      throw new Error("Returned goal does not match the confirmed intent")
  } catch (error) {
    throw new Error(
      `Outcome unconfirmed: ${errorText(error)}. ${action === "Set" ? "Retry preserves the original goal/message IDs and objective." : "Retry checks GET only; no write repeated."}`,
    )
  }
}
