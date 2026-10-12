import type { ForgeClient } from "@turenlabs/sdk/v2/client"
import type { SessionMessage } from "@turenlabs/sdk/v2"
import { createScopedCache } from "@/utils/scoped-cache"

export type TeamRichSession = { id: string; location: { directory: string } }

const clients = new WeakMap<ForgeClient, ReturnType<typeof createTeamRichCache>>()

export function teamRichCache(client: ForgeClient) {
  const existing = clients.get(client)
  if (existing) return existing
  const cache = createTeamRichCache(client)
  clients.set(client, cache)
  return cache
}

function createTeamRichCache(client: ForgeClient) {
  const sessions = createScopedCache(
    (sessionID): Promise<TeamRichSession> => {
      const request = client.v2.session
        .get({ sessionID })
        .then((response) => {
          const session = response.data?.data
          if (!session || session.id !== sessionID || !session.location?.directory)
            throw new Error("Session location is unavailable")
          return { id: session.id, location: { directory: session.location.directory } }
        })
        .catch((error: unknown) => {
          if (sessions.peek(sessionID) === request) sessions.delete(sessionID)
          throw error
        })
      return request
    },
    { maxEntries: 128 },
  )
  const messages = createScopedCache(
    (key): Promise<SessionMessage> => {
      const [sessionID, messageID] = JSON.parse(key) as [string, string]
      const request = client.v2.session
        .message({ sessionID, messageID })
        .then((response) => {
          const source = response.data?.data
          if (!source || source.id !== messageID || source.type !== "assistant")
            throw new Error("Source message is unavailable")
          // Progress posts can reference an assistant that is still changing.
          if (source.time.completed === undefined) throw new Error("Source message is still running")
          return source
        })
        .catch((error: unknown) => {
          // An evicted request must not remove a newer request for the same key.
          if (messages.peek(key) === request) messages.delete(key)
          throw error
        })
      return request
    },
    { maxEntries: 512 },
  )
  return {
    session: (sessionID: string) => sessions.get(sessionID),
    message: (sessionID: string, messageID: string) => messages.get(JSON.stringify([sessionID, messageID])),
  }
}

type ObserverFactory = (
  callback: IntersectionObserverCallback,
  options: IntersectionObserverInit,
) => Pick<IntersectionObserver, "observe" | "disconnect">

export function observeTeamRichOutput(
  element: HTMLElement,
  ready: () => void,
  makeObserver: ObserverFactory | undefined = typeof IntersectionObserver === "undefined"
    ? undefined
    : (callback, options) => new IntersectionObserver(callback, options),
) {
  if (!makeObserver) {
    ready()
    return () => {}
  }
  let active = true
  const observer = makeObserver(
    (entries) => {
      if (!active || !entries.some((entry) => entry.target === element && entry.isIntersecting)) return
      active = false
      observer.disconnect()
      ready()
    },
    { root: element.closest('[role="log"]'), rootMargin: "400px 0px" },
  )
  observer.observe(element)
  return () => {
    active = false
    observer.disconnect()
  }
}
