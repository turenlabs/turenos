import { createStore } from "solid-js/store"
import { ScopedKey, ServerScope } from "@/utils/server-scope"
import type { Message, Part, SessionDurableEvent, SessionMessage } from "@turenlabs/sdk/v2/client"

export type PromptPendingDelivery = "steer" | "queue"

export type SessionPromptPendingChange =
  | { readonly type: "set"; readonly messageID: string; readonly delivery: PromptPendingDelivery }
  | { readonly type: "clear"; readonly messageID: string }

export function sessionEventPromptPending(event: SessionDurableEvent): SessionPromptPendingChange | undefined {
  if (event.type === "session.next.prompt.admitted")
    return { type: "set", messageID: event.data.messageID, delivery: event.data.delivery }
  if (event.type === "session.next.prompted") return { type: "clear", messageID: event.data.messageID }
  return undefined
}

export function createSessionPromptPendingStore() {
  const [pending, setPending] = createStore<
    Record<string, { delivery: PromptPendingDelivery; label: boolean } | undefined>
  >({})
  return {
    delivery: (messageID: string) => {
      const value = pending[messageID]
      return value?.label ? value.delivery : undefined
    },
    ids: () => Object.keys(pending).filter((messageID) => pending[messageID] !== undefined),
    // The optimistic path: a message rendered before its admitted event arrives is marked
    // here by the sender, and the admitted event simply re-confirms the same value.
    mark: (messageID: string, delivery: PromptPendingDelivery, options?: { label?: boolean }) =>
      setPending(messageID, { delivery, label: options?.label ?? true }),
    clear: (messageID: string) => setPending(messageID, undefined),
    has: (messageID: string) => pending[messageID] !== undefined,
    apply: (change: SessionPromptPendingChange) =>
      setPending(change.messageID, change.type === "set" ? { delivery: change.delivery, label: true } : undefined),
  }
}

export function createSessionPromptOutboxStore() {
  type Entry = { scope?: ServerScope; sessionID: string; message: Message; parts: Part[] }
  const [entries, setEntries] = createStore<Record<string, Entry | undefined>>({})
  const key = (messageID: string, scope = ServerScope.local) => ScopedKey.from(scope, messageID)
  const current = (sessionID: string, scope = ServerScope.local) =>
    Object.values(entries).filter(
      (entry): entry is Entry =>
        !!entry && entry.sessionID === sessionID && (entry.scope ?? ServerScope.local) === scope,
    )
  return {
    put: (entry: Entry) => setEntries(key(entry.message.id, entry.scope), entry),
    clear: (messageID: string, scope?: ServerScope) => setEntries(key(messageID, scope), undefined),
    presentation: (sessionID: string, scope?: ServerScope) => ({
      messages: current(sessionID, scope).map((entry) => entry.message),
      parts: current(sessionID, scope).map((entry) => ({ id: entry.message.id, parts: entry.parts })),
    }),
    ids: (sessionID: string, scope?: ServerScope) => current(sessionID, scope).map((entry) => entry.message.id),
    applyStatus: (messageID: string, status: "admitted" | "promoted" | "cancelled", scope?: ServerScope) => {
      if (status === "cancelled") setEntries(key(messageID, scope), undefined)
    },
    reconcile: (sessionID: string, messages: readonly SessionMessage[], scope?: ServerScope) => {
      const projected = new Set(messages.filter((message) => message.type === "user").map((message) => message.id))
      current(sessionID, scope).forEach((entry) => {
        if (projected.has(entry.message.id)) setEntries(key(entry.message.id, entry.scope), undefined)
      })
    },
  }
}

/**
 * Module-scoped for the same reason as `sessionV2DeltaGate`: the reducer lives in the
 * per-session controller while the readers (timeline rows, the composer's optimistic send
 * path) mount in unrelated component trees. The durable outbox is server-scoped
 * because a saved intent can be restored independently in several server views.
 */
export const sessionPromptPending = createSessionPromptPendingStore()
export const sessionPromptOutbox = createSessionPromptOutboxStore()

export function createSessionPromptStartupStore() {
  const [entries, setEntries] = createStore<Record<string, string | undefined>>({})
  return {
    mark: (sessionID: string, messageID: string) => setEntries(messageID, sessionID),
    clear: (messageID: string) => setEntries(messageID, undefined),
    clearSession: (sessionID: string) => {
      Object.entries(entries).forEach(([messageID, owner]) => {
        if (owner === sessionID) setEntries(messageID, undefined)
      })
    },
    clearResponded: (messages: ReadonlyArray<Message>) => {
      messages.forEach((message) => {
        if (message.role === "assistant") setEntries(message.parentID, undefined)
      })
    },
    has: (messageID: string) => entries[messageID] !== undefined,
  }
}

export const sessionPromptStartup = createSessionPromptStartupStore()
