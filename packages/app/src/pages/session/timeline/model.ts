import type { Message, UserMessage } from "@turenlabs/sdk/v2"
import { createEffect, createMemo, createSignal, on, type Accessor } from "solid-js"
import { useSync } from "@/context/sync"
import { same } from "@/utils/same"

const emptyUserMessages: UserMessage[] = []

export function createTimelineModel(input: {
  sessionID: Accessor<string | undefined>
  revertMessageID: Accessor<string | undefined>
  hydrate: (sessionID: string) => Promise<void>
  /** Widen the loaded window by one page. Absent means the caller loads whole transcripts. */
  loadOlder?: (sessionID: string, intent?: "page" | "seek") => Promise<void>
  /** Whether any transcript exists above the loaded window. */
  hasOlder?: (sessionID: string) => boolean
}) {
  const sync = useSync()
  const [olderVersion, setOlderVersion] = createSignal(0)
  const [hydration, setHydration] = createSignal<{ sessionID?: string; loading: boolean; error?: unknown }>({
    loading: false,
  })
  let hydrationVersion = 0

  const hydrate = async (id: string | undefined) => {
    const version = ++hydrationVersion
    if (!id) {
      setHydration({ loading: false })
      return
    }
    setHydration({ sessionID: id, loading: true })
    try {
      await input.hydrate(id)
      if (version === hydrationVersion) setHydration({ sessionID: id, loading: false })
    } catch (error) {
      if (version === hydrationVersion) setHydration({ sessionID: id, loading: false, error })
    }
  }
  createEffect(on(input.sessionID, (id) => void hydrate(id)))
  const hydrating = () => {
    const state = hydration()
    return state.sessionID === input.sessionID() && state.loading
  }
  const resource = () => {
    const state = hydration()
    if (state.sessionID === input.sessionID() && "error" in state) throw state.error
  }
  const refetch = () => hydrate(input.sessionID())
  const messages = createMemo(() => {
    const id = input.sessionID()
    return id ? (sync().data.message[id] ?? []) : []
  })
  const ready = createMemo(() => {
    const id = input.sessionID()
    return !id || isTimelineReady(sync().data.message[id], hydrating())
  })
  const userMessages = createMemo(() => selectUserMessages(messages()), emptyUserMessages, { equals: same })
  const visibleUserMessages = createMemo(
    () => {
      return selectVisibleUserMessages(userMessages(), input.revertMessageID())
    },
    emptyUserMessages,
    { equals: same },
  )
  // Session V2 hydration takes the newest window of the message endpoint, not the whole
  // transcript, so "older" is a real state again and the load-older affordance is live.
  //
  // `olderVersion` exists because the answer lives in the controller's loader bookkeeping rather
  // than in the store, and a plain `Map` read is invisible to the reactive graph. Bumping it after
  // every widening is what re-runs `more()` so the affordance retires when history runs out —
  // without it the scroll handler would keep asking for pages that no longer exist.
  const [olderLoading, setOlderLoading] = createSignal(false)
  const more = createMemo(() => {
    // Re-read on both signals that can change the answer: a widening (`olderVersion`) and the
    // first hydrate settling (`hydrating()`), which is when a window exists at all.
    olderVersion()
    hydrating()
    const id = input.sessionID()
    return !!id && !!input.hasOlder?.(id)
  })
  const loading = createMemo(() => hydrating() || olderLoading())
  const loadOlder = async (intent: "page" | "seek" = "page") => {
    const id = input.sessionID()
    if (!id || !input.loadOlder || olderLoading()) return
    setOlderLoading(true)
    try {
      await input.loadOlder(id, intent)
      setOlderVersion((value) => value + 1)
    } finally {
      setOlderLoading(false)
    }
  }

  createEffect(() => {
    if (
      !shouldWidenForRevert({
        revertMessageID: input.revertMessageID(),
        visibleUserMessages: visibleUserMessages().length,
        more: more(),
        loading: loading(),
      })
    )
      return
    void loadOlder().catch(() => {})
  })

  return {
    history: { loadOlder, loading, more, version: olderVersion },
    lastUserMessage: createMemo(() => visibleUserMessages().at(-1)),
    messages,
    error: () => {
      const state = hydration()
      return state.sessionID === input.sessionID() ? state.error : undefined
    },
    ready,
    resource,
    refetch,
    userMessages,
    visibleUserMessages,
  }
}

/**
 * Should the loaded window be widened because a revert has hidden all of it?
 *
 * A staged revert hides every message at or after its boundary (`selectVisibleUserMessages`), and
 * message IDs rise with sequence. So a revert to a point older than the loaded window hides the
 * *entire* window and the transcript renders blank — the one way windowed loading can show less
 * than a full drain would have. Widening until the boundary is back inside the window fixes that.
 *
 * This is the one case where the window may end up reading a large part of a session, and it is
 * the right trade: a revert is a deliberate, infrequent act aimed at a specific message, and a
 * blank transcript would be worse than the pages it costs to find it. It terminates because each
 * pass either widens the window or retires `more()`.
 */
export function shouldWidenForRevert(input: {
  revertMessageID: string | undefined
  visibleUserMessages: number
  more: boolean
  loading: boolean
}) {
  if (!input.revertMessageID) return false
  if (input.visibleUserMessages > 0) return false
  return input.more && !input.loading
}

export function selectUserMessages(messages: Message[]) {
  return messages.filter((message): message is UserMessage => message.role === "user")
}

export function isTimelineReady(messages: Message[] | undefined, loading: boolean) {
  return messages !== undefined && (messages.some((message) => message.role === "user") || !loading)
}

export function selectVisibleUserMessages(messages: UserMessage[], revertMessageID?: string) {
  if (!revertMessageID) return messages
  return messages.filter((message) => message.id < revertMessageID)
}
