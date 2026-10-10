import { parseResponse } from "./parse"
import {
  array,
  choice,
  identifier,
  invalid,
  modelRef,
  name,
  numeric,
  object,
  optional,
  owner,
  sources,
  string,
  unique,
} from "./primitives"
import { revert, shellStatuses } from "./session-state"

export function permissionsOrQuestions(
  kind: "permission" | "question",
  sessionID: string,
  response: Record<string, unknown>,
) {
  unique(array(response.data, 64), (value) => {
    const item = object(value)
    owner(item.sessionID, sessionID)
    identifier(item.id, kind === "permission" ? "per_" : "que_")
    if (kind === "permission") {
      string(item.action, 64000)
      array(item.resources, 256).forEach((value) => string(value, 64000))
      optional(item.save, (value) => array(value, 64).forEach((pattern) => string(pattern, 4096)))
      return
    }
    questionRequest(item)
  })
}

function questionRequest(item: Record<string, unknown>) {
  const questions = array(item.questions, 32)
  if (!questions.length) invalid("empty question request")
  for (const value of questions) {
    const question = object(value)
    string(question.question, 64000)
    string(question.header, 1024)
    for (const flag of [question.multiple, question.custom]) {
      if (flag !== undefined && typeof flag !== "boolean") invalid("question options")
    }
    for (const value of array(question.options, 64)) {
      const option = object(value)
      string(option.label, 4096)
      string(option.description, 64000)
    }
  }
}

export function pendingInputs(route: string[], sessionID: string, response: Record<string, unknown>) {
  if (route.length === 5) {
    if (typeof response.data !== "boolean") invalid("input acknowledgement")
    return
  }
  if (route.length !== 3) return
  unique(array(response.data, 256), (value) => {
    const item = object(value)
    identifier(item.id, "msg_")
    owner(item.sessionID, sessionID)
    string(object(item.prompt).text)
    choice(item.delivery, ["steer", "queue"])
    optional(item.source, (value) => choice(value, sources))
    numeric(item.timeCreated)
  })
}

export function stagedRevert(init: RequestInit | undefined, response: Record<string, unknown>) {
  const submitted = object(parseResponse(string(init?.body)))
  revert(response.data, identifier(submitted.messageID, "msg_"))
}

export function goalRoute(sessionID: string, init: RequestInit | undefined, response: Record<string, unknown>) {
  if (response.data === null && (!init?.method || init.method === "GET")) return
  const goal = object(response.data)
  identifier(goal.id, "goal_")
  owner(goal.sessionID, sessionID)
  if (!Number.isSafeInteger(numeric(goal.revision)) || Number(goal.revision) < 1) invalid("goal revision")
  string(goal.objective, 256000)
  choice(goal.status, ["active", "paused", "blocked", "usageLimited", "complete"])
  for (const field of ["tokensUsed", "timeUsedSeconds"]) if (numeric(goal[field]) < 0) invalid("goal usage")
  const time = object(goal.time)
  for (const field of ["created", "updated", "statusChanged"]) numeric(time[field])
  optional(time.completed, numeric)
  if (init?.body) {
    const submitted = object(parseResponse(string(init.body)))
    const expected = submitted.goalID ?? submitted.id
    if (expected !== undefined && identifier(expected, "goal_") !== goal.id) invalid("goal identity")
    if (submitted.expectedRevision !== undefined && Number(goal.revision) < numeric(submitted.expectedRevision))
      invalid("goal revision regressed")
  }
}

export function shellRoute(init: RequestInit | undefined, response: Record<string, unknown>) {
  const item = object(response.data)
  identifier(item.id, "msg_")
  choice(item.type, ["shell"])
  string(item.command)
  string(item.output)
  optional(item.status, (value) => choice(value, shellStatuses))
  const submitted = object(parseResponse(string(init?.body)))
  if (submitted.id !== undefined && item.id !== submitted.id) invalid("shell message identity")
}

/** A prompt or command admission, checked against the request that asked for it. */
export function admissionRoute(
  kind: "prompt" | "command",
  sessionID: string,
  init: RequestInit | undefined,
  response: Record<string, unknown>,
) {
  const admitted = object(response.data)
  owner(admitted.sessionID, sessionID)
  identifier(admitted.id, "msg_")
  const submitted = object(parseResponse(string(init?.body)))
  if (submitted.id !== undefined && admitted.id !== submitted.id) invalid(`${kind} message identity`)
  for (const key of ["admittedSeq", "promotedSeq"]) {
    if (admitted[key] !== undefined && (!Number.isSafeInteger(numeric(admitted[key])) || Number(admitted[key]) < 0))
      invalid("admission sequence")
  }
  if (admitted.prompt !== undefined) string(object(admitted.prompt).text)
  if (admitted.delivery !== undefined) choice(admitted.delivery, ["steer", "queue"])
  if (admitted.source !== undefined) choice(admitted.source, sources)
  if (admitted.agent !== undefined) name(admitted.agent)
  if (admitted.model !== undefined) modelRef(admitted.model)
  if (admitted.timeCreated !== undefined) numeric(admitted.timeCreated)
}
