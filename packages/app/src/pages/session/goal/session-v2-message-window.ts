import type { SessionMessage } from "@turenlabs/sdk/v2/client"

/**
 * How much transcript the renderer pulls when a session tab opens.
 *
 * The timeline is virtualised: `message-timeline.tsx` builds rows for every message but hands the
 * virtualizer a window of a few dozen, so all but a screenful of the work is thrown away. Draining
 * the whole history to fill it is therefore not a correctness requirement, it is a cost with no
 * reader — and on a big session it is the entire tab-switch stall. A 1,952-message session in a
 * real database holds 228 MiB of message bodies; 81% of those bytes live in 3% of the messages,
 * which the shipped drain parses, transforms and stores before showing a single row.
 *
 * So this module loads the *newest* page and pages backwards on demand. The server already
 * supports it: `order: "desc"` starts at the latest message and `cursor.next` walks towards the
 * beginning of the session (packages/server/src/handlers/message.ts).
 */

export const SESSION_V2_MESSAGE_PAGE_LIMIT = 50

/**
 * Pages walked before a window gives up looking for a turn boundary.
 *
 * The loop below extends the window backwards until it opens on a message that starts a turn.
 * A transcript of nothing but assistant messages — which no runner produces, but a corrupt or
 * truncated one could — would otherwise walk the entire session and reintroduce the stall this
 * module exists to remove. The cap turns that into a bounded overshoot.
 */
export const SESSION_V2_WINDOW_PAGE_LIMIT = 8

export type SessionV2MessagePage<T> = {
  data: ReadonlyArray<T>
  cursor: { next?: string; previous?: string }
}

export type SessionV2MessageWindow<T> = {
  /** Oldest to newest, the order the timeline projects. */
  readonly messages: T[]
  /** Cursor for the next page of *older* messages; absent once the session start is loaded. */
  readonly older?: string
  /** True when `messages` reaches the first message of the session. */
  readonly complete: boolean
}

/**
 * Does this message open a turn?
 *
 * `presentSessionV2Messages` parents each assistant message to the last user-ish message it saw
 * and **drops** assistant messages that have none (`if (message.type !== "assistant" || !userID)
 * return`). A window that begins in the middle of a turn would therefore silently lose its leading
 * assistant messages — the user would scroll up and find replies missing, not merely unloaded.
 * Extending the window back to a turn boundary is what makes windowing safe.
 */
export function startsSessionV2Turn(message: SessionMessage) {
  return (
    (message.type === "user" && message.source !== "subagent_board") ||
    message.type === "shell" ||
    message.type === "compaction"
  )
}

/**
 * Walk pages until the window is big enough and opens cleanly, then return it oldest-first.
 *
 * `minimum` is a floor, not a target: a refresh passes the count it already had so re-projecting a
 * session never shrinks what the user was looking at. `until` pins the far edge exactly — after the
 * user has paged back through history, a live update re-requests the same span by message ID rather
 * than by count, so appended messages slide the window forward without dropping its tail.
 */
export async function loadSessionV2MessageWindow<T extends SessionMessage>(input: {
  /** Serves pages newest-first; `cursor` continues an earlier walk backwards. */
  load: (cursor?: string) => Promise<SessionV2MessagePage<T>>
  minimum?: number
  /** Continue an existing window from its `older` cursor instead of starting at the newest page. */
  cursor?: string
  /** Keep paging until this message ID is inside the window. */
  until?: string
  pageLimit?: number
}): Promise<SessionV2MessageWindow<T>> {
  const minimum = input.minimum ?? SESSION_V2_MESSAGE_PAGE_LIMIT
  const pageLimit =
    input.pageLimit ?? Math.max(SESSION_V2_WINDOW_PAGE_LIMIT, Math.ceil(minimum / SESSION_V2_MESSAGE_PAGE_LIMIT) + 1)
  // Newest-first while walking; reversed once, at the end.
  const collected: T[] = []
  let cursor = input.cursor
  let older: string | undefined
  let complete = false
  let reachedUntil = input.until === undefined
  let pages = 0

  while (pages < pageLimit) {
    const page = await input.load(cursor)
    pages += 1
    collected.push(...page.data)
    if (input.until !== undefined && page.data.some((message) => message.id === input.until)) reachedUntil = true
    if (page.data.length === 0 || !page.cursor.next) {
      complete = true
      older = undefined
      break
    }
    cursor = page.cursor.next
    older = page.cursor.next
    // The window needs *a* turn boundary, not one exactly at its edge.
    //
    // Requiring the oldest message to start a turn would extend the window by a whole page
    // whenever a page boundary fell mid-turn — which, at ~19 messages per turn and 200 per page,
    // is almost always. That turned a 200-message window into a 1,600-message one.
    //
    // The leading partial turn is kept rather than trimmed. `presentSessionV2Messages` will not
    // project those assistant messages until their parent user message arrives, so they are
    // invisible for now and correctly parented once the older page loads. Trimming them instead
    // would strand them: `older` is an opaque server cursor pointing past the whole page, so
    // anything dropped from the page's old end could never be requested again.
    if (collected.length >= minimum && reachedUntil && collected.some(startsSessionV2Turn)) break
  }

  return { messages: collected.reverse(), older, complete }
}

/**
 * `loadSessionV2MessageWindow` bound to the SDK's message endpoint.
 *
 * `order` is sent only on the first request and `cursor` only on the rest, because the server
 * rejects the two together — the cursor already encodes the order it was minted under
 * (packages/server/src/handlers/message.ts: "Cursor cannot be combined with order").
 */
export async function loadSessionV2Window(input: {
  sessionID: string
  signal: AbortSignal
  request: (
    payload: { sessionID: string; limit: number; order?: "desc"; cursor?: string },
    options: { signal: AbortSignal },
  ) => Promise<{ data?: { data: ReadonlyArray<SessionMessage>; cursor: { next?: string } } }>
  minimum?: number
  cursor?: string
  until?: string
}) {
  return loadSessionV2MessageWindow({
    load: async (cursor) => {
      const response = await input.request(
        {
          sessionID: input.sessionID,
          limit: SESSION_V2_MESSAGE_PAGE_LIMIT,
          ...(cursor ? { cursor } : { order: "desc" as const }),
        },
        { signal: input.signal },
      )
      return response.data!
    },
    minimum: input.minimum,
    cursor: input.cursor,
    until: input.until,
  })
}

/**
 * Drain every page from a cursor, iteratively.
 *
 * Retained because the *ascending* full read is still the right answer for a small session and for
 * callers that genuinely need the whole transcript, and because the benchmark measures the fix
 * against it. The previous implementation recursed and rebuilt the accumulator on every page
 * (`[...page.data, ...(await collect(next))]`), which is O(pages²) in array writes and grows the
 * call stack with the transcript; this is neither.
 */
export async function collectSessionV2Messages<T>(
  load: (cursor?: string) => Promise<{ data: ReadonlyArray<T>; cursor: { next?: string } }>,
  cursor?: string,
): Promise<T[]> {
  const collected: T[] = []
  let next = cursor
  for (;;) {
    const page = await load(next)
    collected.push(...page.data)
    if (!page.cursor.next) return collected
    next = page.cursor.next
  }
}
