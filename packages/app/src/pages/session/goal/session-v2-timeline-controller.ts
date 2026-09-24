import { batch, createEffect, onCleanup, type Accessor } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type {
  Message,
  Part,
  SessionDurableEvent,
  SessionInputAdmitted,
  SessionMessage,
  SessionMessageAssistantTool,
  SessionStatus,
  ToolPart,
} from "@turenlabs/sdk/v2/client"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { promptAdmissionFor } from "@/components/prompt-input/prompt-admission"
import {
  sessionPromptOutbox,
  sessionPromptPending,
  sessionPromptStartup,
  sessionEventPromptPending,
} from "./session-prompt-state"
export {
  sessionPromptOutbox,
  sessionPromptPending,
  sessionPromptStartup,
  sessionEventPromptPending,
  createSessionPromptOutboxStore,
  createSessionPromptPendingStore,
  createSessionPromptStartupStore,
  type PromptPendingDelivery,
  type SessionPromptPendingChange,
} from "./session-prompt-state"
import { createSessionOwnership } from "@/pages/session/session-ownership"
import { sessionInteractionTrace } from "@/utils/session-interaction-trace"
import {
  isSessionV2ToolStub,
  mergeIncrementalMessages,
  mergeSessionV2Parts,
  mergeSessionV2Presentation,
  presentSessionV2Messages,
  presentTool,
  type SessionV2Presentation,
} from "./session-v2-presentation"
import { sessionV2DeltaGate } from "./session-v2-delta-gate"

export { createSessionV2DeltaGate } from "./session-v2-delta-gate"

export type LiveDelta = {
  sequence: number
  messageID: string
  partID: string
  field: "text"
  delta: string
}

export type SnapshotMode = "context" | "full"

export type SnapshotOptions = {
  readonly authoritative?: boolean
}

type SnapshotRequest = {
  readonly mode: SnapshotMode
  readonly authoritative: boolean
  readonly waiters: SnapshotWaiter[]
}

type SnapshotWaiter = { readonly resolve: () => void; readonly reject: (error: unknown) => void }

type SnapshotJob = {
  pending?: SnapshotRequest
  running?: Promise<void>
  active?: SnapshotWaiter[]
  waiting: SnapshotWaiter[]
  cancelled?: boolean
}

import { loadSessionV2Window, SESSION_V2_MESSAGE_PAGE_LIMIT } from "./session-v2-message-window"

export {
  collectSessionV2Messages,
  loadSessionV2MessageWindow,
  loadSessionV2Window,
  startsSessionV2Turn,
  SESSION_V2_MESSAGE_PAGE_LIMIT,
  SESSION_V2_WINDOW_PAGE_LIMIT,
} from "./session-v2-message-window"

export const SESSION_V2_SNAPSHOT_RESTAKE_LIMIT = 8
export type SessionV2HistoryLoadIntent = "page" | "seek"

export function nextSessionV2WindowMinimum(current: number, intent: SessionV2HistoryLoadIntent) {
  if (intent === "seek") return Math.max(current + SESSION_V2_MESSAGE_PAGE_LIMIT, current * 2)
  return current + SESSION_V2_MESSAGE_PAGE_LIMIT
}
const SESSION_V2_AUTHORITATIVE_RETRY_LIMIT = 2

export type SnapshotOutcome =
  | { readonly type: "abandon" }
  | { readonly type: "restake"; readonly attempts: number }
  | { readonly type: "exhausted" }
  | { readonly type: "project" }

/**
 * Decides what happens to a snapshot that has just come back.
 *
 * Ownership moves during cold open — scope and directory both resolve after mount — so a
 * result fetched under the old key must not be applied. Dropping it is only safe if
 * something re-fetches, and nothing does: the cold-open resource re-runs on session-ID
 * change alone, and an idle session emits no further events to trigger a refresh. A
 * dropped snapshot that is not re-staked leaves the transcript blank forever.
 *
 * So re-staking is the default, the attempt budget counts only consecutive failures, and
 * running out is reported rather than swallowed — a blank timeline beside healthy network
 * traffic is indistinguishable from an empty session.
 */
export function sessionSnapshotOutcome(input: {
  sessionMatches: boolean
  owned: boolean
  attempts: number
  limit?: number
}): SnapshotOutcome {
  if (!input.sessionMatches) return { type: "abandon" }
  if (input.owned) return { type: "project" }
  const attempts = input.attempts + 1
  if (attempts > (input.limit ?? SESSION_V2_SNAPSHOT_RESTAKE_LIMIT)) return { type: "exhausted" }
  return { type: "restake", attempts }
}

export function sessionTranscriptUnavailableError(sessionID: string) {
  return new Error(`Session transcript could not be loaded: ${sessionID}`)
}

/**
 * A window refresh is only allowed to advance its pagination anchor when it still has continuity
 * with the window that is on screen. An empty or truncated read can be a perfectly valid response
 * while a projector/replay boundary is settling, but it is not evidence that the visible history
 * was deleted. Keeping the old anchor makes the next authoritative/context read retry the same
 * span instead of turning a transient gap into a smaller window.
 */
export function sessionV2MessageWindowHasContinuity(input: {
  current?: { readonly oldest?: string; readonly count: number }
  messages: readonly { readonly id: string }[]
  complete: boolean
}) {
  const current = input.current
  if (!current) return true
  if (input.messages.length === 0) return current.count === 0
  if (current.oldest !== undefined && !input.messages.some((message) => message.id === current.oldest)) return false
  return input.messages.length >= current.count || input.complete
}

/**
 * Keep a streamed delta until the snapshot actually contains the text it describes. The local
 * sequence watermark alone is insufficient: a delta can arrive just before a partial read, and
 * the following catch-up snapshot may start with a newer watermark while still missing that part.
 */
export function sessionV2DeltasForProjection(input: {
  deltas: readonly LiveDelta[]
  through: number
  snapshotText: ReadonlyMap<string, string>
  deltaBases: ReadonlyMap<string, string | undefined>
}) {
  const grouped = new Map<string, string[]>()
  input.deltas.forEach((delta) => {
    if (!(delta.sequence <= input.through)) return
    const key = `${delta.messageID}\0${delta.partID}`
    const chunks = grouped.get(key)
    if (chunks) chunks.push(delta.delta)
    else grouped.set(key, [delta.delta])
  })
  const retained = new Set<string>()
  grouped.forEach((chunks, key) => {
    const snapshot = input.snapshotText.get(key)
    const base = input.deltaBases.get(key)
    if (
      snapshot === undefined ||
      !input.deltaBases.has(key) ||
      base === undefined ||
      !snapshot.startsWith(base + chunks.join(""))
    )
      retained.add(key)
  })
  return input.deltas.filter(
    (delta) => !(delta.sequence <= input.through) || retained.has(`${delta.messageID}\0${delta.partID}`),
  )
}

/** High-frequency stream fragments are applied from the live delta channel, not reloaded as context. */
export function sessionEventNeedsTranscriptSnapshot(type: string) {
  switch (type) {
    case "session.next.text.delta":
    case "session.next.reasoning.delta":
    case "session.next.tool.input.delta":
    case "session.next.compaction.delta":
      return false
    default:
      return true
  }
}

export type SessionV2ToolEvent = Extract<
  SessionDurableEvent,
  {
    type:
      | "session.next.tool.input.ended"
      | "session.next.tool.called"
      | "session.next.tool.progress"
      | "session.next.tool.success"
      | "session.next.tool.failed"
  }
>

/**
 * Apply one tool lifecycle event to the part already in the store.
 *
 * Every one of these events carries its complete state — the same fields the server folds into
 * its message model in `core/session/message-updater.ts` — so a `tool.success` on a tool-heavy
 * turn does not need a full-window refetch per call. The replacement part is rebuilt through
 * `presentTool`, the same mapping a snapshot applies, so the two paths cannot drift apart.
 *
 * `fallback` runs when the store cannot settle faithfully: the part is outside the loaded
 * window, or it is still pending and the parsed input only ever existed in a `tool.called`
 * event the store never saw. The caller picks the fallback — settlement events still get the
 * full snapshot they used to trigger, live progress gets the cheaper context hydrate.
 */
export function applySessionV2ToolEvent(input: {
  sessionID: string
  parts: readonly Part[] | undefined
  event: SessionV2ToolEvent
  write: (index: number, part: ToolPart) => void
  fallback: () => void
}) {
  const index = input.parts?.findIndex(
    (part) => part.type === "tool" && (part.callID === input.event.data.callID || part.id === input.event.data.callID),
  )
  if (index === undefined || index < 0) return input.fallback()
  const part = input.parts?.[index]
  if (part?.type !== "tool") return input.fallback()
  const next = sessionV2ToolEventPart(input.sessionID, part, input.event)
  if (next === "fallback") return input.fallback()
  if (next === "ignore") return
  input.write(index, next)
}

/**
 * The presented `ToolPart` one tool event implies, or a directive:
 * - `"ignore"` — the store is already past this event (a duplicate `called`, a settlement
 *   replayed onto a settled part, input text landing on a call that already ran).
 * - `"fallback"` — the part exists but the event alone cannot produce a faithful presentation.
 */
function sessionV2ToolEventPart(
  sessionID: string,
  part: ToolPart,
  event: SessionV2ToolEvent,
): ToolPart | "ignore" | "fallback" {
  if (event.type === "session.next.tool.input.ended") {
    if (part.state.status !== "pending") return "ignore"
    return { ...part, state: { ...part.state, raw: event.data.text } }
  }
  // A presented part keeps `time.start` only once it has run; before that the event timestamp is
  // the closest truthful boundary.
  const start = part.state.status === "pending" ? event.data.timestamp : part.state.time.start
  const present = (
    state: SessionMessageAssistantTool["state"],
    time: { ran?: number; completed?: number },
    provider?: SessionMessageAssistantTool["provider"],
  ) => {
    const presented = presentTool(sessionID, part.messageID, {
      type: "tool",
      id: event.data.callID,
      name: part.tool,
      provider,
      state,
      time: { created: start, ...time },
    })
    // The settled provider record merges over the presented part's (`executed` wins, result
    // metadata is carried on `resultMetadata` exactly as the server keeps it); call-time keys
    // such as a prior provider metadata or a prune mark survive the transition.
    const metadata = { ...part.metadata, ...presented.metadata }
    // ...but a lean-page stub marker does not: the event just restored the real body.
    delete metadata.truncated
    return { ...presented, metadata }
  }
  switch (event.type) {
    case "session.next.tool.called":
      if (part.state.status === "completed" || part.state.status === "error") return "ignore"
      return present(
        { status: "running", input: event.data.input, structured: {}, content: [] },
        { ran: event.data.timestamp },
        {
          executed: event.data.provider.executed || part.metadata?.providerExecuted === true,
          metadata: event.data.provider.metadata,
        },
      )
    case "session.next.tool.progress":
      if (part.state.status !== "running") return "ignore"
      return present(
        {
          status: "running",
          input: part.state.input,
          structured: event.data.structured,
          content: event.data.content,
        },
        {},
      )
    case "session.next.tool.success":
      if (part.state.status === "completed" || part.state.status === "error") return "ignore"
      // A pending part only retains the raw input string; the parsed arguments live in the
      // `tool.called` event this store missed. Refetch rather than present an empty input.
      if (part.state.status !== "running") return "fallback"
      return present(
        {
          status: "completed",
          input: part.state.input,
          structured: event.data.structured,
          content: event.data.content,
          ...(event.data.outputPaths !== undefined ? { outputPaths: event.data.outputPaths } : {}),
          ...(event.data.result !== undefined ? { result: event.data.result } : {}),
        },
        { completed: event.data.timestamp },
        {
          executed: event.data.provider.executed || part.metadata?.providerExecuted === true,
          resultMetadata: event.data.provider.metadata,
        },
      )
    case "session.next.tool.failed": {
      if (part.state.status === "completed" || part.state.status === "error") return "ignore"
      const state = part.state
      // The running part retains only the stringified output; re-wrapping it as one text item
      // makes `presentTool` produce the same `metadata.output` a snapshot would. Structured and
      // content carry over from a running state only — parity with the server updater.
      const output = state.status === "running" ? state.metadata?.output : undefined
      return present(
        {
          status: "error",
          error: event.data.error,
          input: state.status === "running" ? state.input : {},
          structured: state.status === "running" ? ((state.metadata?.structured ?? {}) as Record<string, unknown>) : {},
          content: typeof output === "string" && output.length > 0 ? [{ type: "text", text: output }] : [],
          ...(event.data.result !== undefined ? { result: event.data.result } : {}),
        },
        { completed: event.data.timestamp },
        {
          executed: event.data.provider.executed || part.metadata?.providerExecuted === true,
          resultMetadata: event.data.provider.metadata,
        },
      )
    }
  }
  return "ignore"
}

/**
 * In-flight `session.message` back-fills, keyed by `sessionID+messageID`. One request covers every
 * stub in that message, so expanding two cards of the same message issues exactly one fetch. A
 * failed request clears the mark, so the next expand retries.
 */
const toolBodyRequests = new Set<string>()

/**
 * Back-fill the tool bodies a lean `session.messages` page elided.
 *
 * The fetched row is re-presented with `presentTool` — the same mapping a snapshot applies — and
 * written back in place: no message-list rebuild, no reorder. `parts` is read *after* the request
 * resolves, because a settlement event that landed during the fetch already holds the real body
 * and must not be overwritten by a second copy of it.
 */
export async function expandSessionV2ToolBody(input: {
  sessionID: string
  part: ToolPart
  load: (messageID: string) => Promise<SessionMessage | undefined>
  parts: () => readonly Part[] | undefined
  write: (index: number, part: ToolPart) => void
}): Promise<boolean> {
  if (!isSessionV2ToolStub(input.part)) return false
  const key = `${input.sessionID}\0${input.part.messageID}`
  if (toolBodyRequests.has(key)) return false
  toolBodyRequests.add(key)
  try {
    const message = await input.load(input.part.messageID)
    if (message?.type !== "assistant") return false
    const stored = input.parts() ?? []
    let applied = false
    message.content.forEach((content) => {
      if (content.type !== "tool") return
      const index = stored.findIndex(
        (part) => part.type === "tool" && (part.id === content.id || part.callID === content.id),
      )
      const current = index < 0 ? undefined : stored[index]
      if (!current || !isSessionV2ToolStub(current)) return
      input.write(index, presentTool(input.sessionID, message.id, content))
      applied = true
    })
    return applied
  } finally {
    toolBodyRequests.delete(key)
  }
}

export function createSessionV2TimelineController(input: {
  sessionID: Accessor<string | undefined>
  sessionKey: Accessor<string>
  agent: Accessor<string>
  model: Accessor<{ providerID: string; modelID: string; variant?: string }>
}) {
  const sdk = useSDK()
  const sync = useSync()
  const admission = promptAdmissionFor(usePlatform())
  const language = useLanguage()
  const owner = createSessionOwnership(input.sessionKey)
  const owned = new Map<string, Set<string>>()
  const v2Sessions = sessionV2DeltaGate
  const deltas = new Map<string, LiveDelta[]>()
  const deltaBases = new Map<string, string | undefined>()
  const polls = new Map<string, number>()
  const polling = new Set<string>()
  const pollingVersions = new Map<string, number>()
  const fullProjectionVersions = new Map<string, number>()
  const snapshotAborts = new Set<AbortController>()
  const authoritativeRetries = new Map<string, number>()
  const pendingProjectionIDs = new Map<string, Set<string>>()
  let deltaSequence = 0
  let refreshFrame: number | undefined
  let refreshSessionID: string | undefined

  const setSessionStatus = (sessionID: string, status: SessionStatus) => {
    sync().set("session_status", sessionID, status)
  }

  // The session each snapshot was requested for, tracked outside the reactive graph.
  //
  // `input.sessionID()` is router-backed, and Solid Router commits `params` only when the
  // navigation transition finishes. A snapshot requested for the session the user just
  // switched to therefore resolves while that accessor still reports the *previous*
  // session, so an identity check against it reads as "the user navigated away" and throws
  // the result away. Nothing re-requests it, so the transcript never projects and the
  // timeline stays gated off with no error — a silent blank. Recording the requested
  // session synchronously makes identity independent of commit timing.
  let requested: string | undefined
  const isRequestedSession = (sessionID: string) => requested === undefined || requested === sessionID

  const applyDelta = (sessionID: string, delta: LiveDelta) => {
    if (input.sessionID() !== sessionID) return false
    const parts = sync().data.part[delta.messageID]
    const index = parts?.findIndex((part) => part.id === delta.partID)
    if (index === undefined || index < 0) return false
    const part = parts[index]
    if (part.type !== "text" && part.type !== "reasoning") return false
    // An element-level reconcile diffs one small object; the array rebuild and keyed reconcile
    // this replaced allocated and re-keyed the whole parts array per streamed token.
    sync().set("part", delta.messageID, index, reconcile({ ...part, text: part.text + delta.delta }))
    return true
  }

  const applyToolEvent = (sessionID: string, event: SessionV2ToolEvent, fallback: () => void) => {
    applySessionV2ToolEvent({
      sessionID,
      parts: sync().data.part[event.data.assistantMessageID],
      event,
      write: (index, part) => sync().set("part", event.data.assistantMessageID, index, reconcile(part)),
      fallback,
    })
  }

  const project = (
    sessionID: string,
    messages: SessionMessage[],
    pendingInputs: readonly SessionInputAdmitted[],
    through: number,
    authoritative: boolean,
    pendingRevision: number,
  ) => {
    const captured = owner.capture()
    if (!captured.current() || !isRequestedSession(sessionID)) return
    const projectionStarted = performance.now()
    const presentation = presentSessionV2Messages({
      sessionID,
      directory: sdk().directory,
      agent: input.agent(),
      model: input.model(),
      messages,
      pendingInputs,
    })
    // The fetched span always includes the loaded window's top edge (`until: oldest`), so this
    // recomputation is the whole orphan lifecycle: a fetch that finally covers a dropped
    // assistant's parent presents it, and it leaves the list here.
    rememberOrphans(sessionID, messages, presentation)
    const outbox = sessionPromptOutbox.presentation(sessionID, sdk().scope)
    const presentedIDs = new Set(presentation.messages.map((message) => message.id))
    outbox.messages.forEach((message) => {
      if (presentedIDs.has(message.id)) return
      presentedIDs.add(message.id)
      presentation.messages.push(message)
      const parts = outbox.parts.find((entry) => entry.id === message.id)
      if (parts) presentation.parts.push(parts)
    })
    const snapshotText = new Map<string, string>(
      presentation.parts.flatMap((entry) =>
        entry.parts.flatMap((part) =>
          part.type === "text" || part.type === "reasoning" ? [[`${entry.id}\0${part.id}`, part.text] as const] : [],
        ),
      ),
    )
    const pending = sessionV2DeltasForProjection({
      deltas: deltas.get(sessionID) ?? [],
      through,
      snapshotText,
      deltaBases,
    })
    const visibleText = new Map<string, string>(
      pending.flatMap((delta) => {
        const part = sync().data.part[delta.messageID]?.find((item) => item.id === delta.partID)
        if (part?.type !== "text" && part?.type !== "reasoning") return []
        return [[`${delta.messageID}\0${delta.partID}`, part.text] as const]
      }),
    )
    const projectedInputIDs = new Set(
      messages.filter((message) => message.type === "user").map((message) => message.id),
    )
    const pendingInputIDs = sessionUnprojectedInputIDs(projectedInputIDs, pendingInputs)
    pendingInputs
      .filter((pending) => pendingInputIDs.has(pending.id))
      .forEach((pending) => sessionPromptPending.mark(pending.id, pending.delivery, { through: pendingRevision }))
    // A successful V2 snapshot identifies the session even when a brand-new transcript is empty.
    // Mark before live deltas race the first projected assistant part into the snapshot.
    v2Sessions.observeSnapshot(sessionID)
    // A full read is still only a bounded window. Tool settlement and pagination therefore merge
    // it into the last visible transcript; only a structural boundary (revert/cold
    // open) may remove rows that are absent from that window.
    const projection = mergeSessionV2Presentation({
      messages: sync().data.message[sessionID] ?? [],
      parts: sync().data.part,
      previousOwnedMessageIDs: authoritative
        ? new Set((sync().data.message[sessionID] ?? []).map((message) => message.id))
        : (owned.get(sessionID) ?? new Set()),
      presentation,
      preservedMessageIDs: new Set(sessionPromptPending.ids()),
      removeMissing: authoritative,
    })

    batch(() => {
      presentation.messages
        .filter((message) => message.role === "user")
        .forEach((message) =>
          sync().session.optimistic.remove({
            directory: sdk().directory,
            sessionID,
            messageID: message.id,
          }),
        )
      sync().set("message", sessionID, reconcile(projection.messages, { key: "id" }))
      presentation.parts.forEach((entry) => {
        // A lean-page stub never overwrites a part whose real body was already fetched or settled.
        sync().set(
          "part",
          entry.id,
          reconcile(mergeSessionV2Parts(sync().data.part[entry.id], entry.parts), { key: "id" }),
        )
      })
      projection.removedMessageIDs.forEach((messageID) => {
        sync().set("part", messageID, reconcile([], { key: "id" }))
      })
      pending
        .reduce((groups, delta) => {
          const key = `${delta.messageID}\0${delta.partID}`
          groups.set(key, [...(groups.get(key) ?? []), delta])
          return groups
        }, new Map<string, LiveDelta[]>())
        .forEach((values, key) => {
          const delta = values[0]
          if (!delta) return
          const parts = sync().data.part[delta.messageID]
          const index = parts?.findIndex((part) => part.id === delta.partID)
          if (index === undefined || index < 0) return
          const part = parts[index]
          if (part.type !== "text" && part.type !== "reasoning") return
          const text = mergeSessionV2LiveText(
            part.text,
            visibleText.get(key),
            values.map((value) => value.delta).join(""),
          )
          if (text === part.text) return
          sync().set("part", delta.messageID, index, reconcile({ ...part, text }))
        })
    })
    projectedInputIDs.forEach((messageID) => {
      if (sessionPromptPending.has(messageID)) sessionPromptPending.clear(messageID)
    })
    sessionPromptStartup.clearResponded(presentation.messages)
    owned.set(sessionID, projection.ownedMessageIDs)
    const pendingSequences = new Set(pending.map((delta) => delta.sequence))
    const currentDeltas = deltas.get(sessionID) ?? []
    currentDeltas.forEach((delta) => {
      const key = `${delta.messageID}\0${delta.partID}`
      if (!pendingSequences.has(delta.sequence)) {
        deltaBases.delete(key)
        return
      }
      const unresolvedBefore = currentDeltas.some(
        (value) =>
          value.sequence <= through &&
          pendingSequences.has(value.sequence) &&
          `${value.messageID}\0${value.partID}` === key,
      )
      const snapshot = snapshotText.get(key)
      if (!unresolvedBefore && snapshot !== undefined) deltaBases.set(key, snapshot)
    })
    deltas.set(
      sessionID,
      currentDeltas.filter((delta) => pendingSequences.has(delta.sequence)),
    )
    sessionInteractionTrace("snapshot.projected", {
      durationMs: performance.now() - projectionStarted,
      sessionID,
      sourceMessages: messages.length,
      projectedMessages: projection.messages.length,
      projectedParts: presentation.parts.reduce((total, entry) => total + entry.parts.length, 0),
    })
  }

  /**
   * How much history is currently materialised for a session, and how to reach further back.
   *
   * Kept outside the reactive graph on purpose: it is loader bookkeeping, not view state, and a
   * snapshot must be able to read it synchronously while a navigation transition is still
   * settling — the same reason `requested` above is a plain variable.
   */
  const windows = new Map<
    string,
    { readonly oldest?: string; readonly older?: string; readonly complete: boolean; readonly count: number }
  >()

  /**
   * Fetched assistant messages the presenter dropped because their parent user message sits in a
   * page that is not loaded yet.
   *
   * A window that opens mid-turn carries leading assistant messages `presentSessionV2Messages`
   * cannot parent, and the server cursor has already moved past them — once dropped they can never
   * be re-requested. They are carried here instead: the next `loadOlder` page is older than all of
   * them, so presenting them after that page's messages lands them under the right turn. Every
   * presentation of a session recomputes the set, so a snapshot that covers the orphans' parent
   * clears them without any extra bookkeeping.
   */
  const orphans = new Map<string, SessionMessage[]>()

  const rememberOrphans = (sessionID: string, messages: SessionMessage[], presentation: SessionV2Presentation) => {
    const presented = new Set(presentation.messages.map((message) => message.id))
    const dropped = messages.filter((message) => message.type === "assistant" && !presented.has(message.id))
    if (dropped.length > 0) {
      orphans.set(sessionID, dropped)
      return
    }
    orphans.delete(sessionID)
  }

  /**
   * Fetch the visible window of a session's transcript.
   *
   * Not the whole transcript. The timeline is virtualised, so all but a screenful of a drained
   * history is parsed, projected and stored only to be discarded — and on a 228 MiB session that
   * is the entire tab-switch stall. This walks `order: "desc"` from the newest message instead,
   * which is one request for the common case.
   *
   * The existing window metadata is what makes a live re-projection non-destructive. `minimum` is
   * the count the session already had, so a refresh never shows the user less than they were
   * looking at; `until` pins the far edge to the oldest message already loaded, so messages
   * appended since do not push the tail of the window off the end. Authoritative reads keep the
   * loaded count but drop the ID anchor because a revert may have removed that message.
   */
  const messages = async (
    sessionID: string,
    signal: AbortSignal,
    authoritative: boolean,
    client: ReturnType<typeof sdk>["client"],
    currentOwner: () => boolean,
  ) => {
    const current = windows.get(sessionID)
    const result = await loadSessionV2Window({
      sessionID,
      signal,
      request: (payload, options) => client.v2.session.messages(payload, options),
      minimum: current?.count || undefined,
      until: authoritative ? undefined : current?.oldest,
    })
    if (!currentOwner()) return { messages: result.messages, stable: false as const }
    if (authoritative && result.messages.length === 0) return { messages: result.messages, stable: false as const }
    if (!authoritative && !sessionV2MessageWindowHasContinuity({ ...result, current }))
      return { messages: result.messages, stable: false as const }
    windows.set(sessionID, {
      oldest: result.messages[0]?.id,
      older: result.older,
      complete: result.complete,
      count: result.messages.length,
    })
    return { messages: result.messages, stable: true as const }
  }

  /** Does this session have transcript above what is loaded? Drives the "load older" affordance. */
  const hasOlder = (sessionID: string) => {
    const current = windows.get(sessionID)
    return current !== undefined && !current.complete && current.older !== undefined
  }

  /**
   * Extend the window one page further back, then re-project.
   *
   * The older page is spliced into the store rather than re-requested: the `older` cursor already
   * points at exactly the next span backwards, so one request replaces what used to be a
   * full-window refetch (fetch + parse + present + reconcile of every message on screen). `minimum`
   * is the intent's growth expressed as new messages — a page for manual scrolling, the doubling
   * `nextSessionV2WindowMinimum` prescribes for a hash seek.
   *
   * The presenter drops leading assistant messages whose parent sits in an older page, and the
   * server cursor has already moved past them, so they could never be fetched again. `orphans`
   * carries them across the gap: they are younger than everything in the new page, so presenting
   * them after `page.messages` parents them to the turn the page bottoms out in.
   */
  const loadOlder = async (sessionID: string, intent: SessionV2HistoryLoadIntent = "page") => {
    const current = windows.get(sessionID)
    if (!current || current.complete || current.older === undefined) return
    const captured = owner.capture()
    const client = sdk().client
    const abort = new AbortController()
    snapshotAborts.add(abort)
    try {
      const page = await loadSessionV2Window({
        sessionID,
        signal: abort.signal,
        request: (payload, options) => client.v2.session.messages(payload, options),
        minimum: nextSessionV2WindowMinimum(current.count, intent) - current.count,
        cursor: current.older,
      })
      if (!captured.current() || !isRequestedSession(sessionID)) return
      // A snapshot that reset the window while the page was in flight owns the bookkeeping;
      // splicing the page in anyway could resurrect rows an authoritative read just removed.
      const latest = windows.get(sessionID)
      if (!latest) return
      const fetched = [...page.messages, ...(orphans.get(sessionID) ?? [])]
      const presentation = presentSessionV2Messages({
        sessionID,
        directory: sdk().directory,
        agent: input.agent(),
        model: input.model(),
        messages: fetched,
      })
      rememberOrphans(sessionID, fetched, presentation)
      const merged = mergeIncrementalMessages(sync().data.message[sessionID] ?? [], presentation.messages)
      batch(() => {
        presentation.messages
          .filter((message) => message.role === "user")
          .forEach((message) =>
            sync().session.optimistic.remove({
              directory: sdk().directory,
              sessionID,
              messageID: message.id,
            }),
          )
        sync().set("message", sessionID, reconcile(merged, { key: "id" }))
        presentation.parts.forEach((entry) => {
          sync().set(
            "part",
            entry.id,
            reconcile(mergeSessionV2Parts(sync().data.part[entry.id], entry.parts), { key: "id" }),
          )
        })
      })
      fetched
        .filter((message) => message.type === "user")
        .forEach((message) => {
          if (sessionPromptPending.has(message.id)) sessionPromptPending.clear(message.id)
        })
      sessionPromptOutbox.reconcile(sessionID, fetched, sdk().scope)
      sessionPromptStartup.clearResponded(presentation.messages)
      const presented = presentation.messages.map((message) => message.id)
      owned.set(sessionID, new Set([...(owned.get(sessionID) ?? []), ...presented]))
      windows.set(sessionID, {
        oldest: page.messages[0]?.id ?? latest.oldest,
        older: page.older,
        complete: page.complete,
        count: Math.max(latest.count, current.count + page.messages.length),
      })
    } finally {
      snapshotAborts.delete(abort)
    }
  }

  const restaked = new Map<string, number>()
  const snapshots = createSessionSnapshotQueue(async (sessionID, mode, authoritative) => {
    const scope = sdk().scope
    const captured = owner.capture()
    const client = sdk().client
    const through = deltaSequence
    const pendingRevision = sessionPromptPending.revision()
    const abort = new AbortController()
    snapshotAborts.add(abort)
    const snapshotStarted = performance.now()
    sessionInteractionTrace("snapshot.started", { sessionID, mode, authoritative })
    // Read inbox state first: if an input is promoted between these reads, it appears
    // in both results and is deduplicated by ID. The reverse order could miss it in both.
    const result = await client.v2.session
      .pendingInputs({ sessionID }, { signal: abort.signal })
      .then((response) => [...response.data!.data])
      .then(async (pending) => ({
        pending,
        // Incremental and settled refreshes share the human transcript. Model context can reorder
        // preserved tails around checkpoints and must never be used to parent UI messages.
        snapshot: await messages(sessionID, abort.signal, authoritative, client, captured.current),
      }))
      .catch((error) => {
        snapshotAborts.delete(abort)
        throw error
      })
    const projectedIDs = new Set(
      result.snapshot.messages.filter((message) => message.type === "user").map((message) => message.id),
    )
    const pendingIDs = sessionUnprojectedInputIDs(projectedIDs, result.pending)
    const previousPendingIDs = pendingProjectionIDs.get(sessionID) ?? new Set<string>()
    const statusIDs = new Set([...sessionPromptOutbox.ids(sessionID, scope), ...previousPendingIDs])
    const statuses = new Map<string, "admitted" | "promoted" | "cancelled">()
    const cancelledIDs = new Set<string>()
    await Promise.all(
      [...statusIDs]
        .filter((messageID) => !projectedIDs.has(messageID) && !pendingIDs.has(messageID))
        .map(async (messageID) => {
          try {
            const status = await client.v2.session.inputStatus(
              { sessionID, messageID },
              { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]) },
            )
            const value = status.data?.data?.status
            if (value) {
              statuses.set(messageID, value)
              if (value === "cancelled") cancelledIDs.add(messageID)
            }
          } catch {
            // Missing or unreachable status is ambiguous; retain the row.
          }
        }),
    ).finally(() => snapshotAborts.delete(abort))
    const outcome = sessionSnapshotOutcome({
      sessionMatches: isRequestedSession(sessionID),
      owned: captured.current(),
      attempts: restaked.get(sessionID) ?? 0,
    })
    if (outcome.type === "abandon") {
      restaked.delete(sessionID)
      authoritativeRetries.delete(sessionID)
      return
    }
    if (outcome.type === "restake") {
      restaked.set(sessionID, outcome.attempts)
      // Queue it, never await it: `request` hands back the drain promise we are
      // currently inside, so awaiting it would deadlock. The drain loop picks
      // the re-staked mode up as soon as this run returns, and the caller
      // awaiting `hydrate` still waits for that follow-up pass.
      void snapshots.request(sessionID, mode, { authoritative }).catch(() => undefined)
      return
    }
    if (outcome.type === "exhausted") {
      restaked.delete(sessionID)
      authoritativeRetries.delete(sessionID)
      throw sessionTranscriptUnavailableError(sessionID)
    }
    restaked.delete(sessionID)
    statuses.forEach((status, messageID) => {
      if (status !== "admitted") sessionPromptPending.clear(messageID)
      sessionPromptOutbox.applyStatus(messageID, status, scope)
      admission.settle(
        scope,
        sessionID,
        messageID,
        status === "admitted" ? "pending" : status === "promoted" ? "projected" : "cancelled",
      )
    })
    projectedIDs.forEach((messageID) => admission.settle(scope, sessionID, messageID, "projected"))
    pendingIDs.forEach((messageID) => admission.settle(scope, sessionID, messageID, "pending"))
    if (cancelledIDs.size > 0) {
      batch(() => {
        sync().set(
          "message",
          sessionID,
          reconcile(
            (sync().data.message[sessionID] ?? []).filter((message) => !cancelledIDs.has(message.id)),
            { key: "id" },
          ),
        )
        cancelledIDs.forEach((messageID) => {
          sync().set("part", messageID, reconcile([], { key: "id" }))
          sessionPromptStartup.clear(messageID)
          sessionPromptPending.clear(messageID)
          owned.get(sessionID)?.delete(messageID)
        })
      })
    }
    pendingProjectionIDs.set(
      sessionID,
      new Set([...pendingIDs, ...[...previousPendingIDs].filter((messageID) => !cancelledIDs.has(messageID))]),
    )
    sessionPromptOutbox.reconcile(sessionID, result.snapshot.messages, scope)
    sessionInteractionTrace("snapshot.loaded", {
      durationMs: performance.now() - snapshotStarted,
      sessionID,
      mode,
      authoritative,
      messages: result.snapshot.messages.length,
      pendingInputs: result.pending.length,
    })
    if (!result.snapshot.stable) {
      if (authoritative) {
        const attempts = authoritativeRetries.get(sessionID) ?? 0
        if (attempts < SESSION_V2_AUTHORITATIVE_RETRY_LIMIT) {
          authoritativeRetries.set(sessionID, attempts + 1)
          void snapshots.request(sessionID, "full", { authoritative: true }).catch(() => undefined)
          return
        }
        authoritativeRetries.delete(sessionID)
        // Repeated empty authoritative reads are the boundary's final answer (for example a
        // revert before the first visible turn). Commit that answer rather than falling back to
        // an additive context merge that would resurrect rows the server removed.
        windows.delete(sessionID)
        project(sessionID, result.snapshot.messages, result.pending, through, true, pendingRevision)
        fullProjectionVersions.set(sessionID, (fullProjectionVersions.get(sessionID) ?? 0) + 1)
        return
      }
      // Retain the visible transcript when a transient read cannot reach its old edge. A later
      // refresh can catch up; only an explicit revert may remove previously loaded conversation.
      throw sessionTranscriptUnavailableError(sessionID)
    }
    authoritativeRetries.delete(sessionID)
    project(
      sessionID,
      result.snapshot.messages,
      result.pending,
      through,
      mode === "full" && authoritative,
      pendingRevision,
    )
    if (mode === "full") fullProjectionVersions.set(sessionID, (fullProjectionVersions.get(sessionID) ?? 0) + 1)
  })
  const requestSnapshot = (sessionID: string, mode: SnapshotMode, options?: SnapshotOptions) => {
    requested = sessionID
    return snapshots.request(sessionID, mode, options)
  }

  // Cold open must end in one of two states: a projected transcript, or a reported
  // failure. Resolving without having written `data.message` leaves the timeline gated
  // off with no error and no spinner — a blank session that looks empty rather than
  // broken. Assert the postcondition so that outcome becomes an error boundary instead.
  //
  // The check is deliberately on the store rather than on `input.sessionID()`: a snapshot
  // that resolved mid-transition used to read as "the user navigated away" and return
  // quietly, which is exactly how a dropped projection became a silent blank.
  const hydrate = async (sessionID: string) => {
    await requestSnapshot(sessionID, "full")
    if (!isRequestedSession(sessionID)) return
    if (sync().data.message[sessionID] !== undefined) return
    throw sessionTranscriptUnavailableError(sessionID)
  }

  const scheduleHydrate = (sessionID: string) => {
    if (input.sessionID() !== sessionID) return
    refreshSessionID = sessionID
    if (refreshFrame !== undefined) return
    refreshFrame = requestAnimationFrame(() => {
      refreshFrame = undefined
      const next = refreshSessionID
      refreshSessionID = undefined
      if (!next || input.sessionID() !== next) return
      void requestSnapshot(next, "context").catch(() => undefined)
    })
  }

  const stopPolling = (sessionID: string) => {
    polling.delete(sessionID)
    pollingVersions.set(sessionID, (pollingVersions.get(sessionID) ?? 0) + 1)
    const timer = polls.get(sessionID)
    if (timer !== undefined) window.clearTimeout(timer)
    polls.delete(sessionID)
  }

  const pollUntilIdle = (sessionID: string) => {
    if (!polling.has(sessionID)) {
      polling.add(sessionID)
      pollingVersions.set(sessionID, (pollingVersions.get(sessionID) ?? 0) + 1)
    }
    if (polls.has(sessionID)) return
    const captured = owner.capture()
    const poll = () => {
      const pollingVersion = pollingVersions.get(sessionID) ?? 0
      const statusVersion = sync().session.statusRevision(sessionID)
      const schedulePoll = (delay: number) => {
        if (!polling.has(sessionID) || pollingVersions.get(sessionID) !== pollingVersion) return
        if (!captured.current() || input.sessionID() !== sessionID) {
          stopPolling(sessionID)
          return
        }
        polls.set(sessionID, window.setTimeout(poll, delay))
      }
      void sdk()
        .client.v2.session.active()
        .then((response) => {
          if (!polling.has(sessionID) || pollingVersions.get(sessionID) !== pollingVersion) return
          if (!captured.current() || input.sessionID() !== sessionID) {
            stopPolling(sessionID)
            return
          }
          if (sync().session.statusRevision(sessionID) !== statusVersion) {
            if (sync().data.session_status[sessionID]?.type === "idle") {
              stopPolling(sessionID)
              return
            }
            polls.set(sessionID, window.setTimeout(poll, 250))
            return
          }
          if (response.data?.data[sessionID]) {
            polls.set(sessionID, window.setTimeout(poll, 250))
            return
          }
          const projectionVersion = fullProjectionVersions.get(sessionID) ?? 0
          void commitSessionIdleAfterRefresh({
            refresh: () => requestSnapshot(sessionID, "full"),
            current: () =>
              polling.has(sessionID) &&
              pollingVersions.get(sessionID) === pollingVersion &&
              captured.current() &&
              input.sessionID() === sessionID &&
              sync().session.statusRevision(sessionID) === statusVersion &&
              (fullProjectionVersions.get(sessionID) ?? 0) > projectionVersion,
            commit: () => {
              stopPolling(sessionID)
              setSessionStatus(sessionID, { type: "idle" })
            },
          })
            .then((committed) => {
              if (committed) return
              schedulePoll(250)
            })
            .catch(() => schedulePoll(1_000))
        })
        .catch(() => schedulePoll(1_000))
    }
    polls.set(sessionID, window.setTimeout(poll, 0))
  }

  const recordDelta = (value: { sessionID: string; assistantMessageID: string; partID: string; delta: string }) => {
    if (!v2Sessions.accepts(value.sessionID)) return
    const key = `${value.assistantMessageID}\0${value.partID}`
    if (!deltaBases.has(key)) {
      const part = sync().data.part[value.assistantMessageID]?.find((item) => item.id === value.partID)
      deltaBases.set(key, part?.type === "text" || part?.type === "reasoning" ? part.text : undefined)
    }
    const delta = {
      sequence: ++deltaSequence,
      messageID: value.assistantMessageID,
      partID: value.partID,
      field: "text" as const,
      delta: value.delta,
    }
    deltas.set(value.sessionID, [...(deltas.get(value.sessionID) ?? []), delta])
    if (applyDelta(value.sessionID, delta)) return
    scheduleHydrate(value.sessionID)
  }

  createEffect(() => {
    const current = sdk()
    const textDelta = current.event.on("session.next.text.delta", (event) =>
      recordDelta({
        sessionID: event.properties.sessionID,
        assistantMessageID: event.properties.assistantMessageID,
        partID: event.properties.textID,
        delta: event.properties.delta,
      }),
    )
    const reasoningDelta = current.event.on("session.next.reasoning.delta", (event) =>
      recordDelta({
        sessionID: event.properties.sessionID,
        assistantMessageID: event.properties.assistantMessageID,
        partID: event.properties.reasoningID,
        delta: event.properties.delta,
      }),
    )
    onCleanup(() => {
      textDelta()
      reasoningDelta()
    })
  })

  createEffect(() => {
    const sessionID = input.sessionID()
    const current = sdk()
    const currentSync = sync()
    const captured = owner.capture()
    if (!sessionID) return
    let reportedError: string | undefined
    const watcher = admission.watch({
      scope: current.scope,
      sessionID,
      client: current.client,
      online: () => navigator.onLine,
      onCancelled: (messageID) => {
        if (!captured.current() || !isRequestedSession(sessionID)) return
        currentSync.session.optimistic.remove({ directory: current.directory, sessionID, messageID })
        currentSync.set("message", sessionID, (messages) =>
          (messages ?? []).filter((message) => message.id !== messageID),
        )
        currentSync.set("part", messageID, reconcile([], { key: "id" }))
        sessionPromptStartup.clear(messageID)
        sessionPromptPending.clear(messageID)
        pendingProjectionIDs.get(sessionID)?.delete(messageID)
        owned.get(sessionID)?.delete(messageID)
      },
      onChange: () => {
        if (!captured.current() || !isRequestedSession(sessionID)) return
        const error = admission.error()
        if (error && error !== reportedError)
          showToast({ title: language.t("session.message.delivery.saveFailed"), description: error })
        reportedError = error
        const outbox = sessionPromptOutbox.presentation(sessionID, current.scope)
        outbox.messages.forEach((message) => {
          if ((currentSync.data.message[sessionID] ?? []).some((current) => current.id === message.id)) return
          currentSync.session.optimistic.add({
            directory: current.directory,
            sessionID,
            message,
            parts: outbox.parts.find((entry) => entry.id === message.id)?.parts ?? [],
          })
        })
      },
    })
    const online = () => watcher.refresh()
    const offline = () => watcher.pause()
    window.addEventListener("online", online)
    window.addEventListener("offline", offline)
    onCleanup(() => {
      watcher.dispose()
      window.removeEventListener("online", online)
      window.removeEventListener("offline", offline)
    })
  })

  createEffect(() => {
    const sessionID = input.sessionID()
    const scope = sdk().scope
    const client = sdk().client
    if (!sessionID) return
    const activeSessionID = sessionID
    const captured = owner.capture()
    let stopped = false
    let cursor = -1
    let retry = 250
    let retryTimer: number | undefined
    let streamAbort: AbortController | undefined

    const schedule = (callback: () => void) => {
      if (stopped || !captured.current()) return
      retryTimer = window.setTimeout(callback, retry)
      retry = nextSessionEventRetry(retry)
    }

    function reconnect() {
      if (stopped || !captured.current()) return
      void requestSnapshot(activeSessionID, "context").catch(() => undefined)
      schedule(() => void connect())
    }

    async function connect() {
      if (stopped || !captured.current()) return
      const abort = new AbortController()
      streamAbort = abort
      try {
        const events = await client.v2.session.events(
          {
            sessionID: activeSessionID,
            after: cursor >= 0 ? String(cursor) : undefined,
          },
          { signal: abort.signal },
        )
        for await (const value of events.stream) {
          if (stopped || !captured.current()) return
          const event = parseDurableEvent(value)
          if (!event) continue
          const sequence = event.durable?.seq ?? 0
          if (sequence <= cursor) continue
          cursor = Math.max(cursor, sequence)
          sessionInteractionTrace("session.event", {
            sessionID: activeSessionID,
            sequence,
            type: event.type,
          })
          retry = 250
          v2Sessions.observe(activeSessionID)
          if (event.type === "session.next.step.started") {
            // A new provider step is a durable boundary. Any live fragments retained from the
            // prior step have either been projected or are no longer relevant to this assistant.
            for (const delta of deltas.get(activeSessionID) ?? [])
              deltaBases.delete(`${delta.messageID}\0${delta.partID}`)
            deltas.delete(activeSessionID)
          }
          // Before the revert/retry branches `continue`: an admitted event that also folds
          // in a revert must still mark its message as awaiting promotion, and the status
          // line must see every lifecycle event.
          const promptPending = sessionEventPromptPending(event)
          if (promptPending) {
            sessionPromptPending.apply(promptPending)
            admission.settle(
              scope,
              activeSessionID,
              promptPending.messageID,
              promptPending.type === "set" ? "pending" : "projected",
            )
          }
          sessionTurnActivity.reduce(activeSessionID, event)
          // Ahead of the busy transition, because a retry is a *more* specific answer than "busy"
          // and must not be flattened into it. A rate-limited turn writes nothing to the
          // transcript, so this event is the only thing that distinguishes a session waiting on a
          // quota window from one that has silently stopped.
          const retrying = sessionEventRetryStatus(event)
          if (retrying) {
            batch(() => {
              setSessionStatus(activeSessionID, retrying)
              sessionPromptStartup.clearSession(activeSessionID)
            })
            pollUntilIdle(activeSessionID)
            continue
          }
          const transition = sessionEventStatusTransition(event.type)
          if (transition) {
            if (transition.busy)
              batch(() => {
                setSessionStatus(activeSessionID, { type: "busy" })
                sessionPromptStartup.clearSession(activeSessionID)
              })
            else sessionPromptStartup.clearSession(activeSessionID)
            if (transition.busy && !transition.poll) stopPolling(activeSessionID)
            if (transition.poll) pollUntilIdle(activeSessionID)
          }
          if (sessionEventCommitsRevert(event)) {
            void requestSnapshot(activeSessionID, "full", { authoritative: true }).catch(() => undefined)
            continue
          }
          if (event.type === "session.next.compaction.ended") {
            void requestSnapshot(activeSessionID, "full").catch(() => undefined)
            continue
          }
          if (event.type === "session.next.tool.success" || event.type === "session.next.tool.failed") {
            applyToolEvent(
              activeSessionID,
              event,
              () => void requestSnapshot(activeSessionID, "full").catch(() => undefined),
            )
            continue
          }
          if (
            event.type === "session.next.tool.called" ||
            event.type === "session.next.tool.input.ended" ||
            event.type === "session.next.tool.progress"
          ) {
            applyToolEvent(activeSessionID, event, () => scheduleHydrate(activeSessionID))
            continue
          }
          if (sessionEventNeedsTranscriptSnapshot(event.type)) scheduleHydrate(activeSessionID)
        }
        reconnect()
      } catch {
        if (!abort.signal.aborted) reconnect()
      }
    }

    async function prime() {
      try {
        // A fresh subscription skips history, so activity folded from a previous viewing
        // of this session describes events we will never see settle. Start clean.
        sessionTurnActivity.reset(activeSessionID)
        const response = await client.v2.session.history({ sessionID: activeSessionID, limit: 1 })
        if (stopped || !captured.current()) return
        cursor = response.data!.latest
        retry = 250
        // Reconcile state through the captured cursor before subscribing after it. Promotions
        // and reverts committed while this tab was closed are skipped by the new subscription.
        await requestSnapshot(activeSessionID, "full", { authoritative: true })
        await connect()
      } catch {
        schedule(() => void prime())
      }
    }

    void prime()

    onCleanup(() => {
      stopped = true
      streamAbort?.abort()
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
    })
  })

  createEffect(() => {
    const sessionID = input.sessionID()
    if (!sessionID) return
    onCleanup(sync().session.holdStatusSettlement(sessionID))
  })

  createEffect(() => {
    const sessionID = input.sessionID()
    const client = sdk().client
    const captured = owner.capture()
    if (!sessionID) return
    const statusVersion = sync().session.statusRevision(sessionID)
    void client.v2.session
      .active()
      .then((response) => {
        if (!captured.current()) return
        const next = sessionActiveSnapshotStatus({
          requestedVersion: statusVersion,
          currentVersion: sync().session.statusRevision(sessionID),
          active: !!response.data?.data[sessionID],
        })
        if (!next) return
        batch(() => {
          setSessionStatus(sessionID, next)
          if (next.type !== "idle") sessionPromptStartup.clearSession(sessionID)
        })
        if (!shouldPollSessionUntilIdle(next)) return
        pollUntilIdle(sessionID)
      })
      .catch(() => {
        if (captured.current() && input.sessionID() === sessionID) pollUntilIdle(sessionID)
      })
  })

  onCleanup(() => {
    if (refreshFrame !== undefined) cancelAnimationFrame(refreshFrame)
    polls.forEach((timer) => window.clearTimeout(timer))
    polls.clear()
    polling.clear()
    pollingVersions.clear()
    snapshotAborts.forEach((abort) => abort.abort())
    snapshotAborts.clear()
    snapshots.clear()
    restaked.clear()
    authoritativeRetries.clear()
    pendingProjectionIDs.clear()
    deltaBases.clear()
    windows.clear()
    orphans.clear()
  })

  return { hydrate, loadOlder, hasOlder }
}

export type SessionV2TimelineController = ReturnType<typeof createSessionV2TimelineController>

export function sessionActiveSnapshotStatus(input: {
  requestedVersion: number
  currentVersion: number
  active: boolean
}): SessionStatus | undefined {
  if (input.currentVersion !== input.requestedVersion) return
  return input.active ? { type: "busy" } : { type: "idle" }
}

export function shouldPollSessionUntilIdle(status: SessionStatus | undefined) {
  return status?.type === "busy"
}

export async function commitSessionIdleAfterRefresh(input: {
  refresh: () => Promise<void>
  current: () => boolean
  commit: () => void
}) {
  await input.refresh()
  if (!input.current()) return false
  input.commit()
  return true
}

/**
 * How one durable event moves the session's busy indicator.
 *
 * `busy` marks the session working straight away. `poll` hands the decision back to the server by
 * asking `v2.session.active()` until it stops reporting the session, so an indicator is only ever
 * taken down on the server's word rather than on the client's guess about what should follow.
 *
 * Compaction is why the two flags are separate rather than one "started/ended" rule. It is the one
 * phase that runs *outside* the turn lifecycle: `V2Session.compact` awaits the summariser directly
 * and `V2Session.active` reports agent execution and shells only. So `compaction.started` has to
 * mark the session busy *without* arming a poll, because that poll would ask an endpoint that
 * never reports compaction, immediately answer "idle", and erase the indicator it just set.
 * `compaction.ended` polls rather than forcing idle, which is what keeps automatic compaction
 * right: there a turn is still running, so `active()` still reports the session and the indicator
 * correctly stays up until the turn itself ends.
 *
 * Automatic compaction needs no case of its own -- it runs inside a turn that already holds the
 * session busy. The gap this closes is the manual `/compact`, which until now left the session
 * reading `idle` for the whole multi-second summarisation.
 *
 * A declined compaction publishes `started` and then returns without ever publishing `ended`
 * (`core/session/compaction.ts` `decline`), so this table alone cannot close a failed manual
 * compaction. `use-session-commands.tsx` settles that one when the request resolves.
 */
/**
 * The retry notice, translated into the status shape the timeline already renders.
 *
 * V1 delivered this over the legacy `session.status` bus as transient in-process state, which is
 * why a V2 session hitting a rate limit showed nothing at all. Here it arrives as a durable
 * session event on the same stream as the transcript, so it replays, it survives the process that
 * scheduled the wait, and a second viewer of a shared session sees the same countdown.
 *
 * `next` is absolute epoch milliseconds because that is what `SessionRetry` counts down from; the
 * event carries a delay relative to its own timestamp so the durable log does not assert a
 * wall-clock instant, and the two are reconciled here.
 */
type SessionStatusRetryAction = NonNullable<Extract<SessionStatus, { type: "retry" }>["action"]>

export function sessionEventRetryStatus(event: SessionDurableEvent): SessionStatus | undefined {
  if (event.type !== "session.next.retried") return undefined
  const data = event.data as {
    attempt?: number
    delay?: number
    timestamp?: number
    error?: { message?: string }
    action?: SessionStatusRetryAction
  }
  const timestamp = typeof data.timestamp === "number" ? data.timestamp : Date.now()
  return {
    type: "retry",
    attempt: typeof data.attempt === "number" ? data.attempt : 1,
    message: data.error?.message ?? "",
    next: timestamp + (typeof data.delay === "number" ? data.delay : 0),
    ...(data.action ? { action: data.action } : {}),
  }
}

export function sessionEventStatusTransition(
  type: string,
): { readonly busy: boolean; readonly poll: boolean } | undefined {
  switch (type) {
    case "session.next.step.started":
      return { busy: true, poll: true }
    case "session.next.shell.started":
    case "session.next.compaction.started":
      return { busy: true, poll: false }
    case "session.next.step.ended":
    case "session.next.step.failed":
    case "session.next.shell.ended":
    case "session.next.compaction.ended":
    case "session.next.compaction.failed":
      return { busy: false, poll: true }
    default:
      return undefined
  }
}

/**
 * A prompt sent while a turn runs is admitted immediately (`session.next.prompt.admitted`,
 * with `delivery` "steer" or "queue") but only joins the turn later, when the runner
 * promotes it and publishes `session.next.prompted`. Between the two events the message is
 * visible in the transcript yet not being acted on, which is worth saying out loud under
 * the message row. This maps one durable event to the pending-state change it implies.
 */
/**
 * What the live turn is doing right now, folded from the same durable stream the
 * controller already drains. This is the whole input to the transcript's status line —
 * each flag or list is set by a `started` event and cleared by its `ended`/settlement,
 * and a step boundary resets the stream-scoped state (a provider call's reasoning, text
 * and tool calls cannot carry over into the next call).
 *
 * `agentCalls` tracks the subagent orchestration tools separately: they mean "waiting on
 * agents", not "running a tool", and their lifecycle doubles as the signal that the task
 * list may have changed. `agentToolEvents` increments on every subagent-tool start and
 * settlement so the Subagents panel can reconcile immediately instead of waiting for a
 * remount — the durable stream is the one channel these events provably reach the
 * renderer on.
 */
export type TurnToolCall = { readonly callID: string; readonly tool: string }

/**
 * The last compaction that did not produce a checkpoint, for the session it happened in.
 *
 * Kept here rather than only shown as a toast because a failed compaction is a fact about the
 * conversation, not about the click that started it: the user needs to know their history was
 * *not* compacted, and why, whether or not they were looking at the toast. `detail` is the
 * provider's own message when there was one — `reason` alone cannot distinguish an expired key
 * from a prompt the provider rejected outright.
 */
export type TurnCompactionFailure = {
  readonly reason: string
  readonly detail?: string
}

export type TurnActivity = {
  readonly reasoning: boolean
  readonly writing: boolean
  readonly compacting: boolean
  readonly compactionFailure?: TurnCompactionFailure
  readonly retrying: boolean
  /** Running non-subagent tool calls, in start order. */
  readonly tools: readonly TurnToolCall[]
  /** Running subagent orchestration calls (spawn/send/wait/interrupt). */
  readonly agentCalls: readonly TurnToolCall[]
  /** Bumped on every subagent-tool start and settlement; drives task-list reconciles. */
  readonly agentToolEvents: number
}

export const emptyTurnActivity: TurnActivity = {
  reasoning: false,
  writing: false,
  compacting: false,
  retrying: false,
  tools: [],
  agentCalls: [],
  agentToolEvents: 0,
}

const TURN_AGENT_TOOLS = new Set(["spawn_agent", "send_agent", "wait_agents", "interrupt_agent"])
const TURN_AGENT_WAIT_TOOLS = new Set(["spawn_agent", "wait_agents"])

function startTurnTool(activity: TurnActivity, callID: string, tool: string): TurnActivity {
  if (TURN_AGENT_TOOLS.has(tool)) {
    if (activity.agentCalls.some((call) => call.callID === callID)) return activity
    return {
      ...activity,
      agentCalls: [...activity.agentCalls, { callID, tool }],
      agentToolEvents: activity.agentToolEvents + 1,
    }
  }
  if (activity.tools.some((call) => call.callID === callID && call.tool === tool)) return activity
  return { ...activity, tools: [...activity.tools.filter((call) => call.callID !== callID), { callID, tool }] }
}

function settleTurnTool(activity: TurnActivity, callID: string): TurnActivity {
  if (activity.agentCalls.some((call) => call.callID === callID))
    return {
      ...activity,
      agentCalls: activity.agentCalls.filter((call) => call.callID !== callID),
      agentToolEvents: activity.agentToolEvents + 1,
    }
  if (!activity.tools.some((call) => call.callID === callID)) return activity
  return { ...activity, tools: activity.tools.filter((call) => call.callID !== callID) }
}

export function reduceTurnActivity(activity: TurnActivity, event: SessionDurableEvent): TurnActivity {
  switch (event.type) {
    case "session.next.reasoning.started":
      return activity.reasoning ? activity : { ...activity, reasoning: true }
    case "session.next.reasoning.ended":
      return activity.reasoning ? { ...activity, reasoning: false } : activity
    case "session.next.text.started":
      return activity.writing ? activity : { ...activity, writing: true }
    case "session.next.text.ended":
      return activity.writing ? { ...activity, writing: false } : activity
    case "session.next.compaction.started":
      // A new attempt clears the previous verdict: whatever the transcript is about to say, it is
      // about this compaction.
      return { ...activity, compacting: true, compactionFailure: undefined }
    case "session.next.compaction.ended":
      return activity.compacting || activity.compactionFailure
        ? { ...activity, compacting: false, compactionFailure: undefined }
        : activity
    case "session.next.compaction.failed":
      // `interrupted` is the user's own doing and needs no explanation in the transcript.
      return {
        ...activity,
        compacting: false,
        ...(event.data.reason === "interrupted"
          ? { compactionFailure: undefined }
          : {
              compactionFailure: {
                reason: event.data.reason,
                ...(typeof event.data.detail === "string" && event.data.detail.length > 0
                  ? { detail: event.data.detail }
                  : {}),
              },
            }),
      }
    case "session.next.retried":
      return activity.retrying ? activity : { ...activity, retrying: true }
    // `tool.input.started` is the earliest sight of a call (its args are still
    // streaming); `tool.called` re-confirms it with the same callID at execution.
    case "session.next.tool.input.started":
      return startTurnTool(activity, event.data.callID, event.data.name)
    case "session.next.tool.called":
      return startTurnTool(activity, event.data.callID, event.data.tool)
    case "session.next.tool.success":
    case "session.next.tool.failed":
      return settleTurnTool(activity, event.data.callID)
    case "session.next.step.started":
      // A new provider call: the retry it announces the end of is over, and no stream
      // state survives the boundary. A compaction verdict from an earlier turn is stale too --
      // the user has moved on, and the notice must not follow them down the transcript.
      return { ...activity, retrying: false, reasoning: false, writing: false, compactionFailure: undefined }
    case "session.next.step.ended":
    case "session.next.step.failed":
      return {
        ...activity,
        reasoning: false,
        writing: false,
        tools: [],
        agentCalls: [],
        // A defensive settlement: if any agent call was still tracked, tell the panel.
        agentToolEvents: activity.agentToolEvents + (activity.agentCalls.length > 0 ? 1 : 0),
      }
    default:
      return activity
  }
}

/**
 * The status line's single answer, highest-priority truth first. `questionPending` and
 * `agentsActive` come from renderer state the durable stream cannot see (the question
 * dock derivation and the Subagents panel's active count); everything else folds out of
 * `TurnActivity`. When the panel has not caught up yet but an orchestration call is
 * already running, the running calls stand in for the count.
 */
export type TurnStatus =
  | { readonly kind: "question" }
  | { readonly kind: "agents"; readonly count: number }
  | { readonly kind: "compacting" }
  | { readonly kind: "retrying" }
  | { readonly kind: "tool"; readonly tool: string }
  | { readonly kind: "thinking" }
  | { readonly kind: "writing" }
  | { readonly kind: "working" }

export function sessionTurnStatus(input: {
  questionPending: boolean
  agentsActive: number
  activity: TurnActivity
}): TurnStatus {
  if (input.questionPending) return { kind: "question" }
  const waiting = input.activity.agentCalls.filter((call) => TURN_AGENT_WAIT_TOOLS.has(call.tool))
  if (input.agentsActive > 0 || waiting.length > 0)
    return { kind: "agents", count: input.agentsActive > 0 ? input.agentsActive : waiting.length }
  if (input.activity.compacting) return { kind: "compacting" }
  if (input.activity.retrying) return { kind: "retrying" }
  const tool = input.activity.tools[input.activity.tools.length - 1]
  if (tool) return { kind: "tool", tool: tool.tool }
  if (input.activity.reasoning) return { kind: "thinking" }
  if (input.activity.writing) return { kind: "writing" }
  return { kind: "working" }
}

export function createSessionTurnActivityStore() {
  const [activity, setActivity] = createStore<Record<string, TurnActivity | undefined>>({})
  const update = (sessionID: string, next: TurnActivity) => {
    if (next !== (activity[sessionID] ?? emptyTurnActivity)) setActivity(sessionID, next)
  }
  return {
    get: (sessionID: string) => activity[sessionID] ?? emptyTurnActivity,
    reduce: (sessionID: string, event: SessionDurableEvent) => {
      const current = activity[sessionID] ?? emptyTurnActivity
      update(sessionID, reduceTurnActivity(current, event))
    },
    /**
     * Drive the compaction state from the request rather than the event stream.
     *
     * Manual compaction runs outside any turn and can decline before it publishes a single durable
     * event -- an unknown context window, an empty conversation, a busy session -- so the durable
     * stream is not a complete account of it. Without this the user gets a transcript that never
     * acknowledged the `/compact` they ran. The command sets it when the request starts and clears
     * it when the request settles; the durable events remain authoritative while they flow.
     */
    setCompacting: (sessionID: string, compacting: boolean) => {
      const current = activity[sessionID] ?? emptyTurnActivity
      if (current.compacting === compacting) return
      update(sessionID, { ...current, compacting })
    },
    setCompactionFailure: (sessionID: string, failure: TurnCompactionFailure | undefined) => {
      const current = activity[sessionID] ?? emptyTurnActivity
      if (current.compactionFailure === failure) return
      update(sessionID, { ...current, compactionFailure: failure })
    },
    reset: (sessionID: string) => setActivity(sessionID, undefined),
  }
}

/** Module-scoped for the same reasons as `sessionPromptPending` above. */
export const sessionTurnActivity = createSessionTurnActivityStore()

export function sessionEventCommitsRevert(event: SessionDurableEvent) {
  if (event.type === "session.next.revert.committed") return true
  if (event.type !== "session.next.prompt.admitted" && event.type !== "session.next.goal.updated") return false
  const data = event.data as Record<string, unknown>
  if (event.type === "session.next.prompt.admitted") return data.revert !== undefined
  if (!data.admission || typeof data.admission !== "object") return false
  return "revert" in data.admission && data.admission.revert !== undefined
}

export function parseDurableEvent(value: unknown): SessionDurableEvent | undefined {
  if (isDurableEvent(value)) return value
  if (!value || typeof value !== "object" || !("data" in value)) return
  const data = value.data
  if (typeof data !== "string") return isDurableEvent(data) ? data : undefined
  try {
    const parsed: unknown = JSON.parse(data)
    return isDurableEvent(parsed) ? parsed : undefined
  } catch {
    return
  }
}

export function sessionUnprojectedInputIDs(
  projectedMessageIDs: ReadonlySet<string>,
  pendingInputs: ReadonlyArray<{ readonly id: string }>,
) {
  return new Set(pendingInputs.filter((pending) => !projectedMessageIDs.has(pending.id)).map((pending) => pending.id))
}

function isDurableEvent(value: unknown): value is SessionDurableEvent {
  if (!value || typeof value !== "object") return false
  if (!("type" in value) || typeof value.type !== "string" || !value.type.startsWith("session.next.")) return false
  return "data" in value && typeof value.data === "object" && value.data !== null
}

export function mergeSessionV2LiveText(snapshot: string, visible: string | undefined, delta: string) {
  if (visible && snapshot.startsWith(visible)) return snapshot
  if (visible && visible.startsWith(snapshot)) return visible
  if (!delta || snapshot.endsWith(delta)) return snapshot
  return snapshot + delta
}

export function createSessionSnapshotQueue(
  run: (sessionID: string, mode: SnapshotMode, authoritative: boolean) => Promise<void>,
) {
  const jobs = new Map<string, SnapshotJob>()

  const request = (sessionID: string, mode: SnapshotMode, options?: SnapshotOptions) => {
    const job = jobs.get(sessionID) ?? { waiting: [] }
    jobs.set(sessionID, job)
    const result = new Promise<void>((resolve, reject) => {
      const pending = job.pending
      job.pending = {
        mode: pending?.mode === "full" || mode === "full" ? "full" : "context",
        authoritative: pending?.authoritative === true || options?.authoritative === true,
        waiters: [...(pending?.waiters ?? []), { resolve, reject }],
      }
    })
    if (job.running) return result

    const drain = async () => {
      while (job.pending) {
        const next = job.pending
        job.pending = undefined
        job.active = next.waiters
        try {
          await run(sessionID, next.mode, next.authoritative)
          if (job.cancelled) next.waiters.forEach((waiter) => waiter.reject(new DOMException("Aborted", "AbortError")))
          else job.waiting.push(...next.waiters)
        } catch (error) {
          next.waiters.forEach((waiter) => waiter.reject(error))
          job.waiting.forEach((waiter) => waiter.reject(error))
          job.waiting.length = 0
        } finally {
          job.active = undefined
        }
      }
      job.running = undefined
      if (jobs.get(sessionID) === job) jobs.delete(sessionID)
      const waiting = job.waiting.splice(0)
      waiting.forEach((waiter) => waiter.resolve())
    }
    const running = drain()
    job.running = running
    return result
  }

  return {
    request,
    clear: () => {
      jobs.forEach((job) => {
        job.cancelled = true
        const error = new DOMException("Aborted", "AbortError")
        job.active?.forEach((waiter) => waiter.reject(error))
        job.waiting.forEach((waiter) => waiter.reject(error))
        job.pending?.waiters.forEach((waiter) => waiter.reject(error))
        job.waiting.length = 0
        job.pending = undefined
      })
      jobs.clear()
    },
  }
}

export function nextSessionEventRetry(delay: number) {
  return Math.min(delay * 2, 5_000)
}
