import type { Message, Part, SessionMessage } from "@turenlabs/sdk/v2/client"
import { createRoot, createSignal, batch } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { mergeSessionV2Presentation, presentSessionV2Messages } from "../goal/session-v2-presentation"
import { createTimelineProjection } from "../timeline/projection"
import { leanSessionMessage } from "./session-load-fixture"

/**
 * The tab-switch pipeline, cut into the stages a fix could plausibly target, each timed on its own.
 *
 * The stages mirror `createSessionV2TimelineController`'s snapshot path exactly:
 *
 *   paging   `collectSessionV2Messages` — the cursor walk and its array accumulation
 *   parse    `JSON.parse` per page, as `client.gen.ts` does after `response.text()`
 *   present  `presentSessionV2Messages` — SessionMessage[] to Message[] + Part[][]
 *   merge    `mergeSessionV2Presentation` — the incoming projection against what the store holds
 *   store    the batched `set("message", …)` / per-message `set("part", …)` writes
 *   rows     `createTimelineProjection().rows()` — what the virtualizer counts
 *
 * Network time is deliberately excluded. It was measured separately against the live server (11
 * pages, 228.9 MB, 1.27s wall) and is not what this harness is looking for; everything here is the
 * renderer-side work that happens once the bytes have landed.
 */
export type StageTimings = {
  readonly paging: number
  readonly parse: number
  readonly present: number
  readonly merge: number
  readonly store: number
  readonly rows: number
  readonly total: number
}

export type StageResult = {
  readonly timings: StageTimings
  readonly messagesLoaded: number
  readonly partsLoaded: number
  readonly rowCount: number
  readonly bytesParsed: number
}

export type PagedLoader = (cursor?: string) => Promise<{
  data: ReadonlyArray<SessionMessage>
  cursor: { next?: string; previous?: string }
}>

/**
 * A stand-in for `client.v2.session.messages` that serves pre-serialised pages.
 *
 * Pages are JSON text rather than objects because parsing is one of the stages under test: handing
 * back live objects would hide it. `order` selects which end of the transcript page one comes from,
 * matching the server, where a `desc` walk starts at the newest message and `cursor.next` moves
 * backwards through history.
 */
export function createPageServer(
  messages: readonly SessionMessage[],
  limit: number,
  order: "asc" | "desc",
  options?: { lean?: boolean },
) {
  const source = order === "asc" ? messages : [...messages].reverse()
  let bytes = 0
  let requests = 0
  let parseMs = 0
  let serializeMs = 0

  const offset = (cursor?: string) => (cursor === undefined ? 0 : Number(cursor))

  return {
    get requests() {
      return requests
    },
    get bytesServed() {
      return bytes
    },
    /** Time spent inside `JSON.parse`, the share of the load stage the transport really pays. */
    get parseMs() {
      return parseMs
    },
    /**
     * Time spent turning fixture objects back into wire text. Pure harness overhead — the real
     * server serialises on another machine — so the benchmark subtracts it from the load stage.
     */
    get serializeMs() {
      return serializeMs
    },
    /**
     * Pages are serialised on demand rather than up front. Holding every page of a 228 MiB
     * transcript as text *and* as objects pushed this process into swap, where wall-clock time
     * stops describing the pipeline and starts describing the page cache.
     */
    load: ((cursor?: string) => {
      requests += 1
      const start = offset(cursor)
      const slice = source.slice(start, start + limit)
      const serializeStart = now()
      // `lean` serves the `session.messages?lean=true` payload: oversized tool bodies are stubbed
      // before serialisation, matching the server handler.
      const text = JSON.stringify(options?.lean ? slice.map(leanSessionMessage) : slice)
      serializeMs += now() - serializeStart
      bytes += text.length
      const parseStart = now()
      const data = JSON.parse(text) as SessionMessage[]
      parseMs += now() - parseStart
      const nextStart = start + limit
      return Promise.resolve({
        data,
        cursor: { next: data.length > 0 ? String(nextStart) : undefined },
      })
    }) satisfies PagedLoader,
  }
}

function now() {
  return performance.now()
}

/**
 * Run the pipeline over a message list and time each stage.
 *
 * `load` decides how much history reaches the renderer, which is the whole variable under test: the
 * shipped controller drains every page, the fix takes a window. Everything downstream is identical
 * either way, so a difference in the later stages is a real consequence of the loading strategy and
 * not of measuring two different code paths.
 */
export async function measureSessionLoad(input: {
  sessionID: string
  load: () => Promise<SessionMessage[]>
  showReasoning?: boolean
  /** Milliseconds the loader spent inside `JSON.parse`, reported as a share of `paging`. */
  parseMs?: () => number
  bytes?: () => number
  /** Harness-only cost inside `load`, subtracted from the reported paging time. */
  overheadMs?: () => number
}): Promise<StageResult> {
  const sessionID = input.sessionID
  const started = now()
  const loaded = await input.load()
  const afterLoad = now()

  const presentStart = now()
  const presentation = presentSessionV2Messages({
    sessionID,
    directory: "/repo",
    agent: "build",
    model: { providerID: "anthropic", modelID: "claude-opus-5" },
    messages: loaded,
    pendingInputs: [],
  })
  const presentEnd = now()

  const [store, setStore] = createStore<{
    message: Record<string, Message[]>
    part: Record<string, Part[]>
  }>({ message: {}, part: {} })

  const mergeStart = now()
  const projection = mergeSessionV2Presentation({
    messages: store.message[sessionID] ?? [],
    parts: store.part,
    previousOwnedMessageIDs: new Set<string>(),
    presentation,
    preservedMessageIDs: new Set<string>(),
    removeMissing: true,
  })
  const mergeEnd = now()

  const storeStart = now()
  batch(() => {
    setStore("message", sessionID, reconcile(projection.messages, { key: "id" }))
    presentation.parts.forEach((entry) => {
      setStore("part", entry.id, reconcile(entry.parts, { key: "id" }))
    })
  })
  const storeEnd = now()

  const rowsStart = now()
  const rowCount = createRoot((dispose) => {
    const [messages] = createSignal(store.message[sessionID] ?? [])
    const timeline = createTimelineProjection({
      messages,
      userMessages: () => messages().filter((message) => message.role === "user"),
      parts: (messageID: string) => store.part[messageID] ?? [],
      status: () => ({ type: "idle" }),
      starting: () => false,
      showReasoningSummaries: () => input.showReasoning ?? true,
      inlineComments: () => true,
    })
    const count = timeline.rows().length
    dispose()
    return count
  })
  const rowsEnd = now()

  const parts = presentation.parts.reduce((total, entry) => total + entry.parts.length, 0)
  const overhead = input.overheadMs?.() ?? 0
  const paging = afterLoad - started - overhead
  return {
    timings: {
      // Paging covers the cursor walk, its array accumulation, and `JSON.parse`; `parse` reports
      // the share of it the page server attributes to parsing alone.
      paging,
      parse: input.parseMs?.() ?? 0,
      present: presentEnd - presentStart,
      merge: mergeEnd - mergeStart,
      store: storeEnd - storeStart,
      rows: rowsEnd - rowsStart,
      total: rowsEnd - started - overhead,
    },
    messagesLoaded: loaded.length,
    partsLoaded: parts,
    rowCount,
    bytesParsed: input.bytes?.() ?? 0,
  }
}

/** Time `JSON.parse` alone over the same page texts the loader would receive. */
export function measureParse(pages: readonly string[]) {
  const started = now()
  let messages = 0
  pages.forEach((text) => {
    messages += (JSON.parse(text) as SessionMessage[]).length
  })
  return { ms: now() - started, messages }
}

export function formatStages(label: string, result: StageResult, extra?: Record<string, string | number>) {
  const t = result.timings
  const row = (name: string, value: number) => `  ${name.padEnd(9)} ${value.toFixed(1).padStart(9)} ms`
  return [
    `${label}`,
    row("load", t.paging),
    row("· parse", t.parse),
    row("present", t.present),
    row("merge", t.merge),
    row("store", t.store),
    row("rows", t.rows),
    row("TOTAL", t.total),
    `  messages=${result.messagesLoaded} parts=${result.partsLoaded} rows=${result.rowCount}` +
      (extra
        ? " " +
          Object.entries(extra)
            .map(([key, value]) => `${key}=${value}`)
            .join(" ")
        : ""),
  ].join("\n")
}
