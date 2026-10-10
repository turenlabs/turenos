import { harnessRoute } from "./harness"
import { parseResponse } from "./parse"
import {
  admissionRoute,
  goalRoute,
  pendingInputs,
  permissionsOrQuestions,
  shellRoute,
  stagedRevert,
} from "./interaction"
import { array, choice, identifier, invalid, numeric, object, optional, owner, string, unique } from "./primitives"
import { roomRoute } from "./room"
import { cursor, message, session, task } from "./session-state"

/** Validates every `/api/session...` response; `route` is the path after `/api/`. */
export function sessionRoute(route: string[], init: RequestInit | undefined, value: unknown) {
  const response = object(value)
  if (route[1] === "active") return activeSessions(response)
  if (route.length === 1) return sessionPage(init, response)
  if (route[1] === "interrupt-all") return interruptAll(response)
  const sessionID = identifier(route[1], "ses_")
  optional(response.sessionID, (value) => owner(value, sessionID))
  if (route.length === 2) return session(response.data, sessionID)
  if (route[2] === "message") {
    unique(array(response.data, 30), (value) => message(value, sessionID))
    cursor(response.cursor)
    return response
  }
  if (route[2] === "task") return taskInventory(route, response)
  if (route[2] === "permission" || route[2] === "question") return permissionsOrQuestions(route[2], sessionID, response)
  if (route[2] === "input") return pendingInputs(route, sessionID, response)
  if (route[2] === "revert" && route[3] === "stage") return stagedRevert(init, response)
  if (route[2] === "goal") return goalRoute(sessionID, init, response)
  if (route[2] === "harness") return harnessRoute(route, response.data)
  if (route[2] === "room") return roomRoute(route, init, response)
  if (route[2] === "shell") return shellRoute(init, response)
  if (route[2] === "prompt" || route[2] === "command") return admissionRoute(route[2], sessionID, init, response)
}

/** Key under which an oversized active map carries how many entries were dropped; no session ID can collide with it. */
export const ACTIVE_OMITTED = "omitted"

function activeSessions(response: Record<string, unknown>) {
  const entries = Object.entries(object(response.data))
  const kept = entries.slice(0, 128)
  for (const [id, item] of kept) {
    identifier(id, "ses_")
    choice(object(item).type, ["running"])
  }
  // More running sessions than the client fans out to are cut, not refused: refusing fails every snapshot.
  if (entries.length > kept.length)
    return { ...response, data: { ...Object.fromEntries(kept), [ACTIVE_OMITTED]: entries.length - kept.length } }
}

function sessionPage(init: RequestInit | undefined, response: Record<string, unknown>) {
  if (init?.method === "POST") {
    const submitted = object(parseResponse(string(init.body)))
    session(response.data, identifier(submitted.id, "ses_"))
    return
  }
  unique(array(response.data, 100), session)
  cursor(response.cursor)
}

function interruptAll(response: Record<string, unknown>) {
  const result = object(response.data)
  for (const count of [result.interrupted, result.failed])
    if (!Number.isSafeInteger(numeric(count)) || Number(count) < 0) invalid("interrupt count")
}

function taskInventory(route: string[], response: Record<string, unknown>) {
  // Only the task inventory is a list. Task get/cancel acknowledgements are
  // single task objects and pass through unvalidated.
  if (route.length !== 3) return
  unique(array(response.data, 256), task)
  unique(array(response.active, 256), task)
  cursor(response.cursor)
}
