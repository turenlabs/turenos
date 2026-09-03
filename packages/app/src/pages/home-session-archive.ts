import type { Session } from "@turenlabs/sdk/v2/client"
import { notifySessionTabsRemoved } from "@/components/titlebar-session-events"
import type { HomeSessionEvent } from "@/context/global-sync/home-session-index"
import type { ServerConnection } from "@/context/server"

type HomeSession = {
  id: string
  directory: string
}

type SessionUpdate = {
  directory: string
  sessionID: string
  time: { archived: number }
}

// The home left nav renders from the home session index cache, not the
// per-directory child stores. Feeding this event to homeSessions.apply removes
// the archived row immediately instead of waiting on a server event that can be
// missed across reconnects or on remote servers.
export function archivedHomeSessionEvent(session: Session, archived: number): HomeSessionEvent {
  return {
    type: "session.updated",
    properties: {
      sessionID: session.id,
      info: { ...session, time: { ...session.time, archived } },
    },
  }
}

export async function archiveHomeSession(input: {
  server: ServerConnection.Key
  session: HomeSession
  update: (value: SessionUpdate) => Promise<unknown>
  remove: (update: SessionUpdate) => void
  onError?: (error: unknown) => void
}) {
  const update: SessionUpdate = {
    directory: input.session.directory,
    sessionID: input.session.id,
    time: { archived: Date.now() },
  }
  await input
    .update(update)
    .then(() => {
      input.remove(update)
      notifySessionTabsRemoved({
        server: input.server,
        directory: input.session.directory,
        sessionIDs: [input.session.id],
      })
    })
    .catch((error) => input.onError?.(error))
}
