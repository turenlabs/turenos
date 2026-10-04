import type { SessionsGoalSetInput } from "@turenlabs/client"
import { errorText } from "../server"
import type { GoalSubmission } from "./confirm"
import { current, fresh, sameGoal, type Goal } from "./context"

const TASK_OWNED = "Task-owned session: use its owning session. Nothing changed."

export async function submitGoal(flow: GoalSubmission) {
  const { action, session } = flow
  current(flow.env, session, flow.dialog)
  if (flow.env.blocked(session.id)) throw new Error(TASK_OWNED)
  const objective = checkedObjective(flow)
  const intent = flow.intent ?? newIntent(flow, objective)
  const { goal: next, remote } = await fresh(flow.env, session, flow.dialog)
  if (flow.env.blocked(session.id)) throw new Error(TASK_OWNED)
  if (flow.attempted && observed(flow, intent, next)) {
    flow.env.say("Desired goal state observed. Ordinary reply drafts are unchanged.")
    return
  }
  if (session.revert?.messageID !== remote.revert?.messageID)
    throw new Error("Undo boundary changed. No write sent; close and reopen Goal.")
  // A running goal's revision moves every turn; pausing the same active goal re-bases on what was just read.
  if (action === "Pause" && !flow.attempted && !flow.conflict && rebased(flow, next)) flow.base = next
  if (flow.conflict || !sameGoal(flow.base, next)) {
    flow.conflict = true
    throw new Error("Goal revision changed. No overwrite; Esc to inspect and confirm again.")
  }
  if (flow.attempted && action !== "Set")
    throw new Error("Outcome unconfirmed. Retry checks GET only; Esc to inspect. No write repeated.")
  // Freeze the IDs and objective only once a write is about to go out, so a failure that sent nothing stays editable.
  flow.intent = intent
  flow.attempted = true
  await write(flow, intent)
  flow.env.drafts.delete(`${session.id}:${action}`)
  flow.env.say(outcome(flow))
}

function rebased(flow: GoalSubmission, next: Goal) {
  return !!flow.base && !!next && next.id === flow.base.id && next.status === "active" && flow.base.status === "active"
}

function outcome(flow: GoalSubmission) {
  const running = Object.hasOwn(flow.env.state.snapshot?.active ?? {}, flow.session.id)
  const stopped = running ? " Active work stopped." : ""
  if (flow.action === "Set") return "Goal set. The agent starts on it now."
  if (flow.action === "Resume") return "Goal resumed. The agent continues."
  if (flow.action === "Edit") return flow.starts ? "Goal updated. The agent continues with it." : "Goal updated."
  return flow.action === "Pause" ? `Goal paused.${stopped}` : `Goal cleared.${stopped}`
}

/** Validates the objective; once a write has gone out, retries must keep the original. */
function checkedObjective(flow: GoalSubmission) {
  const { editor } = flow
  const objective = editor ? editor.plainText.trim() : (flow.base?.objective ?? "")
  if (editor && (!objective || objective.length > 4000)) throw new Error("Objective must contain 1-4000 characters.")
  if (flow.intent && objective !== flow.intent.objective)
    throw new Error("Retry keeps the original objective. Esc and reopen to change it.")
  return objective
}

function newIntent(flow: GoalSubmission, objective: string): SessionsGoalSetInput {
  return {
    sessionID: flow.session.id,
    id: `goal_${crypto.randomUUID().replaceAll("-", "")}`,
    messageID: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
    objective,
    agent: flow.session.agent,
    model: flow.session.model ? structuredClone(flow.session.model) : undefined,
  }
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
