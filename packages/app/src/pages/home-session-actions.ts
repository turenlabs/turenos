// Session lifecycle operations for the left-nav session rows: rename, archive,
// restore, delete.
//
// Every operation here confirms the server actually applied the change before
// resolving. A 2xx alone is not proof: the update endpoint patches only the
// fields it recognises, and a request that round-trips cleanly while changing
// nothing is indistinguishable from success at the transport layer. Each
// operation therefore reads the authoritative record back out of the response
// (or, for delete, out of a follow-up fetch) and rejects when it disagrees with
// what was asked for. Callers can treat a resolved promise as "this happened".
//
// The client is typed structurally rather than against the generated SDK class
// so these stay unit-testable without standing up a server.

import type { Session, SessionV2Info } from "@turenlabs/sdk/v2/client"
import { Session as SessionSchema } from "@turenlabs/schema/session"
import { toLegacySummary } from "@/context/global-sync/home-session-index"

export type SessionLifecycleAction = "rename" | "archive" | "restore" | "delete"

export type SessionLifecycleClient = {
  session: {
    get: (input: { sessionID: string; directory: string }) => Promise<{ data?: Session }>
    update: (input: {
      sessionID: string
      directory: string
      title?: string
      time?: { archived?: number | null }
    }) => Promise<{ data?: Session }>
    delete: (input: { sessionID: string; directory: string }) => Promise<{ data?: boolean }>
  }
}

/**
 * The request succeeded at the transport layer but the server's own record shows
 * the change was not applied. Surfaced to the user as a failure, never a success.
 */
export class SessionActionNotApplied extends Error {
  readonly action: SessionLifecycleAction
  constructor(action: SessionLifecycleAction) {
    super(`The server did not apply the session ${action}`)
    this.name = "SessionActionNotApplied"
    this.action = action
  }
}

export async function renameSession(input: {
  client: SessionLifecycleClient
  sessionID: string
  directory: string
  title: string
}): Promise<Session> {
  const response = await input.client.session.update({
    sessionID: input.sessionID,
    directory: input.directory,
    title: input.title,
  })
  const session = response.data
  // The PATCH responds with the persisted row, so the returned title is the
  // server's answer, not an echo of the request.
  if (!session || session.title !== input.title) throw new SessionActionNotApplied("rename")
  return session
}

export async function setSessionArchived(input: {
  client: SessionLifecycleClient
  sessionID: string
  directory: string
  /** A timestamp archives the session; null restores it. */
  archived: number | null
}): Promise<Session> {
  const action: SessionLifecycleAction = input.archived === null ? "restore" : "archive"
  const response = await input.client.session.update({
    sessionID: input.sessionID,
    directory: input.directory,
    time: { archived: input.archived },
  })
  const session = response.data
  if (!session) throw new SessionActionNotApplied(action)
  const isArchived = typeof session.time.archived === "number"
  if (isArchived !== (input.archived !== null)) throw new SessionActionNotApplied(action)
  return session
}

export async function deleteSession(input: {
  client: SessionLifecycleClient
  sessionID: string
  directory: string
}): Promise<void> {
  // The client is configured with throwOnError, so a non-2xx has already thrown
  // by the time this returns. The endpoint is transactional and only answers 2xx
  // once the session and its dependents are gone, so this is the authoritative
  // signal. Deliberately no assertion on the response body: its exact shape is a
  // transport detail, and turning a representation quirk into a failure would
  // veto a delete that actually happened.
  await input.client.session.delete({ sessionID: input.sessionID, directory: input.directory })
  // The read below can only ESCALATE — it must never veto a delete that already
  // succeeded, because the caller closes the session's tabs on this promise
  // resolving. Vetoing a completed delete strands those tabs on a session that
  // no longer exists, which is a worse outcome than the check is worth.
  //
  // Only the real record coming back is proof of survival. A 404, a network
  // failure, an empty body, `null`, or any object that is not this session are
  // all consistent with a successful delete and must not be read as failure.
  const survivor = await input.client.session
    .get({ sessionID: input.sessionID, directory: input.directory })
    .then((result) => result.data)
    .catch(() => undefined)
  if (survivor && survivor.id === input.sessionID) throw new SessionActionNotApplied("delete")
}

/**
 * Archived root sessions, newest archive first. Callers use the server-side
 * archive filter; these checks keep mixed or older server responses safe.
 */
export function archivedSessions(sessions: SessionV2Info[]): Session[] {
  return sessions
    .filter(
      (session) => !SessionSchema.isInternal(session) && !session.parentID && typeof session.time.archived === "number",
    )
    .sort((a, b) => (b.time.archived ?? 0) - (a.time.archived ?? 0))
    .map(toLegacySummary)
}

/** Restoring a session puts it back in the home index; archiving takes it out. */
export function restoredHomeSessionEvent(session: Session) {
  return {
    type: "session.updated" as const,
    properties: {
      sessionID: session.id,
      info: { ...session, time: { ...session.time, archived: undefined } },
    },
  }
}
