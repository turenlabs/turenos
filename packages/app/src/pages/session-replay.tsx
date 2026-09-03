import type { SessionReplayEntry, SessionReplayEvent, SessionReplaySearchResponse } from "@turenlabs/sdk/v2/client"
import { ButtonV2 } from "@turenlabs/ui/v2/button-v2"
import { Icon as IconV2 } from "@turenlabs/ui/v2/icon"
import { createVirtualizer } from "@tanstack/solid-virtual"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useAgentsPanel } from "@/components/agents-panel-state"
import { PageHeader } from "@/components/page-header"
import { toLegacySummary } from "@/context/global-sync/home-session-index"
import { ServerConnection } from "@/context/server"
import {
  mergeReplayEvents,
  replayEventLabel,
  replayEventPreview,
  replayEventSequence,
  replayEventTimestamp,
  replayEventTone,
  replayMatchPreview,
  replayStats,
} from "./session-replay-model"

const PAGE_SIZE = 100
const time = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
})

export default function SessionReplayPage() {
  const panel = useAgentsPanel()
  const [query, setQuery] = createSignal("")
  const [selected, setSelected] = createSignal<SessionReplayEntry["session"]>()
  const [cursor, setCursor] = createSignal(0)
  const [playing, setPlaying] = createSignal(false)
  const [speed, setSpeed] = createSignal(1)
  const [search, setSearch] = createStore({
    entries: [] as SessionReplayEntry[],
    total: 0,
    nextCursor: undefined as string | undefined,
    query: "",
    index: undefined as SessionReplaySearchResponse["index"] | undefined,
    loading: false,
    error: undefined as string | undefined,
  })
  const [history, setHistory] = createStore({
    events: [] as SessionReplayEvent[],
    previousCursor: undefined as string | undefined,
    nextCursor: undefined as string | undefined,
    loading: false,
    error: undefined as string | undefined,
  })
  let searchAbort: AbortController | undefined
  let historyAbort: AbortController | undefined
  let debounce: ReturnType<typeof setTimeout> | undefined
  let historyServer: string | undefined

  const runSearch = (append = false) => {
    searchAbort?.abort()
    const ctx = panel.focusedServerCtx()
    if (!ctx) {
      setSearch({
        entries: [],
        total: 0,
        nextCursor: undefined,
        query: "",
        index: undefined,
        loading: false,
        error: "Select a connected server.",
      })
      return
    }
    const requested = query().trim() || "is:session"
    if (append && search.query !== requested) {
      runSearch()
      return
    }
    const abort = new AbortController()
    searchAbort = abort
    const cursor = append ? search.nextCursor : undefined
    setSearch({ loading: true, error: undefined })
    void ctx.sdk.client.v2.session
      .replay(
        {
          query: requested,
          limit: String(PAGE_SIZE),
          ...(cursor === undefined ? {} : { cursor }),
        },
        { signal: abort.signal },
      )
      .then((response) => {
        if (abort.signal.aborted || !response.data) return
        setSearch({
          entries: append ? [...search.entries, ...response.data.data] : response.data.data,
          total: response.data.total,
          nextCursor: response.data.nextCursor,
          query: requested,
          index: response.data.index,
          loading: false,
          error: undefined,
        })
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return
        setSearch({ loading: false, error: errorMessage(error) })
      })
  }

  createEffect(() => {
    panel.focusedServerCtx()
    query()
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => runSearch(), 250)
  })

  createEffect(() => {
    const conn = panel.focusedServer()
    const key = conn && panel.focusedServerCtx() ? ServerConnection.key(conn) : undefined
    if (historyServer === undefined) {
      historyServer = key
      return
    }
    if (historyServer === key) return
    historyServer = key
    searchAbort?.abort()
    historyAbort?.abort()
    setSelected(undefined)
    setPlaying(false)
    setSearch({
      entries: [],
      total: 0,
      nextCursor: undefined,
      query: "",
      index: undefined,
      loading: false,
      error: undefined,
    })
    setHistory({ events: [], previousCursor: undefined, nextCursor: undefined, loading: false, error: undefined })
  })

  createEffect(() => {
    if (search.index?.status !== "indexing" || search.loading) return
    const refresh = setTimeout(() => runSearch(), 2_000)
    onCleanup(() => clearTimeout(refresh))
  })

  const loadHistory = (session: SessionReplayEntry["session"], target?: string) => {
    const ctx = panel.focusedServerCtx()
    if (!ctx) return
    historyAbort?.abort()
    const abort = new AbortController()
    historyAbort = abort
    setSelected(session)
    setPlaying(false)
    setCursor(0)
    setHistory({ events: [], previousCursor: undefined, nextCursor: undefined, loading: true, error: undefined })

    void ctx.sdk.client.v2.session
      .replayHistory(
        { sessionID: session.id, limit: String(PAGE_SIZE), ...(target === undefined ? {} : { anchor: target }) },
        { signal: abort.signal },
      )
      .then((response) => {
        if (abort.signal.aborted || !response.data) return
        const targetIndex = target === undefined ? 0 : response.data.data.findIndex((event) => event.id === target)
        setHistory({
          events: response.data.data,
          previousCursor: response.data.cursor.previous,
          nextCursor: response.data.cursor.next,
          loading: false,
        })
        setCursor(Math.max(0, targetIndex))
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return
        setHistory({ loading: false, error: errorMessage(error) })
      })
  }

  const loadMoreHistory = (resume = false) => {
    const ctx = panel.focusedServerCtx()
    const session = selected()
    const next = history.nextCursor
    const abort = historyAbort
    if (!ctx || !session || !next || !abort || history.loading) return
    setHistory({ loading: true, error: undefined })
    void ctx.sdk.client.v2.session
      .replayHistory({ sessionID: session.id, limit: String(PAGE_SIZE), cursor: next }, { signal: abort.signal })
      .then((response) => {
        if (abort.signal.aborted || !response.data || selected()?.id !== session.id) return
        setHistory({
          events: mergeReplayEvents(history.events, response.data.data),
          nextCursor: response.data.cursor.next,
          loading: false,
        })
        if (resume) setPlaying(true)
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return
        setHistory({ loading: false, error: errorMessage(error) })
      })
  }

  const loadPreviousHistory = (move = false) => {
    const ctx = panel.focusedServerCtx()
    const session = selected()
    const previous = history.previousCursor
    const abort = historyAbort
    if (!ctx || !session || !previous || !abort || history.loading) return
    setHistory({ loading: true, error: undefined })
    void ctx.sdk.client.v2.session
      .replayHistory(
        { sessionID: session.id, limit: String(PAGE_SIZE), cursor: previous, direction: "before" },
        { signal: abort.signal },
      )
      .then((response) => {
        if (abort.signal.aborted || !response.data || selected()?.id !== session.id) return
        const added = response.data.data.filter(
          (event) => !history.events.some((current) => current.id === event.id),
        ).length
        setHistory({
          events: mergeReplayEvents(response.data.data, history.events),
          previousCursor: response.data.cursor.previous,
          loading: false,
        })
        setCursor((value) => Math.max(0, value + added - (move ? 1 : 0)))
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return
        setHistory({ loading: false, error: errorMessage(error) })
      })
  }

  const selectEntry = (entry: SessionReplayEntry) => loadHistory(entry.session, entry.event?.id)
  const current = createMemo(() => history.events[cursor()])
  const stats = createMemo(() => replayStats(history.events, cursor()))

  createEffect(() => {
    if (!playing()) return
    const interval = setInterval(
      () => {
        setCursor((value) => {
          if (value < history.events.length - 1) return value + 1
          if (history.nextCursor) loadMoreHistory(true)
          setPlaying(false)
          return value
        })
      },
      Math.max(70, 650 / speed()),
    )
    onCleanup(() => clearInterval(interval))
  })

  onCleanup(() => {
    if (debounce) clearTimeout(debounce)
    searchAbort?.abort()
    historyAbort?.abort()
  })

  return (
    <main
      data-component="session-replay"
      class="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-v2-background-bg-base text-v2-text-text-base"
    >
      <PageHeader
        title="Session Traces"
        description="Search every durable event, then replay the root and linked task streams."
      />

      <div class="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(240px,42%)_minmax(0,1fr)] overflow-hidden lg:grid-cols-[340px_minmax(0,1fr)] lg:grid-rows-1">
        <aside class="flex min-h-0 flex-col border-b border-v2-border-border-subtle bg-v2-background-bg-layer-01 lg:border-b-0 lg:border-r">
          <div class="border-b border-v2-border-border-subtle px-4 pb-4 pt-4">
            <label class="block">
              <span class="sr-only">Replay query</span>
              <div class="flex min-h-10 items-start gap-2 rounded-[8px] border border-v2-border-border-base bg-v2-background-bg-base px-3 py-2 focus-within:border-v2-border-border-focus">
                <IconV2 name="magnifying-glass" size="small" class="mt-0.5 shrink-0 text-v2-icon-icon-muted" />
                <textarea
                  value={query()}
                  rows={2}
                  spellcheck={false}
                  placeholder="has:error after:24h tool:bash"
                  class="min-h-8 w-full resize-none bg-transparent font-mono text-[12px] leading-4 text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
                  onInput={(event) => setQuery(event.currentTarget.value)}
                />
              </div>
            </label>
            <div class="mt-3 flex flex-wrap gap-1.5">
              <QueryChip value="has:error after:24h" onSelect={setQuery} />
              <QueryChip value="type:tool status:failed" onSelect={setQuery} />
              <QueryChip value="is:session" onSelect={setQuery} />
            </div>
            <details class="mt-3 text-[10px] text-v2-text-text-muted">
              <summary class="cursor-default select-none outline-none hover:text-v2-text-text-base focus-visible:text-v2-text-text-base">
                Query language
              </summary>
              <p class="mt-2 font-mono leading-4 text-v2-text-text-faint">
                text &middot; session: &middot; type: &middot; agent: &middot; model: &middot; tool: &middot; status:
                &middot; path: &middot; after: &middot; before: &middot; has:error &middot; is:event
              </p>
              <p class="mt-1 leading-4">
                Quote spaces. Prefix a field with - to exclude it. Times accept ISO dates or 30m, 24h, 7d.
              </p>
            </details>
          </div>

          <Show when={search.index?.status === "indexing" && search.index} keyed>
            {(index) => (
              <div class="border-b border-v2-border-border-subtle bg-v2-background-bg-subtle px-4 py-3">
                <div class="flex items-center justify-between gap-3 text-[10px] uppercase tracking-[0.1em] text-v2-text-text-muted">
                  <span>Warming history index</span>
                  <span class="font-mono">{Math.floor(index.progress * 100)}%</span>
                </div>
                <div class="mt-2 h-1 overflow-hidden rounded-full bg-v2-background-bg-base">
                  <div
                    class="h-full rounded-full bg-v2-background-bg-inverse transition-[width] duration-300"
                    style={{ width: `${Math.max(1, index.progress * 100)}%` }}
                  />
                </div>
                <p class="mt-2 text-[10px] leading-4 text-v2-text-text-faint">
                  Newest history is indexed first. Replay remains available while older search results fill in.
                </p>
              </div>
            )}
          </Show>

          <div class="flex items-center justify-between border-b border-v2-border-border-subtle px-4 py-2 text-[10px] uppercase tracking-[0.12em] text-v2-text-text-muted">
            <span>{search.loading && search.entries.length === 0 ? "Indexing query" : `${search.total} matches`}</span>
            <Show when={search.loading}>
              <span class="text-v2-text-text-accent">Searching</span>
            </Show>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto p-2">
            <Show when={search.error}>
              <div class="m-2 border border-v2-state-border-danger bg-v2-state-bg-danger p-3 text-[12px] text-v2-state-fg-danger">
                {search.error}
              </div>
            </Show>
            <For each={search.entries}>
              {(entry) => (
                <SearchResult
                  entry={entry}
                  selected={() =>
                    selected()?.id === entry.session.id &&
                    (entry.event === undefined || current()?.id === entry.event.id)
                  }
                  onSelect={() => selectEntry(entry)}
                />
              )}
            </For>
            <Show when={search.nextCursor !== undefined}>
              <button
                type="button"
                class="mt-2 h-9 w-full rounded-[7px] text-[12px] text-v2-text-text-muted outline-none hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base focus-visible:ring-1 focus-visible:ring-v2-border-border-focus"
                disabled={search.loading}
                onClick={() => runSearch(true)}
              >
                {search.loading ? "Loading..." : "Load more matches"}
              </button>
            </Show>
          </div>
        </aside>

        <section class="flex min-h-0 min-w-0 flex-col">
          <Show
            when={selected()}
            fallback={
              <div class="flex h-full min-h-[360px] items-center justify-center p-8">
                <div class="max-w-md border-l-2 border-v2-border-border-focus pl-5">
                  <p class="text-[10px] uppercase tracking-[0.15em] text-v2-text-text-accent">No sequence selected</p>
                  <h2 class="mt-2 text-[22px] tracking-[-0.025em] [font-weight:620]">Choose a session or event.</h2>
                  <p class="mt-2 text-[13px] leading-5 text-v2-text-text-muted">
                    The left index searches titles, prompts, tool payloads, output paths, model metadata, and failures.
                  </p>
                </div>
              </div>
            }
          >
            {(session) => (
              <>
                <header class="flex flex-wrap items-center justify-between gap-3 border-b border-v2-border-border-subtle px-4 py-3 sm:px-5">
                  <div class="min-w-0">
                    <div class="flex items-center gap-2 text-[10px] uppercase tracking-[0.12em] text-v2-text-text-muted">
                      <span class="font-mono">{session().id}</span>
                      <span aria-hidden="true">/</span>
                      <span>
                        {history.loading ? `Loading ${history.events.length}` : `${history.events.length} loaded`}
                      </span>
                    </div>
                    <h2 class="mt-1 truncate text-[17px] [font-weight:620]">{session().title}</h2>
                  </div>
                  <ButtonV2
                    variant="outline"
                    size="normal"
                    icon="outline-square-arrow"
                    onClick={() => panel.openSession(toLegacySummary(session()))}
                  >
                    Open session
                  </ButtonV2>
                </header>

                <div class="flex flex-wrap items-center gap-2 border-b border-v2-border-border-subtle bg-v2-background-bg-layer-01 px-4 py-2 sm:px-5">
                  <button
                    type="button"
                    class="flex h-8 min-w-16 items-center justify-center rounded-[7px] bg-v2-background-bg-inverse px-3 text-[12px] text-v2-text-text-inverse disabled:opacity-40"
                    disabled={history.events.length < 2 && !history.nextCursor}
                    onClick={() => {
                      if (playing()) {
                        setPlaying(false)
                        return
                      }
                      if (cursor() >= history.events.length - 1 && history.nextCursor) {
                        loadMoreHistory(true)
                        return
                      }
                      if (cursor() >= history.events.length - 1) setCursor(0)
                      setPlaying(true)
                    }}
                  >
                    {playing()
                      ? "Pause"
                      : cursor() >= history.events.length - 1
                        ? history.nextCursor
                          ? "Continue"
                          : "Replay"
                        : "Play"}
                  </button>
                  <StepButton
                    label="Previous event"
                    direction="back"
                    disabled={cursor() === 0 && !history.previousCursor}
                    onClick={() => {
                      if (cursor() === 0 && history.previousCursor) {
                        loadPreviousHistory(true)
                        return
                      }
                      setCursor((value) => Math.max(0, value - 1))
                    }}
                  />
                  <StepButton
                    label="Next event"
                    direction="forward"
                    disabled={cursor() >= history.events.length - 1 && !history.nextCursor}
                    onClick={() => {
                      if (cursor() >= history.events.length - 1 && history.nextCursor) {
                        loadMoreHistory()
                        return
                      }
                      setCursor((value) => Math.min(history.events.length - 1, value + 1))
                    }}
                  />
                  <Show when={history.nextCursor}>
                    <button
                      type="button"
                      class="h-8 rounded-[7px] border border-v2-border-border-base px-2 text-[10px] text-v2-text-text-muted outline-none hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base disabled:opacity-40"
                      disabled={history.loading}
                      onClick={() => loadMoreHistory()}
                    >
                      Load next {PAGE_SIZE}
                    </button>
                  </Show>
                  <Show when={history.previousCursor}>
                    <button
                      type="button"
                      class="h-8 rounded-[7px] border border-v2-border-border-base px-2 text-[10px] text-v2-text-text-muted outline-none hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base disabled:opacity-40"
                      disabled={history.loading}
                      onClick={() => loadPreviousHistory()}
                    >
                      Load previous {PAGE_SIZE}
                    </button>
                  </Show>
                  <select
                    aria-label="Replay speed"
                    value={speed()}
                    class="h-8 rounded-[7px] border border-v2-border-border-base bg-v2-background-bg-base px-2 text-[11px] outline-none focus:border-v2-border-border-focus"
                    onChange={(event) => setSpeed(Number(event.currentTarget.value))}
                  >
                    <option value="0.5">0.5x</option>
                    <option value="1">1x</option>
                    <option value="2">2x</option>
                    <option value="8">8x</option>
                  </select>
                  <input
                    aria-label="Replay position"
                    type="range"
                    min="0"
                    max={Math.max(0, history.events.length - 1)}
                    value={cursor()}
                    class="min-w-36 flex-1 accent-v2-text-text-accent"
                    onInput={(event) => {
                      setPlaying(false)
                      setCursor(Number(event.currentTarget.value))
                    }}
                  />
                  <span class="w-24 text-right font-mono text-[10px] text-v2-text-text-muted">
                    {history.events.length === 0 ? "0 / 0" : `${cursor() + 1} / ${history.events.length}`}
                  </span>
                </div>

                <Show when={history.error}>
                  <div class="border-b border-v2-state-border-danger bg-v2-state-bg-danger px-5 py-2 text-[12px] text-v2-state-fg-danger">
                    {history.error}
                  </div>
                </Show>

                <div class="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(260px,0.8fr)_minmax(320px,1.2fr)] xl:grid-cols-[minmax(320px,0.8fr)_minmax(380px,1.2fr)] xl:grid-rows-1">
                  <ReplayTimeline
                    events={() => history.events}
                    cursor={cursor}
                    onSelect={(index) => {
                      setPlaying(false)
                      setCursor(index)
                    }}
                  />
                  <ReplayInspector event={current} stats={stats} session={session} />
                </div>
              </>
            )}
          </Show>
        </section>
      </div>
    </main>
  )
}

function QueryChip(props: { value: string; onSelect: (value: string) => void }) {
  return (
    <button
      type="button"
      class="rounded-full border border-v2-border-border-subtle px-2 py-1 font-mono text-[9px] text-v2-text-text-muted outline-none hover:border-v2-border-border-base hover:text-v2-text-text-base focus-visible:border-v2-border-border-focus"
      onClick={() => props.onSelect(props.value)}
    >
      {props.value}
    </button>
  )
}

function SearchResult(props: { entry: SessionReplayEntry; selected: () => boolean; onSelect: () => void }) {
  const timestamp = () => {
    if (props.entry.event) return props.entry.event.timestamp
    const updated = props.entry.session.time.updated
    return typeof updated === "number" ? updated : Date.parse(updated)
  }
  return (
    <button
      type="button"
      class="mb-1 w-full rounded-[8px] border px-3 py-2.5 text-left outline-none transition-colors"
      classList={{
        "border-v2-border-border-focus bg-v2-background-bg-layer-02": props.selected(),
        "border-transparent hover:border-v2-border-border-subtle hover:bg-v2-overlay-simple-overlay-hover":
          !props.selected(),
      }}
      onClick={props.onSelect}
    >
      <div class="flex items-center justify-between gap-2">
        <span class="truncate text-[12px] [font-weight:570]">{props.entry.session.title}</span>
        <span class="shrink-0 font-mono text-[9px] text-v2-text-text-faint">
          {Number.isNaN(timestamp()) ? "" : time.format(timestamp())}
        </span>
      </div>
      <Show
        when={props.entry.event}
        fallback={
          <p class="mt-1 truncate text-[10px] text-v2-text-text-muted">{props.entry.session.location.directory}</p>
        }
      >
        {(event) => (
          <>
            <div class="mt-1 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.08em] text-v2-text-text-accent">
              <span>#{event().seq}</span>
              <span>{event().type.replace(/^session\.next\./, "")}</span>
            </div>
            <p class="mt-1 line-clamp-2 text-[10px] leading-4 text-v2-text-text-muted">
              {replayMatchPreview(event().preview)}
            </p>
          </>
        )}
      </Show>
    </button>
  )
}

function StepButton(props: { label: string; direction: "back" | "forward"; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      disabled={props.disabled}
      class="flex size-8 items-center justify-center rounded-[7px] border border-v2-border-border-base text-v2-icon-icon-muted outline-none hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-icon-icon-base disabled:opacity-30 focus-visible:border-v2-border-border-focus"
      onClick={props.onClick}
    >
      <IconV2 name="chevron-down" size="small" class={props.direction === "back" ? "rotate-90" : "-rotate-90"} />
    </button>
  )
}

function ReplayTimeline(props: {
  events: () => SessionReplayEvent[]
  cursor: () => number
  onSelect: (index: number) => void
}) {
  let scroller: HTMLDivElement | undefined
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLButtonElement>({
    get count() {
      return props.events().length
    },
    getScrollElement: () => scroller ?? null,
    estimateSize: () => 63,
    overscan: 12,
    get getItemKey() {
      return (index: number) => props.events()[index]?.id ?? index
    },
  })

  createEffect(() => {
    const index = props.cursor()
    if (!props.events()[index]) return
    queueMicrotask(() => virtualizer.scrollToIndex(index, { align: "auto" }))
  })

  return (
    <div class="flex min-h-0 flex-col border-b border-v2-border-border-subtle xl:border-b-0 xl:border-r">
      <div class="flex h-9 shrink-0 items-center justify-between border-b border-v2-border-border-subtle px-4 text-[10px] uppercase tracking-[0.12em] text-v2-text-text-muted">
        <span>Durable timeline</span>
        <span>Aggregate / sequence</span>
      </div>
      <div ref={scroller} class="min-h-0 flex-1 overflow-y-auto">
        <div class="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          <For each={virtualizer.getVirtualItems()}>
            {(item) => {
              const event = () => props.events()[item.index]!
              const tone = () => replayEventTone(event())
              return (
                <button
                  type="button"
                  data-index={item.index}
                  ref={(element) => virtualizer.measureElement(element)}
                  class="absolute left-0 top-0 flex w-full items-start gap-3 border-b border-v2-border-border-subtle px-4 py-2.5 text-left outline-none hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover"
                  classList={{ "bg-v2-background-bg-layer-02": props.cursor() === item.index }}
                  style={{ transform: `translateY(${item.start}px)` }}
                  onClick={() => props.onSelect(item.index)}
                >
                  <span
                    class="mt-1 size-2 shrink-0 rounded-full"
                    classList={{
                      "bg-v2-state-fg-danger": tone() === "danger",
                      "bg-v2-text-text-accent": tone() === "tool",
                      "bg-v2-state-fg-success": tone() === "message",
                      "bg-v2-icon-icon-base": tone() === "step",
                      "bg-v2-icon-icon-faint": tone() === "neutral",
                    }}
                  />
                  <span class="min-w-0 flex-1">
                    <span class="flex items-center justify-between gap-2">
                      <span class="truncate font-mono text-[10px] text-v2-text-text-base">
                        {replayEventLabel(event())}
                      </span>
                      <span class="shrink-0 font-mono text-[9px] text-v2-text-text-faint">
                        {event().durable.aggregateID.startsWith("ses_")
                          ? "session"
                          : event().durable.aggregateID.slice(0, 12)}
                        /{replayEventSequence(event())}
                      </span>
                    </span>
                    <span class="mt-1 block truncate text-[10px] text-v2-text-text-muted">
                      {replayEventPreview(event())}
                    </span>
                  </span>
                </button>
              )
            }}
          </For>
        </div>
      </div>
    </div>
  )
}

function ReplayInspector(props: {
  event: () => SessionReplayEvent | undefined
  stats: () => ReturnType<typeof replayStats>
  session: () => SessionReplayEntry["session"]
}) {
  return (
    <div class="flex min-h-0 flex-col bg-v2-background-bg-base">
      <div class="grid shrink-0 grid-cols-4 border-b border-v2-border-border-subtle bg-v2-background-bg-layer-01">
        <InspectorStat label="Events" value={props.stats().events} />
        <InspectorStat label="Turns" value={props.stats().turns} />
        <InspectorStat label="Tools" value={props.stats().tools} />
        <InspectorStat label="Failures" value={props.stats().failures} danger={props.stats().failures > 0} />
      </div>
      <Show
        when={props.event()}
        fallback={
          <div class="flex flex-1 items-center justify-center text-[12px] text-v2-text-text-muted">
            No durable events.
          </div>
        }
      >
        {(event) => (
          <>
            <div class="grid shrink-0 grid-cols-2 gap-x-6 gap-y-3 border-b border-v2-border-border-subtle px-5 py-4 text-[11px] sm:grid-cols-5">
              <InspectorField label="Aggregate" value={event().durable.aggregateID} mono />
              <InspectorField label="Sequence" value={`#${replayEventSequence(event())}`} mono />
              <InspectorField label="Event ID" value={event().id} mono />
              <InspectorField label="Recorded" value={formatTimestamp(replayEventTimestamp(event()))} />
              <InspectorField label="Version" value={String(event().durable.version)} mono />
            </div>
            <div class="min-h-0 flex-1 overflow-auto px-5 py-4">
              <div class="flex items-center justify-between gap-3">
                <div>
                  <p class="text-[10px] uppercase tracking-[0.12em] text-v2-text-text-muted">Selected event</p>
                  <h3 class="mt-1 font-mono text-[13px] text-v2-text-text-accent">{event().type}</h3>
                </div>
                <span class="rounded-full border border-v2-border-border-subtle px-2 py-1 font-mono text-[9px] text-v2-text-text-muted">
                  durable
                </span>
              </div>
              <pre class="mt-4 min-w-full whitespace-pre-wrap break-words border border-v2-border-border-subtle bg-v2-background-bg-deep p-4 font-mono text-[11px] leading-5 text-v2-text-text-base">
                {JSON.stringify(event(), null, 2)}
              </pre>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}

function InspectorStat(props: { label: string; value: number; danger?: boolean }) {
  return (
    <div class="border-r border-v2-border-border-subtle px-3 py-3 last:border-r-0">
      <p class="text-[9px] uppercase tracking-[0.1em] text-v2-text-text-muted">{props.label}</p>
      <p class="mt-1 font-mono text-[16px] [font-weight:600]" classList={{ "text-v2-state-fg-danger": props.danger }}>
        {props.value}
      </p>
    </div>
  )
}

function InspectorField(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div class="min-w-0">
      <p class="text-[9px] uppercase tracking-[0.1em] text-v2-text-text-muted">{props.label}</p>
      <p class="mt-1 truncate text-v2-text-text-base" classList={{ "font-mono": props.mono }}>
        {props.value}
      </p>
    </div>
  )
}

function formatTimestamp(value: number) {
  return value > 0 ? time.format(value) : "Unknown"
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string")
    return error.message
  return "Replay request failed"
}
